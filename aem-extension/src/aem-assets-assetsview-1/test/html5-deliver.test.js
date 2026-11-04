/*
 * The HTML5 delivery run: after the pages are written, a follow-up worker run approves the background
 * slices once AEM has processed them and previews the pages again. Slices still processing are left
 * to another run (with the user's token passed on, never stored); the status action reports progress.
 */
const mockStore = new Map()
const mockBatch = jest.fn()
const mockDeliver = jest.fn()

jest.mock('@adobe/aio-lib-state', () => ({
  init: async () => ({
    get: async (k) => (mockStore.has(k) ? { value: mockStore.get(k) } : undefined),
    put: async (k, v, o = {}) => { if (o.ifNotExists && mockStore.has(k)) return null; mockStore.set(k, v); return k },
    delete: async (k) => { mockStore.delete(k) }
  })
}))
jest.mock('@adobe/aio-sdk', () => ({
  Core: { Logger: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }) }
}))
jest.mock('../actions/generate-idapi-banners/engine', () => ({
  resolveOutputFolder: async () => '/content/dam/x/output',
  processBatch: (...args) => mockBatch(...args),
  aemContext: async () => ({ author: 'https://author-p1-e2.adobeaemcloud.com', aemToken: 'aem' }),
  html5SiteFor: async () => ({ org: 'acme', site: 'ads-site' }),
  writeJobManifest: async () => {},
  finalizeRelations: async () => {}
}))
jest.mock('../actions/generate-idapi-banners/da', () => ({ deliverHtml5: (...args) => mockDeliver(...args) }))

const worker = require('../actions/generate-idapi-banners-worker')
const status = require('../actions/generate-idapi-banners-status').main
const { keyFor } = require('../actions/job-utils')

const FOLDER = '/content/dam/x'
const key = keyFor(FOLDER, false, 'hgv-template.indd', false, true)
const jobId = key.slice('idapi-job-'.length)
const dkey = `${key}-delivery`
const A = { damPath: '/content/dam/x/a.png', url: 'https://delivery-p1-e2.adobeaemcloud.com/adobe/assets/a/as/a.png', page: '/ads/a' }
const B = { ...A, damPath: '/content/dam/x/b.png', page: '/ads/b' }
const queued = () => global.fetch.mock.calls.map(([, o]) => JSON.parse(o.body))

beforeEach(() => {
  mockStore.clear()
  mockBatch.mockReset()
  mockDeliver.mockReset()
  process.env.__OW_NAMESPACE = 'ns'
  process.env.__OW_API_KEY = 'key'
  global.fetch = jest.fn(async () => ({ ok: true }))
})
afterEach(() => { delete global.fetch })

const job = (extra) => ({ stateKey: key, jobId, folder: FOLDER, template: 'hgv-template.indd', writeHtml5: true, writeImages: false, batchSize: 2, rowOffset: 0, outputs: [], status: 'queued', ...extra })

test('a published HTML5 run records its slices and queues a delivery run with the user token', async () => {
  mockStore.set(key, JSON.stringify(job()))
  mockBatch.mockResolvedValue({ statusCode: 200, body: { batchRows: 0, html5: { pages: [{ page: 'A', path: '/ads/a' }], warnings: [], delivery: [A, B] } } })
  const res = await worker.main({ jobId, daUserToken: 'user-tok' })
  expect(res.body.status).toBe('completed')
  expect(JSON.parse(mockStore.get(key)).html5.delivery).toBeUndefined()
  expect(JSON.parse(mockStore.get(dkey))).toMatchObject({ status: 'pending', slices: [A, B], total: 2, attempt: 0 })
  expect(queued()).toContainEqual({ jobId, deliver: 1, daUserToken: 'user-tok' })
  expect(mockStore.get(dkey)).not.toMatch(/user-tok/)
})

