const { keyFor, outputMode, publicJob, isDamFolder } = require('../actions/job-utils')

test('outputMode: html5 mode renders only HTML5 (no flattened images, no editable file)', () => {
  expect(outputMode({ mode: 'html5' })).toEqual({ editable: false, images: false, html5: true })
  expect(outputMode({ writeHtml5: '1' })).toEqual({ editable: false, images: false, html5: true })
  expect(outputMode({ mode: 'both' }).html5).toBe(false)
  expect(outputMode({ mode: 'editable' }).html5).toBe(false)
  expect(outputMode({}).html5).toBe(false)
})

test('keyFor: an HTML5 job does not collide with the images-only job', () => {
  const images = keyFor('/content/dam/x', false, 't.indd', false)
  expect(keyFor('/content/dam/x', false, 't.indd', false, false)).toBe(images)
  expect(keyFor('/content/dam/x', false, 't.indd', false, true)).not.toBe(images)
  expect(keyFor('/content/dam/x', false, 't.indd', false, true)).toMatch(/^idapi-job-[a-f0-9]{48}$/)
})

test('keyFor matches the modal hash (sha256 of the key input, 48 hex)', () => {
  const crypto = require('crypto')
  const want = crypto.createHash('sha256').update('/f|0|t.indd|html5').digest('hex').slice(0, 48)
  expect(keyFor('/f', false, 't.indd', false, true)).toBe(`idapi-job-${want}`)
})

test('publicJob exposes html5 only for HTML5 jobs', () => {
  const base = { jobId: 'j', status: 'completed', folder: '/f' }
  expect(publicJob(base).html5).toBeUndefined()
  const html5 = { pages: [{ page: 'A', previewUrl: 'https://x' }], warnings: [] }
  expect(publicJob({ ...base, writeHtml5: true, html5 })).toMatchObject({ writeHtml5: true, html5 })
  expect(publicJob({ ...base, writeHtml5: true }).html5).toBeNull()
})

describe('publicJob html5Folder', () => {
  test('HTML5 jobs expose their DA folder', () => {
    const f = { site: 'pnamadobe/banner-ads', path: '/ads/t/c', daUrl: 'https://da.live/#/pnamadobe/banner-ads/ads/t/c' }
    expect(publicJob({ jobId: 'x', writeHtml5: true, html5Folder: f }).html5Folder).toEqual(f)
  })
  test('image jobs do not', () => {
    expect(publicJob({ jobId: 'x', html5Folder: { path: '/ads' } }).html5Folder).toBeUndefined()
  })
})

test('isDamFolder accepts valid /content/dam/... paths and rejects traversal or non-DAM paths', () => {
  expect(isDamFolder('/content/dam/acme')).toBe(true)
  expect(isDamFolder('/content/dam/acme/campaign/')).toBe(true)
  for (const bad of ['', '/content/dam', '/content/dam/', '/content/dam/../etc', '/content/dam/a/../b', '/etc/passwd', '/content/dam/a\\b']) {
    expect(isDamFolder(bad)).toBe(false)
  }
})

test('keyFor isolates jobs across different AEM environments / tenants while preserving legacy keys when scope is omitted', () => {
  const legacy = keyFor('/content/dam/x', false, 't.indd', false, false)
  expect(keyFor('/content/dam/x', false, 't.indd', false, false, '')).toBe(legacy)
  const envA = keyFor('/content/dam/x', false, 't.indd', false, false, 'https://author-p1-e1.adobeaemcloud.com/')
  const envB = keyFor('/content/dam/x', false, 't.indd', false, false, 'https://author-p1-e2.adobeaemcloud.com')
  expect(envA).not.toBe(legacy)
  expect(envA).not.toBe(envB)
  expect(keyFor('/content/dam/x', false, 't.indd', false, false, 'https://AUTHOR-P1-E1.adobeaemcloud.com')).toBe(envA)
})

test('outputUrl supports dynamically discovered tenant on job or params', () => {
  const { outputUrl } = require('../actions/job-utils')
  const job = { folder: '/content/dam/camp', aemAuthorUrl: 'https://author-p1-e2.adobeaemcloud.com', tenant: 'acme' }
  expect(outputUrl(job, {})).toBe('https://experience.adobe.com/?repoId=author-p1-e2.adobeaemcloud.com#/@acme/assets/browse/content/dam/camp/output')
})
