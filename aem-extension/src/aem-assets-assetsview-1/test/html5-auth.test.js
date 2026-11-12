/*
 * HTML5 runs write to Document Authoring as the signed-in user: the start action requires their
 * bearer token, hands it to the worker in the invocation only (never in state), and the worker fails
 * a run that published no DA page instead of reporting it completed.
 */
const mockStore = new Map()
const mockInspect = jest.fn()
const mockBatch = jest.fn()
const mockSite = jest.fn()
const mockAccess = jest.fn()

jest.mock('@adobe/aio-lib-files', () => ({}))
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
  hasFolderAccess: (...args) => mockAccess(...args),
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
  mockAccess.mockReset().mockResolvedValue(true)
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
  expect(res.body.html5Folder).toEqual({ site: 'acme/ads-site', path: '/hgv-template/editorial', daUrl: 'https://da.live/#/acme/ads-site/hgv-template/editorial', animationStyle: 'editorial' })

  mockStore.clear()
  const kinetic = await start(params({ animationStyle: 'kinetic', __ow_headers: { authorization: 'Bearer user-tok' } }))
  expect(kinetic.body.html5Folder).toEqual({ site: 'acme/ads-site', path: '/hgv-template/kinetic', daUrl: 'https://da.live/#/acme/ads-site/hgv-template/kinetic', animationStyle: 'kinetic' })
})

test('a non-HTML5 start requires a user token for folder access, but sends none to the worker', async () => {
  const unauth = await start(params({ mode: 'editable' }))
  expect(unauth.error.statusCode).toBe(401)
  const res = await start(params({ mode: 'editable', __ow_headers: { authorization: 'Bearer user-tok' } }))
  expect(res.statusCode).toBe(202)
  expect(Object.keys(JSON.parse(global.fetch.mock.calls[0][1].body))).toEqual(['jobId'])
})

