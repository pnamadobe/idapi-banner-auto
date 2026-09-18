const stateLib = require('@adobe/aio-lib-state')
const { processBatch, aemContext, writeJobManifest } = require('./generate-idapi-banners/engine')
const { errorResponse } = require('./utils')

async function main (params) {
  const state = await stateLib.init()
  let context
  const jobId = String(params.jobId || '')
  if (!/^[a-f0-9]{48}$/.test(jobId)) return errorResponse(400, 'invalid jobId')
  const stateKey = `idapi-job-${jobId}`
  const lockKey = `${stateKey}-lock`
  const lock = await state.put(lockKey, String(Date.now()), { ttl: 900, ifNotExists: true })
  if (!lock) return { statusCode: 202, body: { jobId, status: 'already-running' } }
  try {
    const current = await state.get(stateKey)
    if (!current) return errorResponse(404, 'job not found')
    const job = JSON.parse(current.value)
    if (job.status === 'completed') return { statusCode: 200, body: job }
    job.status = 'running'
    job.updatedAt = new Date().toISOString()
    await state.put(stateKey, JSON.stringify(job), { ttl: 7 * 24 * 3600, ifExists: true })
    context = await aemContext({ ...params, aemAuthorUrl: job.aemAuthorUrl, folder: job.folder })
    await writeJobManifest(context.author, context.aemToken, job.folder, { ...job, updatedAt: new Date().toISOString() })
    const result = await processBatch({ ...params, folder: job.folder, aemAuthorUrl: job.aemAuthorUrl, writeIndd: job.writeIndd ? '1' : '', maxRows: job.batchSize, rowOffset: job.rowOffset }, job, state)
    if (result && result.error) throw new Error(result.error.body && result.error.body.error ? result.error.body.error : 'batch failed')
    const rows = result.body && result.body.batchRows ? result.body.batchRows : 0
    job.rowOffset += rows
    if (rows < job.batchSize) job.status = 'completed'
    else {
      job.status = 'queued'
      job.queuedAt = new Date().toISOString()
      await state.put(stateKey, JSON.stringify(job), { ttl: 7 * 24 * 3600, ifExists: true })
      await queueNext(job)
    }
    await state.put(stateKey, JSON.stringify(job), { ttl: 7 * 24 * 3600, ifExists: true })
    await writeJobManifest(context.author, context.aemToken, job.folder, { ...job, updatedAt: new Date().toISOString() })
    return { statusCode: 200, body: job }
  } catch (error) {
    const current = await state.get(stateKey)
    const job = current ? JSON.parse(current.value) : { jobId }
    job.status = 'failed'
    job.error = error.message
    await state.put(stateKey, JSON.stringify(job), { ttl: 7 * 24 * 3600, ifExists: true })
    if (context) await writeJobManifest(context.author, context.aemToken, job.folder, { ...job, updatedAt: new Date().toISOString() })
    return errorResponse(500, `generation failed: ${error.message}`)
  } finally {
    await state.delete(lockKey)
  }
}

async function queueNext (job) {
  const namespace = process.env.__OW_NAMESPACE
  const host = process.env.__OW_API_HOST || `https://${namespace}.adobeioruntime.net`
  const auth = `Basic ${Buffer.from(process.env.__OW_API_KEY).toString('base64')}`
  const r = await fetch(`${host}/api/v1/namespaces/${encodeURIComponent(namespace)}/actions/aem-assets-assetsview-1/generate-idapi-banners-worker?blocking=false`, {
    method: 'POST', headers: { Authorization: auth, 'Content-Type': 'application/json' }, body: JSON.stringify({ jobId: job.jobId })
  })
  if (!r.ok) throw new Error(`queue next batch -> ${r.status}`)
}

exports.main = main
