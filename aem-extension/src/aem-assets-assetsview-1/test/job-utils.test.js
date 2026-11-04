const { keyFor, outputMode, publicJob } = require('../actions/job-utils')

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
