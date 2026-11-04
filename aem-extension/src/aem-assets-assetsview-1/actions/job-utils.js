const crypto = require('crypto')

// One job per (folder, editable-output option, selected template). Without a template the key is the
// legacy folder|option one, so jobs started before templates were selectable keep their key.
// Editable-only runs (no flattened images) are a different job from images-only / images + editable ones.
// HTML5 runs (DA pages only, no flattened images) are their own job too, so an earlier images-only job is not reused.
const keyFor = (folder, writeIndd, template, editableOnly, html5) => `idapi-job-${crypto.createHash('sha256').update(`${folder}|${writeIndd ? '1' : '0'}${template ? `|${template}` : ''}${editableOnly ? '|editable-only' : ''}${html5 ? '|html5' : ''}`).digest('hex').slice(0, 48)}`
// What a request asks for: mode 'editable' = only the editable file (+ its PDF/previews), 'both' = images and the
// editable file (legacy writeIndd=1), anything else = images only.
const outputMode = (params) => {
  const mode = String(params.mode || '').toLowerCase()
  if (mode === 'editable') return { editable: true, images: false, html5: false }
  if (mode === 'html5' || /^(1|true|yes)$/i.test(String(params.writeHtml5 || ''))) return { editable: false, images: false, html5: true }
  if (mode === 'both' || /^(1|true|yes)$/i.test(String(params.writeIndd || ''))) return { editable: true, images: true, html5: false }
  return { editable: false, images: true, html5: false }
}
// The selected template is a bare file name inside the job folder (it is appended to a DAM path).
const isTemplateName = (name) => /^[^/\\\x00-\x1f]+\.(indd|psd)$/i.test(String(name || '')) // eslint-disable-line no-control-regex
// Deliverables only (images + editable INDD); excludes _run_log.txt and similar side files.
const isDeliverable = (name) => /\.(jpe?g|png|indd|psd|pdf)$/i.test(name)
const publicJob = (job) => ({
  jobId: job.jobId,
  folder: job.folder,
  outputFolder: job.outputFolder || (job.folder ? `${job.folder}/output` : undefined),
  status: job.status,
  count: (job.outputs || []).filter(isDeliverable).length,
  error: job.error,
  ...(job.writeHtml5 ? { writeHtml5: true, html5: job.html5 || null } : {}),
  ...(job.findings && job.findings.length ? { findings: job.findings } : {})
})

// Assets View deep link to the job's output folder. Needs ASSETS_VIEW_TENANT (the "@org" slug in
// Assets View URLs, e.g. "@yourorg"); without it there is no link rather than a wrong one.
function outputUrl (job, params = {}) {
  const tenant = String(params.ASSETS_VIEW_TENANT || '').trim()
  const author = String(job.aemAuthorUrl || params.AEM_AUTHOR_URL || '').trim()
  const folder = job.outputFolder || (job.folder ? `${job.folder}/output` : '')
  if (!/^@[A-Za-z0-9._-]+$/.test(tenant) || !/^https:\/\/author-[a-z0-9-]+\.adobeaemcloud\.com\/?$/i.test(author) || !folder) return undefined
  const path = folder.split('/').map(encodeURIComponent).join('/')
  return `https://experience.adobe.com/?repoId=${new URL(author).host}#/${tenant}/assets/browse${path}`
}

module.exports = { keyFor, publicJob, isDeliverable, outputUrl, isTemplateName, outputMode }
