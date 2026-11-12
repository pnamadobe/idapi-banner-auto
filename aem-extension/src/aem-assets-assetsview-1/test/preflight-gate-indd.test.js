/*
 * INDD template gate: the registered InDesign capability script checks the template (labels, pages,
 * fonts, links, missing images) on the first batch and reports "PREFLIGHT:[...]" as its failure, or
 * echoes warnings in result.json. Every network call is faked.
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
const PAGEMAP = 'pagenumber,pagename\n1,A\n2,B\n'
const entity = (name) => ({ properties: { name }, class: ['asset'] })

let calls
let execBodies
// `status` is what the capability's status endpoint returns; `resultJson` is served for result.json.
function fakeAem (status, resultJson = {}) {
  const files = {
    [`${FOLDER}/template.indd`]: 'INDD',
    [`${FOLDER}/variations.csv`]: CSV,
    [`${FOLDER}/pagemap.csv`]: PAGEMAP,
    [`${FOLDER}/one.jpg`]: 'JPG'
  }
  global.fetch = jest.fn(async (url, opts) => {
    url = String(url)
    calls.push(url)
    const ok = (body) => ({ ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body), arrayBuffer: async () => Buffer.from(typeof body === 'string' ? body : JSON.stringify(body)) })
    if (url.startsWith(`${AUTHOR}/api/assets/x.json`)) return ok({ entities: ['template.indd', 'variations.csv', 'pagemap.csv', 'one.jpg'].map(entity) })
    if (url.startsWith(`${AUTHOR}/api/assets/`)) return { ok: false, status: 404 }
    if (url.startsWith(AUTHOR)) {
      const body = files[decodeURIComponent(url.slice(AUTHOR.length))]
      return body === undefined ? { ok: false, status: 404 } : ok(body)
    }
    if (url === 'https://ims.example/token') return ok({ access_token: 'tok' })
    if (url === 'https://id.example/v3/execute') {
      execBodies.push(JSON.parse(opts.body))
      return { status: 202, text: async () => JSON.stringify({ statusUrl: 'https://id.example/status/1' }) }
    }
    if (url === 'https://id.example/status/1') return ok(status)
    if (url === 'https://id.example/out/result.json') return ok(resultJson)
    throw new Error(`unexpected fetch ${url}`)
  })
}

const FAILED = (errors) => ({ status: 'failed', errors })
const SUCCEEDED = { status: 'succeeded', outputs: [{ source: 'result.json', destination: { url: 'https://id.example/out/result.json' } }] }
const finding = (over) => ({ severity: 'error', code: 'INDD_IMG_MISSING', message: 'row 2: hero "nope.jpg" was not found', rows: [2], column: 'hero', ...over })

const params = (extra) => ({
  AEM_DEV_TOKEN: 'aem',
  aemAuthorUrl: AUTHOR,
  folder: FOLDER,
  template: 'template.indd',
  FFS_CLIENT_ID: 'id',
  FFS_CLIENT_SECRET: 'secret',
  IMS_ENDPOINT: 'https://ims.example/token',
  INDESIGN_EXECUTE_URL: 'https://id.example/v3/execute',
  ...extra
})
const job = () => ({ stateKey: 'idapi-job-abc', jobId: 'abc', outputFolder: `${FOLDER}/output/stamp`, outputs: [] })

beforeEach(() => {
  calls = []
  execBodies = []
  mockFilesDelete.mockClear()
  jest.spyOn(global, 'setTimeout').mockImplementation((fn) => { fn(); return 0 })
})
afterEach(() => jest.restoreAllMocks())

test('a PREFLIGHT failure from the capability becomes job findings and a readable error; nothing is written', async () => {
  const payload = [finding(), finding({ code: 'INDD_FONT_MISSING', message: 'font "Foo Bold" is missing', rows: undefined, column: undefined })]
  fakeAem(FAILED([{ message: `PREFLIGHT:${JSON.stringify(payload)}` }]))
  const state = { put: jest.fn(async () => {}) }
  const j = job()
  const res = await processBatch(params(), j, state)
  expect(res.error.statusCode).toBe(500)
  expect(res.error.body.error).toMatch(/Preflight found 2 problems/)
  expect(res.error.body.error).toMatch(/nope\.jpg/)
  expect(j.findings.map((f) => f.code)).toEqual(['INDD_IMG_MISSING', 'INDD_FONT_MISSING'])
  expect(j.findings[0]).toMatchObject({ severity: 'error', row: 2, column: 'hero' })
  expect(JSON.parse(state.put.mock.calls[0][1]).findings).toEqual(j.findings)
  expect(calls.some((u) => u.startsWith(AUTHOR) && u.includes('/output'))).toBe(false)
  expect(mockFilesDelete).toHaveBeenCalledTimes(1)
  expect(mockFilesDelete.mock.calls[0][0]).toMatch(/^idapi-runs\/[^/]+\/$/)
})

test('the gate is requested on the first batch, with the override only when set', async () => {
  fakeAem(SUCCEEDED)
  await processBatch(params(), job(), null)
  expect(execBodies[0].params).toMatchObject({ preflightGate: '1' })
  expect(execBodies[0].params).not.toHaveProperty('preflightOverride')

  await processBatch(params({ preflightOverride: '1' }), job(), null)
  expect(execBodies[1].params).toMatchObject({ preflightGate: '1', preflightOverride: '1' })
})

test('a later batch (rowOffset > 0) does not ask for the template checks again', async () => {
  fakeAem(SUCCEEDED)
  await processBatch(params({ rowOffset: '1', maxRows: '1', preflightOverride: '1' }), job(), null)
  expect(execBodies[0].params).not.toHaveProperty('preflightGate')
  expect(execBodies[0].params).not.toHaveProperty('preflightOverride')
})

test('findings the capability echoes on success (overridden errors, warnings) are merged onto the job', async () => {
  const warn = finding({ severity: 'warn', code: 'INDD_FONT_UNKNOWN', message: 'font "Bar" could not be verified', rows: undefined, column: undefined })
  fakeAem(SUCCEEDED, { preflight: { facts: {}, findings: [warn, finding(), { code: 'CSV_BOM', severity: 'error', message: 'not ours' }] } })
  const state = { put: jest.fn(async () => {}) }
  const stage1 = { severity: 'warn', code: 'CELL_EMPTY', message: 'row 3: cta is empty', row: 3, column: 'cta' }
  const j = { ...job(), findings: [stage1] }
  const res = await processBatch(params({ preflightOverride: '1' }), j, state)
  expect(res.statusCode).toBe(200)
  expect(j.findings.map((f) => f.code)).toEqual(['INDD_IMG_MISSING', 'CELL_EMPTY', 'INDD_FONT_UNKNOWN'])
})

test('a malformed or foreign payload falls back to the generic render error', async () => {
  for (const errors of [[{ message: 'PREFLIGHT:[{"code": ' }], [{ message: 'PREFLIGHT:[{"severity":"error","code":"CSV_BOM","message":"x"}]' }], 'script exploded']) {
    fakeAem(FAILED(errors))
    const j = job()
    const res = await processBatch(params(), j, { put: jest.fn(async () => {}) })
    expect(res.error.statusCode).toBe(500)
    expect(res.error.body.error).toMatch(/render failed/)
    expect(res.error.body.error).not.toMatch(/Preflight found/)
    expect(j.findings).toBeUndefined()
  }
})