test('start and status reject callers without access to the job folder (403) or bad folder paths (400)', async () => {
  const status = require('../actions/generate-idapi-banners-status').main
  const badFolder = await start(params({ folder: '/etc/passwd', __ow_headers: { authorization: 'Bearer user-tok' } }))
  expect(badFolder.error.statusCode).toBe(400)
  mockAccess.mockResolvedValue(false)
  const denied = await start(params({ mode: 'images', __ow_headers: { authorization: 'Bearer user-tok' } }))
  expect(denied.error.statusCode).toBe(403)
  const jobId = 'b'.repeat(48)
  mockStore.set(`idapi-job-${jobId}`, JSON.stringify({ stateKey: `idapi-job-${jobId}`, jobId, folder: FOLDER, status: 'running' }))
  expect((await status({ jobId })).error.statusCode).toBe(401)
  expect((await status({ jobId, __ow_headers: { authorization: 'Bearer user-tok' } })).error.statusCode).toBe(403)
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
    await status({ jobId, __ow_headers: { authorization: 'Bearer user-tok' } })
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

test('status reports a running job whose worker stopped updating as failed, without changing it', async () => {
  const status = require('../actions/generate-idapi-banners-status').main
  const jobId = 'a'.repeat(48)
  const old = new Date(Date.now() - 20 * 60 * 1000).toISOString()
  const rec = JSON.stringify({ stateKey: `idapi-job-${jobId}`, jobId, folder: FOLDER, writeHtml5: true, status: 'running', updatedAt: old })
  mockStore.set(`idapi-job-${jobId}`, rec)
  const r = await status({ jobId, __ow_headers: { authorization: 'Bearer user-tok' } })
  expect(r.body).toMatchObject({ status: 'failed', stale: true, error: expect.stringMatching(/Generate again/) })
  expect(mockStore.get(`idapi-job-${jobId}`)).toBe(rec)
  mockStore.set(`idapi-job-${jobId}`, rec.replace(old, new Date().toISOString()))
  expect((await status({ jobId, __ow_headers: { authorization: 'Bearer user-tok' } })).body.status).toBe('running')
})

test('hasFolderAccess verifies HEAD on the AEM folder using the caller token only', async () => {
  const { hasFolderAccess } = jest.requireActual('../actions/generate-idapi-banners/engine')
  global.fetch = jest.fn(async () => ({ ok: true }))
  await expect(hasFolderAccess({ AEM_AUTHOR_URL: 'https://author-p1-e2.adobeaemcloud.com' }, 'caller-tok', '/content/dam/acme/camp')).resolves.toBe(true)
  expect(global.fetch).toHaveBeenCalledWith(
    'https://author-p1-e2.adobeaemcloud.com/api/assets/acme/camp.json',
    { method: 'HEAD', headers: { Authorization: 'Bearer caller-tok' } }
  )
  global.fetch = jest.fn(async () => ({ ok: false, status: 403 }))
  await expect(hasFolderAccess({ AEM_AUTHOR_URL: 'https://author-p1-e2.adobeaemcloud.com' }, 'caller-tok', '/content/dam/acme/camp')).resolves.toBe(false)
  await expect(hasFolderAccess({ AEM_AUTHOR_URL: 'https://author-p1-e2.adobeaemcloud.com' }, '', '/content/dam/acme/camp')).resolves.toBe(false)
  await expect(hasFolderAccess({ AEM_AUTHOR_URL: 'https://author-p1-e2.adobeaemcloud.com' }, 'caller-tok', '/content/dam/../etc')).resolves.toBe(false)
})

test('aemAuthor enforces same-program isolation by default and supports ALLOWED_AEM_AUTHORS', () => {
  const { aemAuthor, isTrustedSliceUrl } = jest.requireActual('../actions/generate-idapi-banners/engine')
  const base = { AEM_AUTHOR_URL: 'https://author-p100-e200.adobeaemcloud.com' }
  // Same Cloud Manager program (p100) across dev/stage/prod is allowed
  expect(aemAuthor({ ...base, aemAuthorUrl: 'https://author-p100-e999.adobeaemcloud.com' }))
    .toBe('https://author-p100-e999.adobeaemcloud.com')
  // Different program (p999) is rejected unless explicitly allowlisted
  expect(() => aemAuthor({ ...base, aemAuthorUrl: 'https://author-p999-e1.adobeaemcloud.com' }))
    .toThrow(/not allowed/)
  expect(aemAuthor({ ...base, ALLOWED_AEM_AUTHORS: 'p999', aemAuthorUrl: 'https://author-p999-e1.adobeaemcloud.com' }))
    .toBe('https://author-p999-e1.adobeaemcloud.com')

  expect(isTrustedSliceUrl('https://admin.da.live/org/site/p/static-0.png')).toBe(true)
  expect(isTrustedSliceUrl('https://main--site--org.aem.page/p/static-0.png')).toBe(true)
  expect(isTrustedSliceUrl('https://delivery-p1-e2.adobeaemcloud.com/adobe/assets/urn:aaid:aem:1/as/x.png')).toBe(true)
  expect(isTrustedSliceUrl('https://evil.example.com/slice.png')).toBe(false)
  expect(isTrustedSliceUrl('http://admin.da.live/slice.png')).toBe(false)
})

test('aemContext mints an OAuth S2S token when AEM_OAUTH_CLIENT_ID and AEM_OAUTH_CLIENT_SECRET are configured', async () => {
  const { aemContext } = jest.requireActual('../actions/generate-idapi-banners/engine')
  global.fetch = jest.fn(async () => ({ ok: true, status: 200, json: async () => ({ access_token: 'oauth-s2s-tok' }) }))
  const ctx = await aemContext({
    AEM_AUTHOR_URL: 'https://author-p1-e2.adobeaemcloud.com',
    AEM_OAUTH_CLIENT_ID: 'cid',
    AEM_OAUTH_CLIENT_SECRET: 'csec',
    IMS_ENDPOINT: 'https://ims.example/token'
  })
  expect(ctx).toEqual({ author: 'https://author-p1-e2.adobeaemcloud.com', aemToken: 'oauth-s2s-tok' })
  expect(global.fetch).toHaveBeenCalledWith('https://ims.example/token', expect.objectContaining({ method: 'POST' }))
})

test('fetchWithRetry retries 429 Too Many Requests and honors Retry-After', async () => {
  const { fetchWithRetry } = jest.requireActual('../actions/generate-idapi-banners/engine')
  let attempts = 0
  global.fetch = jest.fn(async () => {
    attempts++
    if (attempts === 1) return { ok: false, status: 429, headers: { get: (h) => (h === 'retry-after' ? '0.01' : null) } }
    return { ok: true, status: 200 }
  })
  const res = await fetchWithRetry('https://api.example/x', {}, { retries: 2, baseDelayMs: 5 })
  expect(res.status).toBe(200)
  expect(attempts).toBe(2)
})

test('cleanupStaleStaging removes idapi-runs prefixes older than maxAgeMs and keeps fresh ones', async () => {
  const { cleanupStaleStaging } = jest.requireActual('../actions/generate-idapi-banners/engine')
  const now = 1794510000000
  const oldTs = now - 3 * 3600 * 1000
  const freshTs = now - 5 * 60 * 1000
  const deleted = []
  const fakeFiles = {
    list: async () => [
      { name: `idapi-runs/${oldTs}-abc123/template/brand-template.indd` },
      { name: `idapi-runs/${oldTs}-abc123/input/pagemap.csv` },
      { name: `idapi-runs/${freshTs}-def456/template/brand-template.indd` }
    ],
    delete: async (p) => { deleted.push(p) }
  }
  const count = await cleanupStaleStaging(fakeFiles, now)
  expect(count).toBe(1)
  expect(deleted).toEqual([`idapi-runs/${oldTs}-abc123/`])
})
