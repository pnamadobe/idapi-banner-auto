const crypto = require('crypto')

const keyFor = (folder, writeIndd) => `idapi-job-${crypto.createHash('sha256').update(`${folder}|${writeIndd ? '1' : '0'}`).digest('hex').slice(0, 48)}`
// Deliverables only (images + editable INDD); excludes _run_log.txt and similar side files.
const isDeliverable = (name) => /\.(jpe?g|png|indd)$/i.test(name)
const publicJob = (job) => ({
  jobId: job.jobId,
  folder: job.folder,
  outputFolder: job.folder ? `${job.folder}/output` : undefined,
  status: job.status,
  count: (job.outputs || []).filter(isDeliverable).length,
  error: job.error
})

module.exports = { keyFor, publicJob, isDeliverable }
