/*
 * The writeback endpoint the public packaging workflow calls: token binding, the per-ad file
 * allowlist and the backup read restriction. State is faked; AEM is a fetch mock.
 */
const mockStore = new Map()
jest.mock('@adobe/aio-lib-state', () => ({
  init: async () => ({
    get: async (k) => (mockStore.has(k) ? { value: mockStore.get(k) } : undefined),
    put: async (k, v) => { mockStore.set(k, v) }
  })
}))
jest.mock('@adobe/aio-lib-files', () => ({ init: async () => ({}) }))
jest.mock('@adobe/aio-sdk', () => ({
  Core: { Logger: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }) }
}))

const { main } = require('../actions/html5-writeback')
const pkg = require('../actions/generate-idapi-banners/package')

const SECRET = 's'.repeat(40)
const AUTHOR = 'https://author-p1-e2.adobeaemcloud.com'
const JOB = 'a'.repeat(48)
const OUT = '/content/dam/x/output/stamp'
const ad = { page: 'MedRect_300x250', path: '/ads/c/medrect-300x250', row: 'Spring', budgetKB: 150, name: 'MedRect_300x250_Spring', backup: 'MedRect_300x250_Spring.jpg' }
const files = [
  { name: `${ad.name}.zip`, mime: 'application/zip', size: 1000 },
  { name: `${ad.name}_preview.gif`, mime: 'image/gif', size: 500 },
  { name: `${ad.name}_storyboard.jpg`, mime: 'image/jpeg', size: 800 }
]

let calls
beforeEach(() => {
  mockStore.clear()
  mockStore.set(`idapi-job-${JOB}`, JSON.stringify({ jobId: JOB, folder: '/content/dam/x', outputFolder: OUT, template: 't.indd', aemAuthorUrl: AUTHOR }))
  mockStore.set(`idapi-pkg-${JOB}`, JSON.stringify({ jobId: JOB, run: 'run1', outFolder: OUT, ads: [ad], results: {}, status: 'running' }))
  calls = []
  global.fetch = jest.fn(async (url, opts = {}) => {
    const method = opts.method || 'GET'
    calls.push(`${method} ${url}`)
    if (/initiateUpload/.test(url)) {
      const name = new URLSearchParams(opts.body.toString()).get('fileName')
      return { ok: true, status: 200, text: async () => JSON.stringify({ files: [{ fileName: name, uploadToken: `tok-${name}`, uploadURIs: ['https://blob/x'] }] }) }
    }
    if (/\.1\.json$/.test(url)) return { ok: true, status: 200, json: async () => ({ 'jcr:uuid': '11111111-2222-3333-4444-555555555555' }) }
    if (/\/relations$/.test(url)) return { ok: true, status: 200, json: async () => ({ items: [] }) }
    if (/\.jpg$/.test(url) && method === 'GET') return { ok: true, status: 200, arrayBuffer: async () => Buffer.from('JPEG') }
    return { ok: true, status: 200, text: async () => '', json: async () => ({ entities: [] }), arrayBuffer: async () => Buffer.from('') }
  })
})
afterEach(() => { delete global.fetch })

const token = (claims = {}) => pkg.mintToken(SECRET, { job: JOB, run: 'run1', outFolder: OUT, template: 't.indd', ...claims })
const call = (body) => main({ HTML5_WRITEBACK_SECRET: SECRET, AEM_DEV_TOKEN: 'aem', __ow_method: 'post', token: token(), ...body })
const pkgRec = () => JSON.parse(mockStore.get(`idapi-pkg-${JOB}`))

test('rejects a bad token or one from an older run', async () => {
  expect((await call({ op: 'done', token: 'junk' })).error.statusCode).toBe(401)
  expect((await call({ op: 'done', token: token({ run: 'old' }) })).error.statusCode).toBe(401)
  expect((await call({ op: 'done', token: token({ outFolder: '/content/dam/other' }) })).error.statusCode).toBe(401)
})

test('backup returns only the run\'s own backup images, and uses a presigned URL when large or requested', async () => {
  const r = await call({ op: 'backup', file: ad.backup })
  expect(Buffer.from(r.body.data, 'base64').toString()).toBe('JPEG')
  expect(calls).toContain(`GET ${AUTHOR}${OUT}/${ad.backup}`)
  expect((await call({ op: 'backup', file: 'Other.jpg' })).error.statusCode).toBe(403)
  expect((await call({ op: 'backup', file: '../secret.jpg' })).error.statusCode).toBe(403)
})

test('initiate allows exactly the expected files into html5/cm360', async () => {
  const r = await call({ op: 'initiate', ad: 0, files })
  expect(r.body.files.map((f) => f.uploadToken)).toEqual(files.map((f) => `tok-${f.name}`))
  expect(calls.filter((c) => /initiateUpload/.test(c)).every((c) => c.includes(`${OUT}/html5/cm360.initiateUpload.json`))).toBe(true)
  const bad = async (fs, ad0 = 0) => (await call({ op: 'initiate', ad: ad0, files: fs })).error.statusCode
  expect(await bad([...files.slice(0, 2), { name: 'evil.html', mime: 'text/html', size: 1 }])).toBe(400)
  expect(await bad(files.slice(0, 2))).toBe(400)
  expect(await bad([{ ...files[0], mime: 'text/html' }, ...files.slice(1)])).toBe(400)
  expect(await bad([{ ...files[0], size: 60 * 1024 * 1024 }, ...files.slice(1)])).toBe(400)
  expect(await bad(files, 1)).toBe(400)
  expect(await bad(files, '0')).toBe(400)
})

test('complete finishes uploads, writes metadata and records the result', async () => {
  const done = files.map((f) => ({ ...f, uploadToken: `tok-${f.name}` }))
  const r = await call({ op: 'complete', ad: 0, files: done, report: { bytes: 1000, budgetKB: 150, step: 0, over: false, fidelity: { verdict: 'pass', score: 0.99 } } })
  expect(r.body.ok).toBe(true)
  expect(calls.filter((c) => /completeUpload/.test(c))).toHaveLength(3)
  expect(calls).toContain(`PUT ${AUTHOR}/api/assets/x/output/stamp/html5/cm360/${ad.name}.zip`)
  expect(calls.some((c) => /^POST .*\/relations$/.test(c))).toBe(true)
  expect(pkgRec().results[0]).toMatchObject({ name: ad.name, ok: true, bytes: 1000, fidelity: 'pass', overBudget: false })
  expect((await call({ op: 'complete', ad: 0, files: files })).error.statusCode).toBe(400)
})

test('a failed ad is recorded without uploads, and done closes the run', async () => {
  await call({ op: 'complete', ad: 0, files: [], report: { error: { code: 'RENDER', message: 'boom' } } })
  expect(pkgRec().results[0]).toEqual({ name: ad.name, ok: false, error: { code: 'RENDER', message: 'boom' } })
  await call({ op: 'done', failed: 1 })
  expect(pkgRec()).toMatchObject({ status: 'done', failed: 1 })
  expect((await call({ op: 'backup', file: ad.backup })).error.statusCode).toBe(409)
})
