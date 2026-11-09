const stateLib = require('@adobe/aio-lib-state')
const { processBatch, aemContext, writeJobManifest, finalizeRelations } = require('./generate-idapi-banners/engine')
const { errorResponse } = require('./utils')

// The manifest is a convenience record in AEM; the job state in aio-lib-state is authoritative.
// Back-to-back writes of the same asset can 409 while AEM is still processing the previous upload,
// so retry briefly and never let a manifest failure fail (or mask the result of) the job.
async function saveManifest (author, token, folder, manifest) {
  for (let attempt = 1; attempt <= 4; attempt++) {
    try { return await writeJobManifest(author, token, folder, manifest) } catch (e) {
      if (attempt === 4) { console.warn(`manifest write failed: ${e.message}`); return undefined }
      await new Promise((resolve) => setTimeout(resolve, 2000 * attempt))
    }
  }
  return undefined
}

// An HTML5 job's first batch writes its DA pages as the signed-in user, whose token only the start
// action's invocation carries. A worker woken without it (the status poller's stale-queue recovery)
// must not take that batch: it would publish nothing. It leaves the job for the invocation with the
// token, and fails it only once that invocation has clearly been lost.
const SIGN_IN_WAIT_MS = 5 * 60 * 1000
const SIGN_IN_LOST = 'Your sign-in did not reach the HTML5 worker: start HTML5 banners again from the Generate Banners dialog'
function needsSignIn (job, params) {
  return Boolean(job.writeHtml5) && !job.rowOffset && job.status === 'queued' && !params.daUserToken && !params.DA_TOKEN
}
function signInLost (job) {
  const queuedAt = Date.parse(job.queuedAt || job.updatedAt || job.createdAt || '')
  return !queuedAt || Date.now() - queuedAt > SIGN_IN_WAIT_MS
}

