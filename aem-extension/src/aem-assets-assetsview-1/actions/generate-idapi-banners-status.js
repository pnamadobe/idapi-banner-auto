const stateLib = require('@adobe/aio-lib-state')
const { publicJob } = require('./job-utils')
const { errorResponse } = require('./utils')

exports.main = async (params) => {
  const jobId = String(params.jobId || '')
  if (!/^[a-f0-9]{48}$/.test(jobId)) return errorResponse(400, 'invalid jobId')
  const record = await (await stateLib.init()).get(`idapi-job-${jobId}`)
  if (!record) return errorResponse(404, 'job not found')
  return { statusCode: 200, body: publicJob(JSON.parse(record.value)) }
}
