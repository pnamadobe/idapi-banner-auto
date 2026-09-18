/*
 * Durable orchestration entry point. The renderer itself lives in engine.js;
 * this action only creates/reuses a state record and queues a worker.
 */
const stateLib = require('@adobe/aio-lib-state')
const { Core } = require('@adobe/aio-sdk')
const { errorResponse, stringParameters, checkMissingRequestInputs } = require('../utils')
const { keyFor, publicJob } = require('../job-utils')
const { inspectInputs } = require('./engine')

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
  const logger = Core.Logger('main', { level: params.LOG_LEVEL || 'info' })
  try {
    logger.debug(stringParameters(params))
    const missing = checkMissingRequestInputs(params, ['folder'], [])
    if (missing) return errorResponse(400, missing, logger)
    if (!params.AEM_SC_JSON && !params.AEM_DEV_TOKEN) return errorResponse(500, 'AEM_SC_JSON or AEM_DEV_TOKEN must be configured for durable jobs', logger)
    if (String(params.preflight || '') === '1') {
      const estimate = await inspectInputs(params)
      return { statusCode: 200, body: estimate }
    }
    const state = await stateLib.init()
    const writeIndd = /^(1|true|yes)$/i.test(String(params.writeIndd || ''))
    const stateKey = keyFor(params.folder, writeIndd)
    const existing = await state.get(stateKey)
    if (existing) {
      const job = JSON.parse(existing.value)
      if (job.status === 'queued' || job.status === 'running') return { statusCode: 202, body: publicJob(job) }
      if (job.status === 'completed') return { statusCode: 200, body: { ...publicJob(job), reused: true } }
      if (job.status === 'failed') {
        job.status = 'queued'
        delete job.error
        job.retriedAt = new Date().toISOString()
        await state.put(stateKey, JSON.stringify(job), { ttl, ifExists: true })
        await invoke('generate-idapi-banners-worker', { jobId: job.jobId })
        return { statusCode: 202, body: publicJob(job) }
      }
    }
    const job = {
      stateKey,
      jobId: stateKey.slice('idapi-job-'.length),
      folder: params.folder,
      aemAuthorUrl: params.aemAuthorUrl || '',
      writeIndd,
      batchSize: Math.max(1, Math.min(10, Number(params.batchSize) || 2)),
      rowOffset: 0,
      outputs: [],
      status: 'queued',
      createdAt: new Date().toISOString()
    }
    await state.put(stateKey, JSON.stringify(job), { ttl, ifNotExists: true })
    const winner = await state.get(stateKey)
    const persisted = JSON.parse(winner.value)
    if (persisted.status === 'queued') {
      await invoke('generate-idapi-banners-worker', { jobId: persisted.jobId })
    }
    return { statusCode: 202, body: publicJob(persisted) }
  } catch (error) {
    logger.error(error)
    return errorResponse(500, `job start failed: ${error.message}`, logger)
  }
}

exports.main = main
exports.publicJob = publicJob
exports.keyFor = keyFor
