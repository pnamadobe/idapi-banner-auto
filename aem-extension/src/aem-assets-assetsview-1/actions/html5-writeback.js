/*
 * Writeback endpoint for the banner-ads packaging workflow. The workflow runs in a public repo and
 * never holds an AEM token: it presents a short-lived HMAC token bound to one package run, and may
 * only (a) read the backup JPGs of its ads and (b) upload the three expected files per ad into
 * <output>/html5/cm360. Ops: backup, initiate, complete, done.
 */
const stateLib = require('@adobe/aio-lib-state')
const { Core } = require('@adobe/aio-sdk')
const { errorResponse } = require('./utils')
const { aemContext, aemDownload, ensureFolder, verifyAemAsset } = require('./generate-idapi-banners/engine')
const { assetId, applyPlan } = require('./generate-idapi-banners/relations')
const { attachPreview } = require('./generate-idapi-banners/renditions')
const pkg = require('./generate-idapi-banners/package')

const TTL = 7 * 24 * 3600
const MAX_BYTES = 50 * 1024 * 1024
const enc = (p) => p.split('/').map(encodeURIComponent).join('/')
const aemText = async (res) => JSON.parse((await res.text()).replace(/^\)\]\}'?/, ''))

class Bad extends Error { constructor (status, msg) { super(msg); this.status = status } }

function adAt (rec, i) {
  if (!Number.isInteger(i) || i < 0 || i >= rec.ads.length) throw new Bad(400, 'ad out of range')
  return rec.ads[i]
}

// The files must be exactly the expected set for the ad, with the right types and sane sizes.
function checkFiles (ad, files, { needToken } = {}) {
  if (!Array.isArray(files)) throw new Bad(400, 'files must be an array')
  const want = pkg.expectedNames(ad)
  const names = files.map((f) => f && f.name)
  if (names.length !== want.length || !want.every((n) => names.includes(n))) throw new Bad(400, `files must be exactly ${want.join(', ')}`)
  for (const f of files) {
    const mime = pkg.mimeFor(f.name)
    if ((f.mime || f.mimeType) !== mime) throw new Bad(400, `${f.name}: type must be ${mime}`)
    if (!Number.isInteger(f.size) || f.size <= 0 || f.size > MAX_BYTES) throw new Bad(400, `${f.name}: bad size`)
    if (needToken && (typeof f.uploadToken !== 'string' || !f.uploadToken)) throw new Bad(400, `${f.name}: missing uploadToken`)
  }
}

async function initiateOne (author, token, folder, f) {
  const go = () => fetch(`${author}${enc(folder)}.initiateUpload.json`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ fileName: f.name, fileSize: String(f.size) })
  })
  let res = await go()
  if (res.status === 404) { await ensureFolder(author, token, folder); res = await go() }
  if (!res.ok) throw new Error(`initiateUpload ${f.name} -> ${res.status}`)
  const out = (await aemText(res)).files?.[0]
  if (!out || !out.uploadURIs?.length) throw new Error(`initiateUpload ${f.name}: no upload URI`)
  return { name: f.name, mimeType: pkg.mimeFor(f.name), uploadToken: out.uploadToken, uploadURIs: out.uploadURIs, minPartSize: out.minPartSize, maxPartSize: out.maxPartSize }
}

async function completeOne (author, token, folder, f) {
  const res = await fetch(`${author}${enc(folder)}.completeUpload.json`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ fileName: f.name, mimeType: pkg.mimeFor(f.name), uploadToken: f.uploadToken, fileSize: String(f.size) })
  })
  if (!res.ok) throw new Error(`completeUpload ${f.name} -> ${res.status}`)
  await verifyAemAsset(author, token, `${folder}/${f.name}`)
}

async function setMetadata (author, token, damPath, properties) {
  if (!Object.keys(properties).length) return
  const res = await fetch(`${author}/api/assets${enc(damPath.replace(/^\/content\/dam/, ''))}`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ class: 'asset', properties })
  })
  if (!res.ok) throw new Error(`metadata ${damPath} -> ${res.status}`)
}

// Uploads are done; link the zip to its template, previews and backup, and give it a thumbnail.
async function finishAd (ctx, ad, report) {
  const { author, aemToken, rec, claims } = ctx
  const warnings = []
  const zipPath = `${ctx.dest}/${ad.name}.zip`
  const [, gif, story] = pkg.expectedNames(ad)
  const others = [`${ctx.dest}/${gif}`, `${ctx.dest}/${story}`]
  if (ad.backup) others.push(`${rec.jobOutput}/${ad.backup}`)
  const id = async (p) => { try { return await assetId(author, aemToken, p) } catch (e) { warnings.push(e.message); return null } }
  const tplPath = claims.template && ctx.jobFolder ? `${ctx.jobFolder}/${claims.template}` : null

  const [, zipId, otherIds, tplId] = await Promise.all([
    setMetadata(author, aemToken, zipPath, pkg.zipMetadata(report, ad, claims.template)).catch((e) => { warnings.push(e.message) }),
    id(zipPath),
    Promise.all(others.map(id)),
    tplPath ? id(tplPath) : Promise.resolve(null)
  ])
  if (!zipId) return warnings
  const plan = []
  const items = []
  for (const o of otherIds) {
    if (o) {
      items.push({ assetId: o, relationType: 'other' })
      plan.push({ onId: o, items: [{ assetId: zipId, relationType: 'other' }] })
    }
  }
  if (items.length) plan.unshift({ onId: zipId, items })
  if (tplId) plan.push({ onId: tplId, items: [{ assetId: zipId, relationType: 'derived' }] })
  await Promise.all([
    applyPlan(author, aemToken, plan).then((r) => warnings.push(...(r.warnings || []).map(String))).catch((e) => warnings.push(e.message)),
    (async () => {
      try {
        const thumb = await aemDownload(author, aemToken, ad.backup ? `${rec.jobOutput}/${ad.backup}` : `${ctx.dest}/${story}`)
        warnings.push(...((await attachPreview(author, aemToken, zipId, thumb)).warnings || []).map(String))
      } catch (e) { warnings.push(`preview: ${e.message}`) }
    })()
  ])
  return warnings
}

