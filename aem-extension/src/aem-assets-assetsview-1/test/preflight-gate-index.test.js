/*
 * The start action's preflight gate: errors stop a job from being created or requeued (HTTP 422)
 * unless preflightOverride=1. State, engine and the worker invocation are faked.
 */
const mockStore = new Map()
const mockInspect = jest.fn()

jest.mock('@adobe/aio-lib-state', () => ({
  init: async () => ({
    get: async (k) => (mockStore.has(k) ? { value: mockStore.get(k) } : undefined),
    put: async (k, v) => { mockStore.set(k, v) },
    delete: async (k) => { mockStore.delete(k) }
  })
}))
jest.mock('@adobe/aio-sdk', () => ({
  Core: { Logger: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }) }
}))
jest.mock('../actions/generate-idapi-banners/engine', () => ({
  inspectInputs: (...args) => mockInspect(...args),
  resolveOutputFolder: async () => '/content/dam/x/output/stamp'
}))

const { main } = require('../actions/generate-idapi-banners')
const { keyFor } = require('../actions/job-utils')

const params = (extra) => ({ folder: '/content/dam/x', AEM_DEV_TOKEN: 'token', ...extra })
const err = { severity: 'error', code: 'IMG_MISSING', message: 'row 2: hero "nope.jpg" was not found', row: 2, column: 'hero' }
const warn = { severity: 'warn', code: 'CELL_EMPTY', message: 'row 3: cta is empty', row: 3, column: 'cta' }
const stored = () => JSON.parse(mockStore.get(keyFor('/content/dam/x', false, '', false)))

beforeEach(() => {
  mockStore.clear()
  mockInspect.mockReset()
  process.env.__OW_NAMESPACE = 'ns'
  process.env.__OW_API_KEY = 'key'
  global.fetch = jest.fn(async () => ({ ok: true }))
})

test('errors stop the start with 422 and findings; nothing is created or queued', async () => {
  mockInspect.mockResolvedValue({ ok: false, findings: [err, warn] })
  const res = await main(params())
  expect(res.statusCode).toBe(422)
  expect(res.body.error).toMatch(/Preflight found 1 problem/)
  expect(res.body.error).toMatch(/nope\.jpg/)
  expect(res.body.findings).toEqual([err, warn])
  expect(mockStore.size).toBe(0)
  expect(global.fetch).not.toHaveBeenCalled()
})

test('preflightOverride=1 starts the job anyway and keeps the findings on it', async () => {
  mockInspect.mockResolvedValue({ ok: false, findings: [err, warn] })
  const res = await main(params({ preflightOverride: '1' }))
  expect(res.statusCode).toBe(202)
  expect(res.body.findings).toEqual([err, warn])
  expect(stored()).toMatchObject({ status: 'queued', preflightOverride: true })
  expect(global.fetch).toHaveBeenCalledTimes(1)
  expect(global.fetch.mock.calls[0][0]).toMatch(/generate-idapi-banners-worker/)
})

test('warnings alone do not block, and are shown on the job', async () => {
  mockInspect.mockResolvedValue({ ok: true, findings: [warn] })
  const res = await main(params())
  expect(res.statusCode).toBe(202)
  expect(stored()).toMatchObject({ preflightOverride: false, findings: [warn] })
})

test('a job with no findings carries no findings field', async () => {
  mockInspect.mockResolvedValue({ ok: true, findings: [] })
  const res = await main(params())
  expect(res.statusCode).toBe(202)
  expect(res.body).not.toHaveProperty('findings')
})

test('an inspection that itself fails (e.g. AEM unreachable) does not block the start', async () => {
  mockInspect.mockRejectedValue(new Error('AEM list /content/dam/x -> 503'))
  const res = await main(params())
  expect(res.statusCode).toBe(202)
  expect(stored()).not.toHaveProperty('findings')
})

test('a job that is already running is reported without running the preflight again', async () => {
  mockInspect.mockResolvedValue({ ok: true, findings: [] })
  await main(params())
  mockInspect.mockClear()
  global.fetch.mockClear()
  const res = await main(params())
  expect(res.statusCode).toBe(202)
  expect(mockInspect).not.toHaveBeenCalled()
  expect(global.fetch).not.toHaveBeenCalled()
})

test('retrying a failed job is gated too, and a blocked retry leaves the job as it was', async () => {
  mockInspect.mockResolvedValue({ ok: true, findings: [] })
  await main(params())
  const key = keyFor('/content/dam/x', false, '', false)
  mockStore.set(key, JSON.stringify({ ...stored(), status: 'failed', error: 'boom' }))

  mockInspect.mockResolvedValue({ ok: false, findings: [err] })
  const blocked = await main(params())
  expect(blocked.statusCode).toBe(422)
  expect(stored()).toMatchObject({ status: 'failed', error: 'boom' })

  const forced = await main(params({ preflightOverride: 'true' }))
  expect(forced.statusCode).toBe(202)
  expect(stored()).toMatchObject({ status: 'queued', preflightOverride: true, findings: [err] })
  expect(stored()).not.toHaveProperty('error')
})

test('stored findings are capped', async () => {
  const many = Array.from({ length: 100 }, (_, i) => ({ ...warn, row: i + 2 }))
  mockInspect.mockResolvedValue({ ok: true, findings: many })
  await main(params())
  expect(stored().findings).toHaveLength(require('../actions/generate-idapi-banners/preflight').MAX_STORED_FINDINGS)
})
