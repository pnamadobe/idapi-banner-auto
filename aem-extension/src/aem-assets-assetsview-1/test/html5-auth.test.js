/*
 * HTML5 runs write to Document Authoring as the signed-in user: the start action requires their
 * bearer token, hands it to the worker in the invocation only (never in state), and the worker fails
 * a run that published no DA page instead of reporting it completed.
 */
const mockStore = new Map()
const mockInspect = jest.fn()
const mockBatch = jest.fn()
const mockSite = jest.fn()

jest.mock('@adobe/aio-lib-state', () => ({
  init: async () => ({
    get: async (k) => (mockStore.has(k) ? { value: mockStore.get(k) } : undefined),
    put: async (k, v) => { mockStore.set(k, v); return k },
    delete: async (k) => { mockStore.delete(k) }
  })
}))
jest.mock('@adobe/aio-sdk', () => ({
  Core: { Logger: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }) }
}))
jest.mock('../actions/generate-idapi-banners/engine', () => ({
  inspectInputs: (...args) => mockInspect(...args),
  resolveOutputFolder: async () => '/content/dam/x/output',
  processBatch: (...args) => mockBatch(...args),
  aemContext: async () => ({ author: 'https://author-p1-e2.adobeaemcloud.com', aemToken: 'aem' }),
  html5SiteFor: (...args) => mockSite(...args),
  writeJobManifest: async () => {},
  finalizeRelations: async () => {}
}))

const start = require('../actions/generate-idapi-banners').main
const worker = require('../actions/generate-idapi-banners-worker')
const { keyFor } = require('../actions/job-utils')

const FOLDER = '/content/dam/x'
const TEMPLATE = 'hgv-template.indd'
const params = (extra) => ({ folder: FOLDER, AEM_DEV_TOKEN: 'aem', mode: 'html5', template: TEMPLATE, ...extra })
const key = keyFor(FOLDER, false, TEMPLATE, false, true)

beforeEach(() => {
  mockStore.clear()
  mockInspect.mockReset().mockResolvedValue({ ok: true, findings: [], template: TEMPLATE })
  mockBatch.mockReset()
  mockSite.mockReset().mockImplementation(async () => require('../actions/generate-idapi-banners/html5').siteConfig('{"DA_ORG":"acme","DA_SITE":"ads-site"}'))
  process.env.__OW_NAMESPACE = 'ns'
  process.env.__OW_API_KEY = 'key'
  global.fetch = jest.fn(async () => ({ ok: true }))
})
afterEach(() => { delete global.fetch })

test('an HTML5 start without a signed-in user is refused before anything is created', async () => {
  const res = await start(params())
  expect(res.error.statusCode).toBe(401)
  expect(res.error.body.error).toMatch(/sign in again/)
  expect(mockStore.size).toBe(0)
  expect(global.fetch).not.toHaveBeenCalled()
})

test('the user token goes to the worker invocation only, never into state', async () => {
  const res = await start(params({ __ow_headers: { authorization: 'Bearer user-tok' } }))
  expect(res.statusCode).toBe(202)
  expect(JSON.stringify(res.body)).not.toMatch(/user-tok/)
  expect(mockStore.get(key)).toBeDefined()
  expect(mockStore.get(key)).not.toMatch(/user-tok/)
  const [url, opts] = global.fetch.mock.calls[0]
  expect(url).toMatch(/generate-idapi-banners-worker\?blocking=false$/)
  expect(JSON.parse(opts.body)).toEqual({ jobId: key.slice('idapi-job-'.length), daUserToken: 'user-tok' })
})

test('an HTML5 start in a folder without html5.json is refused with 422', async () => {
  mockSite.mockImplementation(async () => require('../actions/generate-idapi-banners/html5').siteConfig(null))
  const res = await start(params({ __ow_headers: { authorization: 'Bearer user-tok' } }))
  expect(res.error.statusCode).toBe(422)
  expect(res.error.body.error).toMatch(/add html5.json to the campaign folder/)
  expect(mockStore.size).toBe(0)
  expect(global.fetch).not.toHaveBeenCalled()
})

test('the HTML5 job links the folder\'s own site from html5.json', async () => {
  const res = await start(params({ __ow_headers: { authorization: 'Bearer user-tok' } }))
  expect(mockSite).toHaveBeenCalledWith('https://author-p1-e2.adobeaemcloud.com', 'aem', FOLDER)
  expect(res.body.html5Folder).toEqual({ site: 'acme/ads-site', path: '/ads/hgv-template/x', daUrl: 'https://da.live/#/acme/ads-site/ads/hgv-template/x' })
})

test('a non-HTML5 start needs no user token and sends none', async () => {
  const res = await start(params({ mode: 'editable' }))
  expect(res.statusCode).toBe(202)
  expect(Object.keys(JSON.parse(global.fetch.mock.calls[0][1].body))).toEqual(['jobId'])
})

test('the worker fails an HTML5 run that published no page, with the blocking reason', async () => {
  const jobId = key.slice('idapi-job-'.length)
  mockStore.set(key, JSON.stringify({ stateKey: key, jobId, folder: FOLDER, template: TEMPLATE, writeHtml5: true, writeImages: false, batchSize: 2, rowOffset: 0, outputs: [], status: 'queued' }))
  mockBatch.mockResolvedValue({
    statusCode: 200,
    body: {
      batchRows: 0,
      html5: { pages: [], warnings: [{ code: 'HTML5_ASSET_NOT_DELIVERABLE', message: 'hero.png is not approved' }, { code: 'HTML5_DA_NO_ACCESS', message: 'DA said 401' }] }
    }
  })
  const res = await worker.main({ jobId, daUserToken: 'user-tok' })
  expect(mockBatch.mock.calls[0][0].daUserToken).toBe('user-tok')
  expect(res.body.status).toBe('failed')
  const job = JSON.parse(mockStore.get(key))
  expect(job).toMatchObject({ status: 'failed', error: 'No HTML5 pages were published: DA said 401 (HTML5_DA_NO_ACCESS)' })
  expect(mockStore.get(key)).not.toMatch(/user-tok/)
  expect(mockStore.has(`${key}-lock`)).toBe(false)
})

