const stateLib = require('@adobe/aio-lib-state')
const { publicJob } = require('./job-utils')
const { aemContext, aemDownload, jobManifestName } = require('./generate-idapi-banners/engine')
const { errorResponse } = require('./utils')

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
  const record = await (await stateLib.init()).get(`idapi-job-${resolvedJobId}`)
  if (!record) return errorResponse(404, 'job not found')
  return { statusCode: 200, body: publicJob(JSON.parse(record.value)) }
}
