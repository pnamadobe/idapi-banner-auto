const { keyFor, publicJob } = require('../actions/job-utils')

test('job key is deterministic and separates editable-output jobs', () => {
  expect(keyFor('/content/dam/campaign', false)).toBe(keyFor('/content/dam/campaign', false))
  expect(keyFor('/content/dam/campaign', false)).not.toBe(keyFor('/content/dam/campaign', true))
  expect(keyFor('/content/dam/campaign', false)).toMatch(/^idapi-job-[a-f0-9]{48}$/)
})

test('public status does not expose orchestration state', () => {
  expect(publicJob({ jobId: 'abc', folder: '/content/dam/x', status: 'running', outputs: ['a.png'], secret: 'nope' }))
    .toEqual(expect.objectContaining({ jobId: 'abc', status: 'running', count: 1 }))
  expect(publicJob({ secret: 'nope' })).not.toHaveProperty('secret')
})
