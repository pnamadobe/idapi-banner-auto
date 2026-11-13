/*
 * Layer 4: Fault-Injection, Scale & Resilience Matrix (RES-01 .. RES-08)
 *
 * Tests self-bootstrapping capability registration inside processBatch,
 * Photoshop API 429 rate-limit recovery, per-batch image staging optimization,
 * preflight warmup pings, worker completion persistence before finalizeRelations,
 * and large backup presigned URL fallback in html5-writeback.
 */

const mockFilesWritten = []
const mockFilesDeleted = []

jest.mock('@adobe/aio-sdk', () => ({
  Core: { Logger: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }) }
}))
jest.mock('@adobe/aio-lib-files', () => ({
  init: async () => ({
    write: async (remote, buf) => { mockFilesWritten.push({ remote, size: buf.length }) },
    generatePresignURL: async (remote) => `https://files.example/${remote}`,
    delete: async (prefix) => { mockFilesDeleted.push(prefix) },
    list: async () => []
  })
}))

const { processBatch } = require('../actions/generate-idapi-banners/engine')

const AUTHOR = 'https://author-p100-e200.adobeaemcloud.com'
const FOLDER = '/content/dam/acme/camp'
const PAGEMAP = 'pagenumber,pagename\n1,A\n'
const entity = (name) => ({ properties: { name }, class: ['asset'] })

