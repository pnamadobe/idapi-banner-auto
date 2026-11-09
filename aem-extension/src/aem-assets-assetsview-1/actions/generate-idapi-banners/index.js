/*
 * Durable orchestration entry point. The renderer itself lives in engine.js;
 * this action only creates/reuses a state record and queues a worker.
 */
const stateLib = require('@adobe/aio-lib-state')
const { Core } = require('@adobe/aio-sdk')
const { errorResponse, stringParameters, checkMissingRequestInputs, userBearer } = require('../utils')
const { keyFor, publicJob: baseJob, outputUrl, isTemplateName, isDamFolder, outputMode } = require('../job-utils')
const { inspectInputs, resolveOutputFolder, aemContext, hasFolderAccess, html5SiteFor } = require('./engine')
const { summarize, MAX_STORED_FINDINGS } = require('./preflight')
const { campaignPaths } = require('./html5')
const { saveSite } = require('./site')

const ttl = 7 * 24 * 3600

async function invoke (action, payload) {
  const namespace = process.env.__OW_NAMESPACE
  const host = process.env.__OW_API_HOST || `https://${namespace}.adobeioruntime.net`
  if (!namespace || !process.env.__OW_API_KEY) throw new Error('Runtime invocation credentials are unavailable')
  const response = await fetch(`${host}/api/v1/namespaces/${encodeURIComponent(namespace)}/actions/aem-assets-assetsview-1/${action}?blocking=false`, {
    method: 'POST',
    headers: { Authorization: `Basic ${Buffer.from(process.env.__OW_API_KEY).toString('base64')}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  })
  if (!response.ok) throw new Error(`queue ${action} -> ${response.status}`)
}

async function main (params) {
  const publicJob = (job) => ({ ...baseJob(job), outputUrl: outputUrl(job, params) })
  const logger = Core.Logger('main', { level: params.LOG_LEVEL || 'info' })
  try {
    logger.debug(stringParameters(params))
    const { editable: writeIndd, images: writeImages, html5: writeHtml5 } = outputMode(params)
    const callerToken = userBearer(params)
    if (!callerToken) {
      if (String(params.saveSite || '') === '1') return errorResponse(401, 'sign in again: the site is checked and saved as you', logger)
      return errorResponse(401, writeHtml5 ? 'HTML5 banners are written to Document Authoring as you: sign in again and retry' : 'Sign in again and retry: missing Authorization bearer token', logger)
    }
    const missing = checkMissingRequestInputs(params, ['folder'], [])
    if (missing) return errorResponse(400, missing, logger)
    if (!isDamFolder(params.folder)) return errorResponse(400, 'folder must be a /content/dam/... path', logger)
    // The dialog's site picker: check the DA site as the signed-in user, then save it in html5.json.
    if (String(params.saveSite || '') === '1') {
      try {
        const { author } = await aemContext(params)
        const saved = await saveSite({ author, userToken: callerToken, folder: params.folder, target: params.target, org: params.org, site: params.site })
        return { statusCode: 200, body: saved }
      } catch (e) {
        return errorResponse(e.status || 500, e.message, logger)
      }
    }
    if (!params.AEM_SC_JSON && !params.AEM_DEV_TOKEN) return errorResponse(500, 'AEM_SC_JSON or AEM_DEV_TOKEN must be configured for durable jobs', logger)
    const template = String(params.template || '').trim()
    if (template && !isTemplateName(template)) return errorResponse(400, 'template must be the file name of an .indd or .psd in the folder', logger)
    if (typeof hasFolderAccess === 'function' && !(await hasFolderAccess(params, callerToken, params.folder))) {
      return errorResponse(403, 'you do not have access to this job folder', logger)
    }
    // The estimate also says where HTML5 pages would go (html5Site / html5Path, from the folder's
    // html5.json) or why HTML5 can't run in this folder (html5SiteError).
    if (String(params.preflight || '') === '1') return { statusCode: 200, body: await inspectInputs({ ...params, template }) }
    // Preflight gate: errors stop the start (HTTP 422) unless preflightOverride=1. Not run for a job that
    // is already queued or running (that request only reports it). An inspection that itself fails
    // (e.g. AEM unreachable) does not block; the worker reports such failures on the job.
    const override = /^(1|true|yes)$/i.test(String(params.preflightOverride || ''))
    let checked = null
    const gate = async () => {
      try {
        checked = await inspectInputs({ ...params, template })
      } catch (e) {
        logger.warn(`preflight could not run: ${e.message}`)
        return null
      }
      if (checked.ok || override) return null
      return { statusCode: 422, body: { error: summarize(checked.findings), findings: checked.findings } }
    }
    // Findings kept on the job: shown by the status action, and the worker's stage-2 gate honours the override.
    const stamp = (job) => {
      job.preflightOverride = override
      delete job.findings
      if (checked) job.findings = checked.findings.slice(0, MAX_STORED_FINDINGS)
    }
    const state = await stateLib.init()
    if (writeHtml5 && /\.psd$/i.test(template)) return errorResponse(400, 'HTML5 banners need an InDesign template for now', logger)
    // HTML5 pages are written to Document Authoring as the signed-in user (DA does not accept the
    // render service's token). The token is handed to the worker in the invocation only: it is never
    // stored on the job, in state or in AEM. DA_TOKEN, when configured on the worker, overrides it.
    const daUserToken = writeHtml5 ? callerToken : undefined
    // Each campaign folder names its own EDS / DA site in html5.json: there is no shared default, so
    // an HTML5 run in a folder without one is refused before anything renders.
    let site = null
    if (writeHtml5) {
      try {
        const { author, aemToken } = await aemContext(params)
        site = await html5SiteFor(author, aemToken, params.folder)
      } catch (e) {
        if (e.code === 'HTML5_NO_SITE') return errorResponse(422, e.message, logger)
        logger.warn(`html5.json could not be read: ${e.message}`) // the worker reports it on the job
      }
    }
    // Where an HTML5 job's DA pages go, so the modal can link the DA folder as soon as the job starts.
    const html5Folder = (tpl) => {
      if (!site) return undefined
      const base = campaignPaths(site, params.folder.split('/').pop(), tpl).base
      return { site: `${site.org}/${site.site}`, path: base, daUrl: `https://da.live/#/${site.org}/${site.site}${base}` }
    }
    const queue = (jobId) => invoke('generate-idapi-banners-worker', { jobId, ...(daUserToken ? { daUserToken } : {}) })
    // Re-queue an existing job with a fresh queue time. A stale queuedAt (left by an earlier run) makes
    // the status poller treat the job as stuck on its first poll and wake a second worker, which has no
    // user token and could take the job before the invocation queued here.
    const requeue = (job) => {
      job.status = 'queued'
      job.queuedAt = job.retriedAt = new Date().toISOString()
      delete job.recoveryAt
      delete job.recoveryError
    }
    const stateKey = keyFor(params.folder, writeIndd, template, writeIndd && !writeImages, writeHtml5)
    const existing = await state.get(stateKey)
    if (existing) {
      const job = JSON.parse(existing.value)
      // A worker killed mid-run (e.g. out of memory) leaves the job 'running' with its lock held
      // until the 15-minute lock TTL; once that has passed, treat it as stale and requeue.
      // params.force=1 (operator escape hatch) also drops the worker lock and restarts a running job.
      const forced = job.status === 'running' && /^(1|true|yes)$/i.test(String(params.force || ''))
      const stale = forced || (job.status === 'running' && Date.now() - Date.parse(job.updatedAt || job.createdAt || '') > 16 * 60 * 1000)
      if (!stale && (job.status === 'queued' || job.status === 'running')) return { statusCode: 202, body: publicJob(job) }
      const blocked = await gate()
      if (blocked) return blocked
      stamp(job)
      job.writeImages = writeImages // jobs saved before HTML5 runs dropped the flattened images
      if (writeHtml5) job.html5Folder = html5Folder((checked && checked.template) || job.template)
      if (stale) {
        if (forced) await state.delete(`${stateKey}-lock`)
        requeue(job)
        await state.put(stateKey, JSON.stringify(job), { ttl, ifExists: true })
        await queue(job.jobId)
        return { statusCode: 202, body: publicJob(job) }
      }
      if (job.status === 'completed') {
        requeue(job)
        job.rowOffset = 0
        job.outputs = []
        delete job.html5
        await state.delete(`${stateKey}-delivery`)
        job.outputFolder = await resolveOutputFolder({ ...params, aemAuthorUrl: job.aemAuthorUrl || params.aemAuthorUrl })
        delete job.error
        await state.put(stateKey, JSON.stringify(job), { ttl, ifExists: true })
        await queue(job.jobId)
        return { statusCode: 202, body: publicJob(job) }
      }
      if (job.status === 'failed') {
        requeue(job)
        delete job.error
        delete job.html5
        await state.delete(`${stateKey}-delivery`)
        await state.put(stateKey, JSON.stringify(job), { ttl, ifExists: true })
        await queue(job.jobId)
        return { statusCode: 202, body: publicJob(job) }
      }
    }
    const blocked = await gate()
    if (blocked) return blocked
    const job = {
      stateKey,
      jobId: stateKey.slice('idapi-job-'.length),
      folder: params.folder,
      template,
      aemAuthorUrl: params.aemAuthorUrl || '',
      writeIndd,
      writeImages,
      writeHtml5,
      ...(writeHtml5 ? { html5Folder: html5Folder((checked && checked.template) || template) } : {}),
      batchSize: Math.max(1, Math.min(10, Number(params.batchSize) || 2)),
      outputFolder: await resolveOutputFolder(params),
      rowOffset: 0,
      outputs: [],
      status: 'queued',
      createdAt: new Date().toISOString()
    }
    stamp(job)
    await state.put(stateKey, JSON.stringify(job), { ttl, ifNotExists: true })
    const winner = await state.get(stateKey)
    const persisted = JSON.parse(winner.value)
    if (persisted.status === 'queued') {
      await queue(persisted.jobId)
    }
    return { statusCode: 202, body: publicJob(persisted) }
  } catch (error) {
    logger.error(error)
    return errorResponse(500, `job start failed: ${error.message}`, logger)
  }
}

exports.main = main
exports.publicJob = baseJob
exports.keyFor = keyFor
