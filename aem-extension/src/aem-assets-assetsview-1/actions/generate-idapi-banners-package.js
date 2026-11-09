/*
 * "Package for CM360" button. Rebuilds the job's HTML5 ad list (html5 sizes x variation rows),
 * records a package run in state, mints a writeback token for it and dispatches the banner-ads
 * packaging workflow. The workflow posts its outputs back through html5-writeback.
 */
const crypto = require('crypto')
const stateLib = require('@adobe/aio-lib-state')
const { Core } = require('@adobe/aio-sdk')
const { errorResponse, userBearer, stringParameters } = require('./utils')
const { aemContext, aemDownload, aemListSafe, jobManifestName, html5SiteFor, hasFolderAccess } = require('./generate-idapi-banners/engine')
const { classify } = require('./generate-idapi-banners/classify')
const pkg = require('./generate-idapi-banners/package')
const { outputUrl, isDamFolder } = require('./job-utils')

const TTL = 7 * 24 * 3600
const MAX_ADS = 200 // keeps the dispatch payload well under GitHub's client_payload limit
// A running package with no writeback for this long is dead (cancelled or crashed job): each ad
// reports within a few minutes, so the modal offers a re-package and a new run may replace it.
const STALE_MS = 15 * 60 * 1000
const isStale = (p) => p.status === 'running' && Date.now() - Date.parse(p.updatedAt || p.createdAt) >= STALE_MS
const list = (v) => (v == null || v === '' ? undefined : (Array.isArray(v) ? v : String(v).split(',')).map((s) => String(s).trim()).filter(Boolean))

function writebackUrl (params) {
  if (params.HTML5_WRITEBACK_URL) return String(params.HTML5_WRITEBACK_URL)
  const ns = process.env.__OW_NAMESPACE
  if (!ns) throw new Error('Runtime namespace is unavailable')
  return `https://${ns}.adobeioruntime.net/api/v1/web/aem-assets-assetsview-1/html5-writeback`
}

