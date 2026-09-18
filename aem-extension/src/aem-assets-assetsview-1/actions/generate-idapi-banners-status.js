const stateLib = require('@adobe/aio-lib-state')
const { publicJob } = require('./job-utils')
const { aemContext, aemDownload, jobManifestName } = require('./generate-idapi-banners/engine')
const { errorResponse } = require('./utils')

const staleQueueMs = 45 * 1000

async function wakeWorker (jobId) {
  const namespace = process.env.__OW_NAMESPACE
  const host = process.env.__OW_API_HOST || `https://${namespace}.adobeioruntime.net`
  if (!namespace || !process.env.__OW_API_KEY) throw new Error('Runtime invocation credentials are unavailable')
  const response = await fetch(`${host}/api/v1/namespaces/${encodeURIComponent(namespace)}/actions/aem-assets-assetsview-1/generate-idapi-banners-worker?blocking=false`, {
    method: 'POST',
    headers: { Authorization: `Basic ${Buffer.from(process.env.__OW_API_KEY).toString('base64')}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ jobId })
  })
  if (!response.ok) throw new Error(`wake worker -> ${response.status}`)
}

exports.main = async (params) => {
  const jobId = String(params.jobId || '')
  if (jobId && !/^[a-f0-9]{48}$/.test(jobId)) return errorResponse(400, 'invalid jobId')
  let resolvedJobId = jobId
  if (!resolvedJobId && params.folder) {
    try {
      const context = await aemContext(params)
      const manifest = JSON.parse((await aemDownload(context.author, context.aemToken, `${params.folder}/output/${jobManifestName}`)).toString('utf8'))
      resolvedJobId = manifest.jobId
    } catch (error) {
      return errorResponse(404, `job manifest not found for ${params.folder}`)
    }
  }
  if (!resolvedJobId) return errorResponse(400, 'jobId or folder is required')
  const state = await stateLib.init()
  const record = await state.get(`idapi-job-${resolvedJobId}`)
  if (!record) return errorResponse(404, 'job not found')
  const job = JSON.parse(record.value)
  if (job.status === 'queued') {
    const queuedAt = Date.parse(job.queuedAt || job.updatedAt || job.createdAt || '')
    const recoveryAt = Date.parse(job.recoveryAt || '')
    if (queuedAt && Date.now() - queuedAt > staleQueueMs &&
      (!recoveryAt || Date.now() - recoveryAt > staleQueueMs)) {
      job.recoveryAt = new Date().toISOString()
      await state.put(`idapi-job-${resolvedJobId}`, JSON.stringify(job), { ttl: 7 * 24 * 3600, ifExists: true })
      try {
        await wakeWorker(resolvedJobId)
      } catch (error) {
        job.recoveryError = error.message
        delete job.recoveryAt
        await state.put(`idapi-job-${resolvedJobId}`, JSON.stringify(job), { ttl: 7 * 24 * 3600, ifExists: true })
      }
    }
  }
  return { statusCode: 200, body: publicJob(job) }
}