test('the delivery run marks the record done when every slice is delivered', async () => {
  mockStore.set(key, JSON.stringify(job({ status: 'completed' })))
  mockStore.set(dkey, JSON.stringify({ status: 'pending', slices: [A, B], total: 2, attempt: 0 }))
  mockDeliver.mockResolvedValue({ previewed: ['/ads/a', '/ads/b'], remaining: [], warnings: [] })
  const res = await worker.main({ jobId, deliver: 1, daUserToken: 'user-tok', lockWaitMs: 0 })
  expect(res.body.status).toBe('done')
  expect(mockDeliver.mock.calls[0][0]).toMatchObject({ slices: [A, B], edsBearer: 'user-tok', final: false, cfg: { org: 'acme' } })
  expect(JSON.parse(mockStore.get(dkey))).toMatchObject({ status: 'done', total: 2, delivered: 2, attempt: 1, previewed: ['/ads/a', '/ads/b'] })
  expect(mockStore.has(`${dkey}-lock`)).toBe(false)
  expect(global.fetch).not.toHaveBeenCalled()
})

test('slices still processing are left to another run, then the last run gives up with warnings', async () => {
  mockStore.set(key, JSON.stringify(job({ status: 'completed' })))
  mockStore.set(dkey, JSON.stringify({ status: 'pending', slices: [A, B], total: 2, attempt: 0 }))
  mockDeliver.mockResolvedValueOnce({ previewed: ['/ads/a'], remaining: [B], warnings: [] })
  let res = await worker.main({ jobId, deliver: 1, daUserToken: 'user-tok', lockWaitMs: 0 })
  expect(res.statusCode).toBe(202)
  expect(JSON.parse(mockStore.get(dkey))).toMatchObject({ status: 'pending', slices: [B], attempt: 1, previewed: ['/ads/a'] })
  expect(queued()).toEqual([{ jobId, deliver: 1, daUserToken: 'user-tok' }])
  mockDeliver.mockResolvedValue({ previewed: [], remaining: [B], warnings: [] })
  await worker.main({ jobId, deliver: 1, daUserToken: 'user-tok', lockWaitMs: 0 })
  mockDeliver.mockResolvedValue({ previewed: ['/ads/b'], remaining: [B], warnings: [{ code: 'HTML5_ASSET_NOT_DELIVERABLE', message: 'b' }] })
  res = await worker.main({ jobId, deliver: 1, daUserToken: 'user-tok', lockWaitMs: 0 })
  expect(mockDeliver.mock.calls[2][0].final).toBe(true)
  expect(JSON.parse(mockStore.get(dkey))).toMatchObject({ status: 'done', delivered: 1, attempt: 3, previewed: ['/ads/a', '/ads/b'], warnings: [{ code: 'HTML5_ASSET_NOT_DELIVERABLE' }] })
  expect(queued()).toHaveLength(2)
})

test('a delivery run that is not pending does nothing', async () => {
  mockStore.set(key, JSON.stringify(job({ status: 'completed' })))
  mockStore.set(dkey, JSON.stringify({ status: 'done', total: 2 }))
  const res = await worker.main({ jobId, deliver: 1, lockWaitMs: 0 })
  expect(res.body.status).toBe('done')
  expect(mockDeliver).not.toHaveBeenCalled()
})

test('a failing delivery run is recorded as failed', async () => {
  mockStore.set(key, JSON.stringify(job({ status: 'completed' })))
  mockStore.set(dkey, JSON.stringify({ status: 'pending', slices: [A], total: 1, attempt: 0 }))
  mockDeliver.mockRejectedValue(new Error('AEM 503'))
  await worker.main({ jobId, deliver: 1, lockWaitMs: 0 })
  expect(JSON.parse(mockStore.get(dkey))).toMatchObject({ status: 'failed', error: 'AEM 503' })
  expect(mockStore.has(`${dkey}-lock`)).toBe(false)
})

test('status reports delivery progress on the HTML5 result without the slice list', async () => {
  mockStore.set(key, JSON.stringify(job({ status: 'completed', updatedAt: new Date().toISOString(), html5: { pages: [{ page: 'A' }], warnings: [] } })))
  mockStore.set(dkey, JSON.stringify({ status: 'pending', slices: [B], total: 2, attempt: 1, updatedAt: new Date().toISOString() }))
  let r = await status({ jobId })
  expect(r.body.html5.delivery).toMatchObject({ status: 'pending', total: 2, remaining: 1 })
  expect(r.body.html5.delivery.slices).toBeUndefined()
  mockStore.set(dkey, JSON.stringify({ status: 'running', slices: [B], total: 2, updatedAt: new Date(Date.now() - 20 * 60 * 1000).toISOString() }))
  r = await status({ jobId })
  expect(r.body.html5.delivery).toMatchObject({ status: 'failed', error: expect.stringMatching(/Generate again/) })
})