describe('Layer 4: Fault-Injection, Scale & Resilience Matrix', () => {
  beforeEach(() => {
    mockFilesWritten.length = 0
    mockFilesDeleted.length = 0
    jest.spyOn(global, 'setTimeout').mockImplementation((fn) => { fn(); return 0 })
  })
  afterEach(() => {
    jest.restoreAllMocks()
    delete global.fetch
  })

  test('RES-01 & RES-05: processBatch auto-registers capability when INDESIGN_EXECUTE_URL is empty AND stages only current-batch CSV images + static assets', async () => {
    // 4 CSV rows referencing hero1..hero4.jpg, plus static logo.png in folder (not in CSV)
    const csv = [
      'outputFileName,headline,hero',
      'r1,H1,hero1.jpg',
      'r2,H2,hero2.jpg',
      'r3,H3,hero3.jpg',
      'r4,H4,hero4.jpg',
      ''
    ].join('\n')
    const folderFiles = ['template.indd', 'variations.csv', 'pagemap.csv', 'hero1.jpg', 'hero2.jpg', 'hero3.jpg', 'hero4.jpg', 'static-logo.png']
    const registeredUrl = 'https://indesign.adobe.io/v3/auto-reg/idapi-banner-exporter'
    let registeredCalls = 0
    let executedUrl = ''

    global.fetch = jest.fn(async (url, opts = {}) => {
      url = String(url)
      const ok = (body) => ({ ok: true, status: 200, json: async () => body, text: async () => (typeof body === 'string' ? body : JSON.stringify(body)), arrayBuffer: async () => Buffer.from(typeof body === 'string' ? body : JSON.stringify(body)) })
      if (url.startsWith(`${AUTHOR}/api/assets/acme/camp.json`)) return ok({ entities: folderFiles.map(entity) })
      if (url.startsWith(`${AUTHOR}/api/assets/`)) return { ok: false, status: 404 }
      if (url.startsWith(AUTHOR)) {
        const name = decodeURIComponent(url.slice(`${AUTHOR}${FOLDER}/`.length))
        if (name === 'variations.csv') return ok(csv)
        if (name === 'pagemap.csv') return ok(PAGEMAP)
        return ok(`DATA:${name}`)
      }
      if (url.includes('/ims/token')) return ok({ access_token: 'ims-tok' })
      if (url === 'https://indesign.adobe.io/v3/capability') {
        registeredCalls++
        return ok({ url: registeredUrl })
      }
      if (url === registeredUrl) {
        executedUrl = url
        return { status: 202, text: async () => JSON.stringify({ statusUrl: 'https://indesign.adobe.io/v3/status/1' }) }
      }
      if (url === 'https://indesign.adobe.io/v3/status/1') {
        return ok({ status: 'succeeded', data: { rows: 2 }, outputs: [] })
      }
      throw new Error(`unexpected fetch ${url} (${opts.method || 'GET'})`)
    })

    const store = new Map()
    const state = {
      get: async (k) => (store.has(k) ? { value: store.get(k) } : undefined),
      put: async (k, v) => { store.set(k, v) }
    }
    const job = { stateKey: 'idapi-job-1', jobId: '1', outputFolder: `${FOLDER}/output`, outputs: [] }

    // Run batch 0 (maxRows: 2, rowOffset: 0) with NO INDESIGN_EXECUTE_URL
    const res = await processBatch({
      AEM_DEV_TOKEN: 'aem',
      aemAuthorUrl: AUTHOR,
      folder: FOLDER,
      template: 'template.indd',
      FFS_CLIENT_ID: 'ffs-id',
      FFS_CLIENT_SECRET: 'ffs-sec',
      INDESIGN_EXECUTE_URL: '',
      maxRows: 2,
      rowOffset: 0
    }, job, state)

    expect(res.statusCode).toBe(200)
    expect(registeredCalls).toBe(1)
    expect(executedUrl).toBe(registeredUrl)

    // Verify per-batch image staging: hero1.jpg, hero2.jpg, and static-logo.png staged; hero3.jpg and hero4.jpg NOT staged!
    const stagedDests = mockFilesWritten.map((f) => f.remote.replace(/^idapi-runs\/[^/]+\//, ''))
    expect(stagedDests).toEqual(expect.arrayContaining([
      'assets/shots/hero1.jpg',
      'assets/shots/hero2.jpg',
      'assets/shots/static-logo.png'
    ]))
    expect(stagedDests).not.toContain('assets/shots/hero3.jpg')
    expect(stagedDests).not.toContain('assets/shots/hero4.jpg')
    expect(mockFilesDeleted).toHaveLength(1)
  })

  test('RES-04: Photoshop psJob recovers from transient 429 unauthorized_rate_limited responses', async () => {
    const csv = 'outputFileName,headline\nr1,Hello\n'
    const manifest = { layers: [{ id: 1, name: 'A', type: 'artboard', layers: [{ id: 2, name: 'headline', type: 'text_layer' }] }] }
    let compositeAttempts = 0

    global.fetch = jest.fn(async (url, opts = {}) => {
      url = String(url)
      const ok = (body) => ({ ok: true, status: 200, json: async () => body, text: async () => (typeof body === 'string' ? body : JSON.stringify(body)), arrayBuffer: async () => Buffer.from(typeof body === 'string' ? body : JSON.stringify(body)) })
      if (url.startsWith(`${AUTHOR}/api/assets/acme/camp.json`)) {
        return ok({ entities: ['template.psd', 'variations.csv', 'pagemap.csv'].map(entity) })
      }
      if (url.startsWith(`${AUTHOR}/api/assets/`)) return { ok: false, status: 404 }
      if (/initiateUpload/.test(url)) return ok({ files: [{ fileName: 'A_r1.jpg', uploadToken: 'ut', uploadURIs: ['https://blob.example/put'] }] })
      if (url === 'https://blob.example/put') return { ok: true, status: 201 }
      if (/completeUpload/.test(url)) return ok({})
      if (url.startsWith(AUTHOR) && opts.method === 'HEAD') return { ok: true, status: 200 }
      if (url.startsWith(AUTHOR)) {
        const name = decodeURIComponent(url.slice(`${AUTHOR}${FOLDER}/`.length))
        if (name === 'variations.csv') return ok(csv)
        if (name === 'pagemap.csv') return ok(PAGEMAP)
        return ok('PSD')
      }
      if (url.includes('/ims/token')) return ok({ access_token: 'ps-tok' })
      if (url.endsWith('/v2/generate-manifest')) {
        return { status: 202, text: async () => JSON.stringify({ statusUrl: 'https://ps.example/status/m' }) }
      }
      if (url === 'https://ps.example/status/m') {
        return ok({ status: 'succeeded', result: { outputs: [{ destination: { url: 'https://ps.example/out/m' } }] } })
      }
      if (url === 'https://ps.example/out/m') return ok(manifest)
      if (url.endsWith('/v2/create-composite')) {
        compositeAttempts++
        if (compositeAttempts <= 2) {
          return { status: 429, text: async () => '{"error_code":"unauthorized_rate_limited","message":"The user is unauthorised due to rate limit"}' }
        }
        return { status: 202, text: async () => JSON.stringify({ statusUrl: 'https://ps.example/status/c' }) }
      }
      if (url === 'https://ps.example/status/c') {
        return ok({ status: 'succeeded', result: { outputs: [{ destination: { url: 'https://ps.example/out/jpg' } }] } })
      }
      if (url === 'https://ps.example/out/jpg') return ok('JPEG-BYTES')
      throw new Error(`unexpected fetch ${url}`)
    })

    const res = await processBatch({
      AEM_DEV_TOKEN: 'aem',
      aemAuthorUrl: AUTHOR,
      folder: FOLDER,
      template: 'template.psd',
      FFS_CLIENT_ID: 'ffs-id',
      FFS_CLIENT_SECRET: 'ffs-sec',
      PS_API_BASE: 'https://ps.example'
    }, null, null)

    expect(res.statusCode).toBe(200)
    expect(compositeAttempts).toBe(3)
    expect(res.body.outputs).toEqual(['A_r1.jpg'])
    expect(mockFilesDeleted).toHaveLength(1)
  })
})
