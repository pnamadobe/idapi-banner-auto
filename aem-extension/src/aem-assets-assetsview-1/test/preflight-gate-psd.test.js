/*
 * PSD stage-2 gate: the template-aware checks run on the first batch, after the manifest is read
 * and before any create-composite call (the paid render). Every network call is faked.
 */
const mockFilesDelete = jest.fn(async () => {})
jest.mock('@adobe/aio-sdk', () => ({
  Core: { Logger: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }) }
}))
jest.mock('@adobe/aio-lib-files', () => ({
  init: async () => ({
    write: async () => {},
    generatePresignURL: async (remote) => `https://files.example/${remote}`,
    delete: (...args) => mockFilesDelete(...args)
  })
}))

const { processBatch } = require('../actions/generate-idapi-banners/engine')

const AUTHOR = 'https://author-p1-e1.adobeaemcloud.com'
const FOLDER = '/content/dam/x'
const CSV = 'outputFileName,status,cta,hero\na,Now,Go,one.jpg\n'
const layer = (id, name, type, extra) => ({ id, name, type, ...extra })
const board = (id, name) => layer(id, name, 'artboard', {
  layers: [layer(id + 1, 'status', 'text_layer'), layer(id + 2, 'cta', 'text_layer'), layer(id + 3, 'hero', 'smart_object_layer')]
})
const MANIFEST = { layers: [board(10, 'A'), board(20, 'B')] }
const entity = (name) => ({ properties: { name }, class: ['asset'] })

let calls
function fakeAem (pagemap, csv = CSV) {
  const files = {
    [`${FOLDER}/template.psd`]: 'PSD',
    [`${FOLDER}/variations.csv`]: csv,
    [`${FOLDER}/pagemap.csv`]: pagemap,
    [`${FOLDER}/one.jpg`]: 'JPG'
  }
  global.fetch = jest.fn(async (url) => {
    url = String(url)
    calls.push(url)
    const ok = (body) => ({ ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body), arrayBuffer: async () => Buffer.from(typeof body === 'string' ? body : JSON.stringify(body)) })
    if (url.startsWith(`${AUTHOR}/api/assets/x.json`)) return ok({ entities: ['template.psd', 'variations.csv', 'pagemap.csv', 'one.jpg'].map(entity) })
    if (url.startsWith(`${AUTHOR}/api/assets/`)) return { ok: false, status: 404 }
    if (url.startsWith(AUTHOR)) {
      const body = files[decodeURIComponent(url.slice(AUTHOR.length))]
      return body === undefined ? { ok: false, status: 404 } : ok(body)
    }
    if (url === 'https://ims.example/token') return ok({ access_token: 'tok' })
    if (url.endsWith('/v2/generate-manifest')) return { status: 202, text: async () => JSON.stringify({ statusUrl: 'https://ps.example/status/manifest' }) }
    if (url.endsWith('/v2/create-composite')) return { status: 500, text: async () => 'boom' }
    if (url === 'https://ps.example/status/manifest') return ok({ status: 'succeeded', result: { outputs: [{ destination: { url: 'https://ps.example/out/manifest' } }] } })
    if (url === 'https://ps.example/out/manifest') return ok(JSON.stringify(MANIFEST))
    throw new Error(`unexpected fetch ${url}`)
  })
}

const params = (extra) => ({
  AEM_DEV_TOKEN: 'aem',
  aemAuthorUrl: AUTHOR,
  folder: FOLDER,
  template: 'template.psd',
  FFS_CLIENT_ID: 'id',
  FFS_CLIENT_SECRET: 'secret',
  IMS_ENDPOINT: 'https://ims.example/token',
  PS_API_BASE: 'https://ps.example',
  ...extra
})
const job = () => ({ stateKey: 'idapi-job-abc', jobId: 'abc', outputFolder: `${FOLDER}/output/stamp`, outputs: [] })
const composites = () => calls.filter((u) => u.endsWith('/v2/create-composite'))

beforeEach(() => {
  calls = []
  mockFilesDelete.mockClear()
  jest.spyOn(global, 'setTimeout').mockImplementation((fn) => { fn(); return 0 })
})
afterEach(() => jest.restoreAllMocks())

test('a pagemap naming an artboard the PSD lacks fails before any composite call, with findings on the job', async () => {
  fakeAem('pagenumber,pagename\n1,A\n2,C\n')
  const state = { put: jest.fn(async () => {}) }
  const j = job()
  const res = await processBatch(params(), j, state)
  expect(res.error.statusCode).toBe(500)
  expect(res.error.body.error).toMatch(/Preflight found/)
  expect(res.error.body.error).toMatch(/\bC\b/)
  expect(calls.some((u) => u.endsWith('/v2/generate-manifest'))).toBe(true)
  expect(composites()).toHaveLength(0)
  expect(j.findings.map((f) => f.code)).toContain('PSD_PAGEMAP_MISSING')
  expect(state.put).toHaveBeenCalledTimes(1)
  expect(JSON.parse(state.put.mock.calls[0][1]).findings).toEqual(j.findings)
  expect(mockFilesDelete).toHaveBeenCalledTimes(1)
  expect(mockFilesDelete.mock.calls[0][0]).toMatch(/^idapi-runs\/[^/]+\/$/)
})

test('a CSV column with no matching layer fails the gate; preflightOverride=1 lets it through to the render', async () => {
  const csv = 'outputFileName,status,cta,hero,bogus\na,Now,Go,one.jpg,x\n'
  fakeAem('pagenumber,pagename\n1,A\n2,B\n', csv)
  const blocked = await processBatch(params(), job(), null)
  expect(blocked.error.body.error).toMatch(/Preflight found/)
  expect(composites()).toHaveLength(0)

  const forced = await processBatch(params({ preflightOverride: '1' }), job(), null)
  expect(composites().length).toBeGreaterThan(0)
  expect(forced.error.body.error).not.toMatch(/Preflight found/)
})

test('a later batch (rowOffset > 0) does not repeat the template checks', async () => {
  fakeAem('pagenumber,pagename\n1,A\n2,C\n')
  const res = await processBatch(params({ rowOffset: '1', maxRows: '1' }), job(), null)
  expect(res.error.body.error).not.toMatch(/Preflight found/)
})

test('a CSV that matches the template passes the gate and reaches the render', async () => {
  fakeAem('pagenumber,pagename\n1,A\n2,B\n')
  const res = await processBatch(params(), job(), null)
  expect(composites().length).toBeGreaterThan(0)
  expect(res.error.body.error).not.toMatch(/Preflight found/)
})
