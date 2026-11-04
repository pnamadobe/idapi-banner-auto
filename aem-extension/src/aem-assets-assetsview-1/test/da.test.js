const da = require('../actions/generate-idapi-banners/da')
const { daConfig } = require('../actions/generate-idapi-banners/html5')

const AUTHOR = 'https://author-p1-e2.adobeaemcloud.com'
const cfg = daConfig({})
const PAGEMAP = 'pagenumber,pagename,html5,motion\n1,MedRect_300x250,yes,headline:fadeUp\n2,Leader_728x90,no,\n'
const CSV = 'outputFileName,headline,hero,clickthrough\nSpring,Hi,hero.jpg,https://example.com\n'
const MANIFEST = {
  MedRect_300x250: {
    width: 300,
    height: 250,
    slices: [{ name: 'static-0', z: 0 }],
    elements: [{ label: 'headline', kind: 'text', z: 1, box: { x: 0, y: 0, w: 10, h: 10 }, style: {} }]
  }
}

function mockFetch (routes) {
  const calls = []
  global.fetch = jest.fn(async (url, opts = {}) => {
    const method = opts.method || 'GET'
    calls.push({ url, method, opts })
    for (const [re, res] of routes) {
      if (re.test(`${method} ${url}`)) return typeof res === 'function' ? res(url, opts) : res
    }
    return { ok: true, status: 200, text: async () => '', json: async () => ({}) }
  })
  return calls
}
const ok = (body) => ({ ok: true, status: 200, text: async () => (typeof body === 'string' ? body : JSON.stringify(body)), json: async () => body })
const status = (s) => ({ ok: false, status: s, text: async () => '', json: async () => ({}) })

function ctx (extra = {}) {
  const store = new Map()
  return {
    cfg,
    daToken: 'da',
    edsToken: '',
    author: AUTHOR,
    aemToken: 'aem',
    outFolder: '/content/dam/c/output',
    folder: '/content/dam/c',
    campaign: 'Spring',
    manifest: MANIFEST,
    pagemapText: PAGEMAP,
    csvText: CSV,
    slices: new Map([['MedRect_300x250/static-0.png', 'https://out.example/s0.png']]),
    imageSource: new Map(),
    state: { get: async (k) => (store.has(k) ? { value: store.get(k) } : undefined), put: async (k, v) => store.set(k, v) },
    deps: { upload: jest.fn(async () => {}), assetId: jest.fn(async (p) => `urn:aaid:aem:${p.split('/').pop()}`), fetchBuf: async () => Buffer.alloc(1000) },
    ...extra
  }
}

afterEach(() => { delete global.fetch })

test('deliveryUrl and sliceOf', () => {
  expect(da.deliveryUrl(AUTHOR, 'urn:aaid:aem:1', 'a b.png')).toBe('https://delivery-p1-e2.adobeaemcloud.com/adobe/assets/urn:aaid:aem:1/as/a%20b.png')
  expect(da.sliceOf('https://x/y/output/html5/MedRect_300x250/static-2.png?sig=1')).toEqual({ page: 'MedRect_300x250', file: 'static-2.png' })
  expect(da.sliceOf('output/Spring_MedRect.jpg')).toBeNull()
})

test('daGet/daPut: 404 is null, 403 is no-access, PUT sends multipart data', async () => {
  const calls = mockFetch([[/GET .*missing/, status(404)], [/GET .*secret/, status(403)]])
  expect(await da.daGet(cfg, 't', '/ads/missing.html')).toBeNull()
  await expect(da.daGet(cfg, 't', '/ads/secret.html')).rejects.toMatchObject({ code: 'HTML5_DA_NO_ACCESS' })
  await da.daPut(cfg, 't', '/ads/a b.html', '<body></body>', 'text/html')
  const put = calls.at(-1)
  expect(put.url).toBe('https://admin.da.live/source/pnamadobe/banner-ads/ads/a%20b.html')
  expect(put.opts.headers['Content-Type']).toMatch(/^multipart\/form-data; boundary=/)
  expect(put.opts.body.toString()).toMatch(/name="data"; filename="a b.html"\r\nContent-Type: text\/html\r\n\r\n<body><\/body>\r\n--/)
})