async function main (params) {
  const logger = Core.Logger('package', { level: params.LOG_LEVEL || 'info' })
  try {
    logger.debug(stringParameters(params))
    const userToken = userBearer(params)
    if (!userToken) return errorResponse(401, 'missing Authorization bearer token', logger)
    if (!params.folder && !params.jobId) return errorResponse(400, 'folder or jobId is required', logger)
    if (params.folder && !isDamFolder(params.folder)) return errorResponse(400, 'folder must be a /content/dam/... path', logger)
    const jobIdParam = String(params.jobId || '')
    if (jobIdParam && !/^[a-f0-9]{48}$/.test(jobIdParam)) return errorResponse(400, 'invalid jobId', logger)

    const { author, aemToken } = await aemContext(params)
    let jobId = jobIdParam
    if (!jobId) {
      if (typeof hasFolderAccess === 'function' && !(await hasFolderAccess({ ...params, aemAuthorUrl: author }, userToken, params.folder))) {
        return errorResponse(403, 'you do not have access to this job folder', logger)
      }
      try {
        jobId = JSON.parse((await aemDownload(author, aemToken, `${params.folder}/output/${jobManifestName}`)).toString('utf8')).jobId
      } catch (e) { return errorResponse(404, `job manifest not found for ${params.folder}`, logger) }
    }
    const state = await stateLib.init()
    const rec = await state.get(`idapi-job-${jobId}`)
    if (!rec) return errorResponse(404, 'job not found', logger)
    const job = JSON.parse(rec.value)
    if (job.status !== 'completed') return errorResponse(409, `job is ${job.status}; package it once it has completed`, logger)
    const jobAuthor = job.aemAuthorUrl || author

    // The caller must be able to read the job folder with their own token.
    if (!(await hasFolderAccess({ ...params, aemAuthorUrl: jobAuthor }, userToken, job.folder))) {
      return errorResponse(403, 'you do not have access to this job folder', logger)
    }

    const pkgKey = `idapi-pkg-${jobId}`
    const prev = await state.get(pkgKey)
    // Read-only status (the modal polls this): never dispatches.
    if (/^(1|true|yes)$/i.test(String(params.status || ''))) {
      if (!prev) return { statusCode: 200, body: { jobId, status: 'none' } }
      const p = JSON.parse(prev.value)
      const results = p.results || {}
      const failed = Object.values(results).filter((r) => r && r.ok === false).length
      const output = `${p.outFolder}/html5/cm360`
      return {
        statusCode: 200,
        body: { jobId, status: isStale(p) ? 'stalled' : p.status, ads: (p.ads || []).length, done: Object.keys(results).length, failed, error: p.error, output, outputUrl: outputUrl({ ...job, outputFolder: output }, params), updatedAt: p.updatedAt }
      }
    }
    if (prev) {
      const p = JSON.parse(prev.value)
      const force = /^(1|true|yes)$/i.test(String(params.force || ''))
      if (p.status === 'running' && !isStale(p) && !force) {
        return { statusCode: 202, body: { jobId, status: p.status, ads: p.ads.length, done: Object.keys(p.results || {}).length } }
      }
    }

    const entries = await aemListSafe(jobAuthor, aemToken, job.folder)
    const c = classify(entries, job.template)
    if (!c.pagemap || !c.variations) return errorResponse(422, 'the job folder has no pagemap or variations CSV', logger)
    // The site comes from the campaign folder's html5.json, as for the HTML5 run itself.
    let cfg
    try {
      cfg = await html5SiteFor(jobAuthor, aemToken, job.folder)
    } catch (e) {
      if (e.code === 'HTML5_NO_SITE') return errorResponse(422, e.message, logger)
      throw e
    }
    const ads = pkg.buildAds({
      pagemapText: (await aemDownload(jobAuthor, aemToken, `${job.folder}/${c.pagemap.name}`)).toString('utf8'),
      csvText: (await aemDownload(jobAuthor, aemToken, `${job.folder}/${c.variations.name}`)).toString('utf8'),
      outputs: job.outputs || [],
      cfg,
      campaign: job.folder.split('/').pop(),
      template: c.template ? c.template.name : job.template,
      pages: list(params.pages),
      rows: list(params.rows)
    })
    if (!ads.length) return errorResponse(422, 'no HTML5 ads to package (no pagemap row has html5 = yes, or the filter matched nothing)', logger)
    if (ads.length > MAX_ADS) return errorResponse(422, `${ads.length} ads is over the ${MAX_ADS} per run limit; narrow it with pages or rows`, logger)

    const outFolder = job.outputFolder || `${job.folder}/output`
    const run = crypto.randomBytes(12).toString('hex')
    const now = new Date().toISOString()
    await state.put(pkgKey, JSON.stringify({ jobId, run, outFolder, ads, results: {}, status: 'running', createdAt: now, updatedAt: now }), { ttl: TTL })
    const token = pkg.mintToken(params.HTML5_WRITEBACK_SECRET, { job: jobId, run, outFolder, template: job.template })
    const repo = cfg.repo
    try {
      await pkg.dispatch(repo, params.GITHUB_DISPATCH_TOKEN, { job: jobId, origin: cfg.previewOrigin, ads, writeback: { url: writebackUrl(params), token } })
    } catch (e) {
      await state.put(pkgKey, JSON.stringify({ jobId, run, outFolder, ads, results: {}, status: 'failed', error: e.message, createdAt: now, updatedAt: new Date().toISOString() }), { ttl: TTL })
      return errorResponse(502, `could not start packaging: ${e.message}`, logger)
    }
    logger.info(`package ${jobId}: dispatched ${ads.length} ad(s) to ${repo}`)
    return { statusCode: 202, body: { jobId, status: 'running', ads: ads.length, output: `${outFolder}/html5/cm360`, outputUrl: outputUrl({ ...job, outputFolder: `${outFolder}/html5/cm360` }, params) } }
  } catch (e) {
    logger.error(e)
    return errorResponse(500, e.message, logger)
  }
}

exports.main = main