async function main (params) {
  const state = await stateLib.init()
  let context
  const jobId = String(params.jobId || '')
  if (!/^[a-f0-9]{48}$/.test(jobId)) return errorResponse(400, 'invalid jobId')
  const stateKey = `idapi-job-${jobId}`
  const lockKey = `${stateKey}-lock`
  // Checked before taking the lock, so the invocation with the user's token is not locked out.
  const peek = await state.get(stateKey)
  const waiting = peek && JSON.parse(peek.value)
  if (waiting && needsSignIn(waiting, params) && !signInLost(waiting)) return { statusCode: 202, body: { jobId, status: 'waiting-for-sign-in' } }
  // The previous batch releases its lock just before queueing this one; allow for that to propagate.
  let lock = await state.put(lockKey, String(Date.now()), { ttl: 900, ifNotExists: true })
  for (let i = 0; !lock && i < 4; i++) {
    await new Promise((resolve) => setTimeout(resolve, 3000))
    lock = await state.put(lockKey, String(Date.now()), { ttl: 900, ifNotExists: true })
  }
  if (!lock) return { statusCode: 202, body: { jobId, status: 'already-running' } }
  try {
    const current = await state.get(stateKey)
    if (!current) return errorResponse(404, 'job not found')
    const job = JSON.parse(current.value)
    if (job.status === 'completed') return { statusCode: 200, body: job }
    if (needsSignIn(job, params)) {
      if (!signInLost(job)) return { statusCode: 202, body: { jobId, status: 'waiting-for-sign-in' } }
      job.status = 'failed'
      job.error = SIGN_IN_LOST
      job.updatedAt = new Date().toISOString()
      await state.put(stateKey, JSON.stringify(job), { ttl: 7 * 24 * 3600, ifExists: true })
      return { statusCode: 200, body: job }
    }
    job.status = 'running'
    job.updatedAt = new Date().toISOString()
    await state.put(stateKey, JSON.stringify(job), { ttl: 7 * 24 * 3600, ifExists: true })
    context = await aemContext({ ...params, aemAuthorUrl: job.aemAuthorUrl, folder: job.folder })
    await saveManifest(context.author, context.aemToken, job.folder, { ...job, updatedAt: new Date().toISOString() })
    const result = await processBatch({ ...params, folder: job.folder, template: job.template || '', aemAuthorUrl: job.aemAuthorUrl, writeIndd: job.writeIndd ? '1' : '', skipImages: job.writeImages === false ? '1' : '', writeHtml5: job.writeHtml5 ? '1' : '', animationStyle: job.animationStyle || '', preflightOverride: job.preflightOverride ? '1' : '', maxRows: job.batchSize, rowOffset: job.rowOffset }, job, state)
    if (result && result.error) throw new Error(result.error.body && result.error.body.error ? result.error.body.error : 'batch failed')
    const rows = result.body && result.body.batchRows ? result.body.batchRows : 0
    // HTML5 pages are published by the first batch; keep them for the status action / modal gallery.
    if (result.body && result.body.html5) {
      job.html5 = result.body.html5
    }
    // An HTML5 run that wrote no DA page has produced nothing the user asked for: fail it (with the
    // reason) instead of reporting success. A retry starts over and publishes again.
    if (job.writeHtml5 && job.rowOffset === 0 && !((job.html5 && job.html5.pages) || []).length) {
      job.status = 'failed'
      delete job.phase
      job.error = `No HTML5 pages were published: ${html5Reason(job.html5)}`
      job.updatedAt = new Date().toISOString()
      await state.put(stateKey, JSON.stringify(job), { ttl: 7 * 24 * 3600, ifExists: true })
      await saveManifest(context.author, context.aemToken, job.folder, { ...job, updatedAt: job.updatedAt })
      return { statusCode: 200, body: job }
    }
    job.rowOffset += rows
    if (rows < job.batchSize) {
      job.status = 'completed'
      delete job.phase
      // once everything is uploaded, restore INDD -> PDF relations that AEM's own XMP-based inference replaced
      if (job.writeIndd) {
        try { await finalizeRelations(context.author, context.aemToken, job.outputFolder || `${job.folder}/output`, job.outputs || []) } catch (e) { console.warn(`finalizeRelations: ${e.message}`) }
      }
    } else {
      job.status = 'queued'
      job.queuedAt = new Date().toISOString()
      await state.put(stateKey, JSON.stringify(job), { ttl: 7 * 24 * 3600, ifExists: true })
      // Release the lock first: the next batch starts at once and would otherwise see it held
      // and report 'already-running', stalling the job until the status poller wakes it.
      await state.delete(lockKey)
      await queueNext(job)
    }
    await state.put(stateKey, JSON.stringify(job), { ttl: 7 * 24 * 3600, ifExists: true })
    await saveManifest(context.author, context.aemToken, job.folder, { ...job, updatedAt: new Date().toISOString() })
    return { statusCode: 200, body: job }
  } catch (error) {
    const current = await state.get(stateKey)
    const job = current ? JSON.parse(current.value) : { jobId }
    job.status = 'failed'
    delete job.phase
    job.error = error.message
    await state.put(stateKey, JSON.stringify(job), { ttl: 7 * 24 * 3600, ifExists: true })
    if (context) await saveManifest(context.author, context.aemToken, job.folder, { ...job, updatedAt: new Date().toISOString() })
    return errorResponse(500, `generation failed: ${error.message}`)
  } finally {
    await state.delete(lockKey)
  }
}

// The warning that explains an empty HTML5 run: access / site problems first, then the first one.
const BLOCKING = ['HTML5_NO_SITE', 'HTML5_DA_NO_ACCESS', 'HTML5_NO_EDS_SITE', 'HTML5_NO_PAGES', 'HTML5_DA_ERROR', 'HTML5_EDS_ERROR']
function html5Reason (html5) {
  const warnings = (html5 && html5.warnings) || []
  const w = BLOCKING.map((code) => warnings.find((x) => x && x.code === code)).find(Boolean) || warnings[0]
  return w ? `${w.message} (${w.code})` : 'the render returned no HTML5 result'
}

async function invokeWorker (payload) {
  const namespace = process.env.__OW_NAMESPACE
  const host = process.env.__OW_API_HOST || `https://${namespace}.adobeioruntime.net`
  const auth = `Basic ${Buffer.from(process.env.__OW_API_KEY).toString('base64')}`
  const r = await fetch(`${host}/api/v1/namespaces/${encodeURIComponent(namespace)}/actions/aem-assets-assetsview-1/generate-idapi-banners-worker?blocking=false`, {
    method: 'POST', headers: { Authorization: auth, 'Content-Type': 'application/json' }, body: JSON.stringify(payload)
  })
  if (!r.ok) throw new Error(`queue worker -> ${r.status}`)
}
const queueNext = (job) => invokeWorker({ jobId: job.jobId })

exports.main = main
exports.html5Reason = html5Reason