test('the worker completes an HTML5 run that published pages', async () => {
  const jobId = key.slice('idapi-job-'.length)
  mockStore.set(key, JSON.stringify({ stateKey: key, jobId, folder: FOLDER, template: TEMPLATE, writeHtml5: true, writeImages: false, batchSize: 2, rowOffset: 0, outputs: [], status: 'queued' }))
  mockBatch.mockResolvedValue({ statusCode: 200, body: { batchRows: 0, html5: { pages: [{ page: 'A', path: '/ads/a' }], warnings: [] } } })
  const res = await worker.main({ jobId, daUserToken: 'user-tok' })
  expect(res.body.status).toBe('completed')
  expect(JSON.parse(mockStore.get(key)).html5.pages).toHaveLength(1)
})

test('html5Reason prefers access and site problems, then the first warning', () => {
  expect(worker.html5Reason(null)).toBe('the render returned no HTML5 result')
  expect(worker.html5Reason({ warnings: [{ code: 'X', message: 'first' }] })).toBe('first (X)')
  expect(worker.html5Reason({ warnings: [{ code: 'X', message: 'first' }, { code: 'HTML5_NO_EDS_SITE', message: 'no site' }] })).toBe('no site (HTML5_NO_EDS_SITE)')
})

describe('a re-run is not taken by a worker without the user token', () => {
  const jobId = key.slice('idapi-job-'.length)
  const old = new Date(Date.now() - 60 * 60 * 1000).toISOString()
  const job = (extra) => ({ stateKey: key, jobId, folder: FOLDER, template: TEMPLATE, writeHtml5: true, writeImages: false, batchSize: 2, rowOffset: 0, outputs: [], ...extra })
  const status = require('../actions/generate-idapi-banners-status').main

  test('re-running a failed job refreshes its queue time, so the first status poll wakes no second worker', async () => {
    mockStore.set(key, JSON.stringify(job({ status: 'failed', error: 'x', queuedAt: old, updatedAt: old, createdAt: old, recoveryAt: old })))
    const res = await start(params({ __ow_headers: { authorization: 'Bearer user-tok' } }))
    expect(res.statusCode).toBe(202)
    const stored = JSON.parse(mockStore.get(key))
    expect(stored.status).toBe('queued')
    expect(Date.now() - Date.parse(stored.queuedAt)).toBeLessThan(5000)
    expect(stored.recoveryAt).toBeUndefined()
    expect(global.fetch).toHaveBeenCalledTimes(1) // the start action's own invocation, with the token
    await status({ jobId })
    expect(global.fetch).toHaveBeenCalledTimes(1)
  })

  test('re-running a completed job also refreshes its queue time', async () => {
    mockStore.set(key, JSON.stringify(job({ status: 'completed', queuedAt: old, updatedAt: old, createdAt: old })))
    await start(params({ __ow_headers: { authorization: 'Bearer user-tok' } }))
    expect(Date.now() - Date.parse(JSON.parse(mockStore.get(key)).queuedAt)).toBeLessThan(5000)
  })

  test('a worker woken without the token leaves a just-queued HTML5 job alone, without taking the lock', async () => {
    const queued = JSON.stringify(job({ status: 'queued', queuedAt: new Date().toISOString() }))
    mockStore.set(key, queued)
    const res = await worker.main({ jobId })
    expect(res.body.status).toBe('waiting-for-sign-in')
    expect(mockBatch).not.toHaveBeenCalled()
    expect(mockStore.get(key)).toBe(queued)
    expect(mockStore.has(`${key}-lock`)).toBe(false)
  })

  test('once the token has clearly been lost, the job fails with a start-again message', async () => {
    mockStore.set(key, JSON.stringify(job({ status: 'queued', queuedAt: old })))
    const res = await worker.main({ jobId })
    expect(mockBatch).not.toHaveBeenCalled()
    expect(res.body.status).toBe('failed')
    expect(JSON.parse(mockStore.get(key)).error).toMatch(/sign-in did not reach the HTML5 worker: start HTML5 banners again/)
    expect(mockStore.has(`${key}-lock`)).toBe(false)
  })

  test('later batches (DA pages already written) and DA_TOKEN runs need no user token', async () => {
    mockBatch.mockResolvedValue({ statusCode: 200, body: { batchRows: 0 } })
    mockStore.set(key, JSON.stringify(job({ status: 'queued', rowOffset: 2, html5: { pages: [{ page: 'A' }] }, queuedAt: new Date().toISOString() })))
    expect((await worker.main({ jobId })).body.status).toBe('completed')
    mockBatch.mockResolvedValue({ statusCode: 200, body: { batchRows: 0, html5: { pages: [{ page: 'A' }], warnings: [] } } })
    mockStore.set(key, JSON.stringify(job({ status: 'queued', queuedAt: new Date().toISOString() })))
    expect((await worker.main({ jobId, DA_TOKEN: 'cfg' })).body.status).toBe('completed')
    expect(mockBatch).toHaveBeenCalledTimes(2)
  })
})