async function main (params) {
  const logger = Core.Logger('html5-writeback', { level: params.LOG_LEVEL || 'info' })
  try {
    if ((params.__ow_method || 'post').toLowerCase() !== 'post') return errorResponse(405, 'POST only', logger)
    let claims
    try { claims = pkg.verifyToken(params.HTML5_WRITEBACK_SECRET, params.token) } catch (e) {
      if (/not configured/.test(e.message)) throw e
      return errorResponse(401, e.message, logger)
    }
    const state = await stateLib.init()
    const pkgKey = `idapi-pkg-${claims.job}`
    const raw = await state.get(pkgKey)
    const rec = raw && JSON.parse(raw.value)
    if (!rec || rec.run !== claims.run || rec.outFolder !== claims.outFolder) return errorResponse(401, 'token does not match the current package run', logger)
    if (rec.status !== 'running') return errorResponse(409, `package run is ${rec.status}`, logger)
    const jobRaw = await state.get(`idapi-job-${claims.job}`)
    const job = jobRaw ? JSON.parse(jobRaw.value) : {}
    // Never the caller's headers: the workflow has no AEM identity, the action uses its own credential.
    const { author, aemToken } = await aemContext({ ...params, __ow_headers: undefined, aemAuthorUrl: job.aemAuthorUrl || params.aemAuthorUrl })
    rec.jobOutput = rec.jobOutput || job.outputFolder || rec.outFolder
    const ctx = { author, aemToken, rec, claims, dest: `${rec.outFolder}/html5/cm360`, jobFolder: job.folder }
    const save = async () => { rec.updatedAt = new Date().toISOString(); await state.put(pkgKey, JSON.stringify(rec), { ttl: TTL }) }

    switch (params.op) {
      case 'backup': {
        const file = String(params.file || '')
        if (!pkg.safeName(file) || !rec.ads.some((a) => a.backup === file)) return errorResponse(403, 'not a backup image of this run', logger)
        return { statusCode: 200, body: { data: (await aemDownload(author, aemToken, `${rec.jobOutput}/${file}`)).toString('base64') } }
      }
      case 'initiate': {
        const ad = adAt(rec, params.ad)
        checkFiles(ad, params.files)
        const first = await initiateOne(author, aemToken, ctx.dest, params.files[0])
        const rest = await Promise.all(params.files.slice(1).map((f) => initiateOne(author, aemToken, ctx.dest, f)))
        return { statusCode: 200, body: { files: [first, ...rest] } }
      }
      case 'complete': {
        const ad = adAt(rec, params.ad)
        const report = params.report && typeof params.report === 'object' ? params.report : {}
        if (Array.isArray(params.files) && params.files.length === 0) {
          const err = report.error || {}
          rec.results[params.ad] = { name: ad.name, ok: false, error: { code: String(err.code || 'PACKAGE_FAILED').slice(0, 64), message: String(err.message || 'packaging failed').slice(0, 500) } }
          await save()
          return { statusCode: 200, body: { ok: false } }
        }
        checkFiles(ad, params.files, { needToken: true })
        await Promise.all(params.files.map((f) => completeOne(author, aemToken, ctx.dest, f)))
        const warnings = await finishAd(ctx, ad, report)
        const fid = report.fidelity || {}
        rec.results[params.ad] = {
          name: ad.name,
          ok: true,
          zip: `${ctx.dest}/${ad.name}.zip`,
          bytes: report.bytes,
          overBudget: !!report.over,
          fidelity: fid.verdict,
          ...(warnings.length ? { warnings: warnings.slice(0, 20) } : {})
        }
        await save()
        return { statusCode: 200, body: { ok: true, warnings } }
      }
      case 'done': {
        rec.status = 'done'
        rec.failed = Number.isInteger(params.failed) ? params.failed : Object.values(rec.results).filter((r) => !r.ok).length
        rec.finishedAt = new Date().toISOString()
        await save()
        logger.info(`package ${claims.job}: done, ${Object.keys(rec.results).length}/${rec.ads.length} reported, ${rec.failed} failed`)
        return { statusCode: 200, body: { ok: true } }
      }
      default:
        return errorResponse(400, 'unknown op', logger)
    }
  } catch (e) {
    if (e instanceof Bad) return errorResponse(e.status, e.message, logger)
    logger.error(e)
    return errorResponse(500, e.message, logger)
  }
}

module.exports = { main, checkFiles }
