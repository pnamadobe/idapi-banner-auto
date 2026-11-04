const stateLib = require('@adobe/aio-lib-state')
const { processBatch, aemContext, writeJobManifest, finalizeRelations, html5SiteFor } = require('./generate-idapi-banners/engine')
const { deliverHtml5 } = require('./generate-idapi-banners/da')
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
  if (params.deliver) return deliver(state, stateKey, params)
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
    const result = await processBatch({ ...params, folder: job.folder, template: job.template || '', aemAuthorUrl: job.aemAuthorUrl, writeIndd: job.writeIndd ? '1' : '', skipImages: job.writeImages === false ? '1' : '', writeHtml5: job.writeHtml5 ? '1' : '', preflightOverride: job.preflightOverride ? '1' : '', maxRows: job.batchSize, rowOffset: job.rowOffset }, job, state)
    if (result && result.error) throw new Error(result.error.body && result.error.body.error ? result.error.body.error : 'batch failed')
    const rows = result.body && result.body.batchRows ? result.body.batchRows : 0
    // HTML5 pages are published by the first batch; keep them for the status action / modal gallery.
    let delivery = []
    if (result.body && result.body.html5) {
      const { delivery: slices, ...html5 } = result.body.html5
      delivery = slices || []
      job.html5 = html5
    }
    // An HTML5 run that wrote no DA page has produced nothing the user asked for: fail it (with the
    // reason) instead of reporting success. A retry starts over and publishes again.
    if (job.writeHtml5 && job.rowOffset === 0 && !((job.html5 && job.html5.pages) || []).length) {
      job.status = 'failed'
      job.error = `No HTML5 pages were published: ${html5Reason(job.html5)}`
      job.updatedAt = new Date().toISOString()
      await state.put(stateKey, JSON.stringify(job), { ttl: 7 * 24 * 3600, ifExists: true })
      await saveManifest(context.author, context.aemToken, job.folder, { ...job, updatedAt: job.updatedAt })
      return { statusCode: 200, body: job }
    }
    // The pages already point at the slices' delivery URLs; a follow-up run approves the slices for
    // Dynamic Media once AEM has processed them, and previews the pages again.
    if (delivery.length) {
      await state.put(`${stateKey}-delivery`, JSON.stringify({ status: 'pending', slices: delivery, total: delivery.length, attempt: 0, updatedAt: new Date().toISOString() }), { ttl: 7 * 24 * 3600 })
      try {
        await invokeWorker({ jobId, deliver: 1, ...(params.daUserToken ? { daUserToken: params.daUserToken } : {}) })
      } catch (e) {
        await state.put(`${stateKey}-delivery`, JSON.stringify({ status: 'failed', total: delivery.length, error: `The approval run could not be queued (${e.message}): generate again`, updatedAt: new Date().toISOString() }), { ttl: 7 * 24 * 3600 })
      }
    }
    job.rowOffset += rows
    if (rows < job.batchSize) {
      job.status = 'completed'
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

/*
 * The HTML5 delivery run: approve the uploaded slices once AEM has processed them (minutes after upload),
 * wait until Dynamic Media serves them, and preview their pages again so EDS picks up the backgrounds.
 * Its record (`<job>-delivery`) is separate from the job, which is already completed. Slices still
 * processing when this run nears its time limit are left to another run, up to DELIVER_RUNS in all.
 * The user's token (for the EDS preview) comes in the invocation only and is passed on, never stored.
 */
const DELIVER_RUNS = 3
async function deliver (state, stateKey, params) {
  const key = `${stateKey}-delivery`
  const lockKey = `${key}-lock`
  // The previous run releases the lock just before queueing this one; allow for that to propagate.
  let lock = await state.put(lockKey, String(Date.now()), { ttl: 900, ifNotExists: true })
  for (let i = 0; !lock && i < 4; i++) {
    await new Promise((resolve) => setTimeout(resolve, params.lockWaitMs === undefined ? 3000 : params.lockWaitMs))
    lock = await state.put(lockKey, String(Date.now()), { ttl: 900, ifNotExists: true })
  }
  if (!lock) return { statusCode: 202, body: { status: 'already-running' } }
  const save = (record) => state.put(key, JSON.stringify({ ...record, updatedAt: new Date().toISOString() }), { ttl: 7 * 24 * 3600 })
  let record
  try {
    const current = await state.get(key)
    record = current && JSON.parse(current.value)
    if (!record || record.status !== 'pending') return { statusCode: 200, body: { status: record ? record.status : 'none' } }
    const jobRecord = await state.get(stateKey)
    if (!jobRecord) return errorResponse(404, 'job not found')
    const job = JSON.parse(jobRecord.value)
    const start = Date.now()
    const attempt = (record.attempt || 0) + 1
    const final = attempt >= DELIVER_RUNS
    await save({ ...record, status: 'running', attempt })
    const { author, aemToken } = await aemContext({ ...params, aemAuthorUrl: job.aemAuthorUrl, folder: job.folder })
    const cfg = await html5SiteFor(author, aemToken, job.folder)
    const out = await deliverHtml5({
      cfg,
      edsToken: params.EDS_ADMIN_TOKEN || '',
      edsBearer: params.daUserToken || '',
      author,
      aemToken,
      slices: record.slices,
      approveBy: start + (params.approveMs || 420 * 1000),
      deliveredBy: start + (params.deliveredMs || 510 * 1000),
      final,
      sleep: params.sleep,
      logger: console
    })
    const warnings = [...(record.warnings || []), ...out.warnings]
    const previewed = [...(record.previewed || []), ...out.previewed]
    if (out.remaining.length && !final) {
      await save({ ...record, status: 'pending', attempt, slices: out.remaining, previewed, warnings })
      await state.delete(lockKey)
      await invokeWorker({ jobId: job.jobId, deliver: 1, ...(params.daUserToken ? { daUserToken: params.daUserToken } : {}) })
      return { statusCode: 202, body: { status: 'pending', remaining: out.remaining.length } }
    }
    await save({ status: 'done', total: record.total, attempt, delivered: record.total - out.remaining.length, previewed, warnings })
    return { statusCode: 200, body: { status: 'done', remaining: out.remaining.length } }
  } catch (error) {
    await save({ status: 'failed', total: record && record.total, error: error.message, warnings: (record && record.warnings) || [] })
    return errorResponse(500, `delivery failed: ${error.message}`)
  } finally {
    await state.delete(lockKey)
  }
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