test('publishHtml5 happy path writes sheet, page, previews and approves slices', async () => {
  const calls = mockFetch([[/metadata\.json/, ok({ 'dam:status': 'approved' })], [/GET https:\/\/admin\.da\.live/, status(404)]])
  const c = ctx()
  const r = await da.publishHtml5(c)
  expect(r.warnings).toEqual([])
  expect(r.pages).toEqual([{ page: 'MedRect_300x250', path: '/ads/spring/medrect-300x250', previewUrl: 'https://main--banner-ads--pnamadobe.aem.page/ads/spring/medrect-300x250', rows: 1 }])
  const puts = calls.filter((x) => x.method === 'PUT' && /admin\.da\.live/.test(x.url)).map((x) => x.url)
  expect(puts).toEqual(['https://admin.da.live/source/pnamadobe/banner-ads/ads/spring/variations.json', 'https://admin.da.live/source/pnamadobe/banner-ads/ads/spring/medrect-300x250.html'])
  expect(calls.filter((x) => /admin\.hlx\.page\/preview/.test(x.url))).toHaveLength(2)
  expect(calls.some((x) => x.method === 'PUT' && /\/api\/assets\/c\/output\/html5\/assets\/medrect-300x250\/static-0\.png$/.test(x.url))).toBe(true)
  expect(c.deps.upload).toHaveBeenCalledWith('/content/dam/c/output/html5/assets/medrect-300x250', 'static-0.png', expect.any(Buffer), 'image/png')
  const sheetBody = /\r\n\r\n([\s\S]*)\r\n--/.exec(calls.find((x) => /variations\.json$/.test(x.url) && x.method === 'PUT').opts.body.toString())[1]
  expect(JSON.parse(sheetBody).data[0].hero).toBe('https://delivery-p1-e2.adobeaemcloud.com/adobe/assets/urn:aaid:aem:hero.jpg/as/hero.jpg')
})

test('publishHtml5 leaves a sheet edited in DA alone', async () => {
  const edited = { ':type': 'sheet', data: [{ outputFileName: 'Spring', headline: 'Edited in DA' }] }
  const calls = mockFetch([[/metadata\.json/, ok({ 'dam:status': 'approved' })], [/GET .*variations\.json/, ok(edited)], [/GET https:\/\/admin\.da\.live/, status(404)]])
  const r = await da.publishHtml5(ctx())
  expect(r.warnings.map((w) => w.code)).toEqual(['HTML5_SHEET_EDITED'])
  expect(calls.some((x) => x.method === 'PUT' && /variations\.json$/.test(x.url))).toBe(false)
  expect(r.pages).toHaveLength(1)
})

test('publishHtml5 stops early without DA access and flags unapproved images', async () => {
  mockFetch([[/metadata\.json/, ok({ 'dam:status': 'draft' })], [/admin\.da\.live/, status(401)]])
  const r = await da.publishHtml5(ctx())
  expect(r.warnings.map((w) => w.code)).toEqual(['HTML5_ASSET_NOT_DELIVERABLE', 'HTML5_DA_NO_ACCESS'])
  expect(r.pages).toEqual([])
})

test('publishHtml5 with no html5 pages', async () => {
  mockFetch([])
  const r = await da.publishHtml5(ctx({ pagemapText: 'pagenumber,pagename,html5\n1,A,no\n' }))
  expect(r.warnings.map((w) => w.code)).toEqual(['HTML5_NO_PAGES'])
})

test('publishHtml5 without any DA token writes nothing and says why', async () => {
  const calls = mockFetch([])
  const r = await da.publishHtml5(ctx({ daToken: '' }))
  expect(r.warnings.map((w) => w.code)).toEqual(['HTML5_DA_NO_ACCESS'])
  expect(r.pages).toEqual([])
  expect(calls.filter((x) => /admin\.da\.live|admin\.hlx\.page/.test(x.url))).toEqual([])
})

test('edsPreview retries a sign-in-required site with the user bearer, not when an admin key is set', async () => {
  let calls = mockFetch([[/POST .*admin\.hlx\.page/, (url, opts) => (opts.headers.Authorization ? ok('') : status(401))]])
  await da.edsPreview(cfg, '', '/ads/a', 'user-tok')
  expect(calls.map((x) => x.opts.headers)).toEqual([{}, { Authorization: 'Bearer user-tok' }])

  calls = mockFetch([[/POST .*admin\.hlx\.page/, status(401)]])
  await expect(da.edsPreview(cfg, 'key', '/ads/a', 'user-tok')).rejects.toMatchObject({ code: 'HTML5_DA_NO_ACCESS' })
  expect(calls.map((x) => x.opts.headers)).toEqual([{ 'x-auth-token': 'key' }])

  calls = mockFetch([[/POST .*admin\.hlx\.page/, status(401)]])
  await expect(da.edsPreview(cfg, '', '/ads/a')).rejects.toMatchObject({ code: 'HTML5_DA_NO_ACCESS' })
  expect(calls).toHaveLength(1)
})
