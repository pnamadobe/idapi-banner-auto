const da = require('../actions/generate-idapi-banners/da')
const { daConfig } = require('../actions/generate-idapi-banners/html5')

const AUTHOR = 'https://author-p1-e2.adobeaemcloud.com'
const cfg = daConfig({ DA_ORG: 'pnamadobe', DA_SITE: 'banner-ads' })
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
    deps: { upload: jest.fn(async () => {}), assetId: jest.fn(async (p) => `urn:aaid:aem:${p.split('/').pop()}`), fetchBuf: async () => Buffer.alloc(1000), sleep: async () => {} },
    ...extra
  }
}

afterEach(() => { delete global.fetch })

test('deliveryUrl and sliceOf', () => {
  expect(da.deliveryUrl(AUTHOR, 'urn:aaid:aem:1', 'a b.png')).toBe('https://delivery-p1-e2.adobeaemcloud.com/adobe/assets/urn:aaid:aem:1/as/a%20b.png')
  expect(da.sliceOf('https://x/y/output/html5/MedRect_300x250/static-2.png?sig=1')).toEqual({ page: 'MedRect_300x250', file: 'static-2.png' })
  expect(da.sliceOf('output/Spring_MedRect.jpg')).toBeNull()
  // the render returns outputs by bare name: the page travels in the file name
  expect(da.sliceOf('static-0.png', 'https://x/t/WEB_HP_SLIDER_1440x500--static-0.png?sig=1')).toEqual({ page: 'WEB_HP_SLIDER_1440x500', file: 'static-0.png' })
  expect(da.sliceOf('output/html5/MedRect_300x250/MedRect_300x250--static-1.png')).toEqual({ page: 'MedRect_300x250', file: 'static-1.png' })
  expect(da.sliceOf(undefined, 'https://x/out%2Fhtml5%2FMedRect_300x250%2Fstatic-3.png?sig=1')).toEqual({ page: 'MedRect_300x250', file: 'static-3.png' })
  expect(da.sliceOf('static-0.png', 'https://x/t/static-0.png')).toBeNull()
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

test('publishHtml5 happy path writes the sheet, the slices into DA beside the page, the page, and previews', async () => {
  const calls = mockFetch([[/metadata\.json/, ok({ 'dam:status': 'approved' })], [/GET https:\/\/admin\.da\.live/, status(404)]])
  const c = ctx()
  const r = await da.publishHtml5(c)
  expect(r.warnings).toEqual([])
  expect(r.pages).toEqual([{ page: 'MedRect_300x250', path: '/ads/spring/medrect-300x250', previewUrl: 'https://main--banner-ads--pnamadobe.aem.page/ads/spring/medrect-300x250', rows: 1 }])
  const puts = calls.filter((x) => x.method === 'PUT' && /admin\.da\.live/.test(x.url))
  expect(puts.map((x) => x.url)).toEqual([
    'https://admin.da.live/source/pnamadobe/banner-ads/ads/spring/variations.json',
    'https://admin.da.live/source/pnamadobe/banner-ads/ads/spring/.medrect-300x250/static-0.png',
    'https://admin.da.live/source/pnamadobe/banner-ads/ads/spring/medrect-300x250.html'
  ])
  expect(puts[1].opts.body.toString()).toContain('Content-Type: image/png')
  expect(puts[2].opts.body.toString()).toContain('https://content.da.live/pnamadobe/banner-ads/ads/spring/.medrect-300x250/static-0.png')
  expect(calls.filter((x) => /admin\.hlx\.page\/preview/.test(x.url))).toHaveLength(2)
  // slices are not AEM assets: nothing uploaded to AEM, nothing to approve or deliver later
  expect(c.deps.upload).not.toHaveBeenCalled()
  expect(calls.some((x) => /jcr:content\/metadata$/.test(x.url))).toBe(false)
  expect(r.delivery).toEqual([])
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

test('edsPreview sends the user token for the DA content read, and retries a sign-in-required site with it', async () => {
  const src = { 'x-content-source-authorization': 'Bearer user-tok' }
  let calls = mockFetch([[/POST .*admin\.hlx\.page/, (url, opts) => (opts.headers.Authorization ? ok('') : status(401))]])
  await da.edsPreview(cfg, '', '/ads/a', 'user-tok')
  expect(calls.map((x) => x.opts.headers)).toEqual([src, { Authorization: 'Bearer user-tok', ...src }])

  calls = mockFetch([[/POST .*admin\.hlx\.page/, ok('')]])
  await da.edsPreview(cfg, '', '/ads/a', 'user-tok')
  expect(calls.map((x) => x.opts.headers)).toEqual([src])

  calls = mockFetch([[/POST .*admin\.hlx\.page/, status(401)]])
  await expect(da.edsPreview(cfg, 'key', '/ads/a', 'user-tok')).rejects.toMatchObject({ code: 'HTML5_DA_NO_ACCESS' })
  expect(calls.map((x) => x.opts.headers)).toEqual([{ 'x-auth-token': 'key', 'x-content-source-authorization': 'Bearer user-tok' }])

  calls = mockFetch([[/POST .*admin\.hlx\.page/, status(401)]])
  await expect(da.edsPreview(cfg, '', '/ads/a')).rejects.toMatchObject({ code: 'HTML5_DA_NO_ACCESS' })
  expect(calls).toHaveLength(1)
})

test('edsPreview says when EDS could not read the page from DA', async () => {
  const headers = { get: (n) => ({ 'x-error-code': 'AEM_BACKEND_FETCH_FAILED', 'x-error': 'secret-free text' })[n] }
  mockFetch([[/POST .*admin\.hlx\.page/, { ok: false, status: 401, headers }]])
  await expect(da.edsPreview(cfg, '', '/ads/a', 'user-tok')).rejects.toMatchObject({ code: 'HTML5_DA_NO_ACCESS', message: expect.stringMatching(/could not read the page from DA/) })
})

const SLICE = { damPath: '/content/dam/c/output/html5/assets/medrect-300x250/static-0.png', url: 'https://delivery-p1-e2.adobeaemcloud.com/adobe/assets/urn:aaid:aem:static-0.png/as/static-0.png', page: '/ads/spring/medrect-300x250' }
const dctx = (extra = {}) => ({ cfg, edsToken: '', edsBearer: 'user-tok', author: AUTHOR, aemToken: 'aem', slices: [SLICE], approveBy: Date.now() + 60000, deliveredBy: Date.now() + 60000, sleep: async () => {}, ...extra })

test('deliverHtml5 approves a slice only once processing is done, re-approving until it reads back, waits for delivery, then previews', async () => {
  let state = 'processing', approved = false, posts = 0, heads = 0
  const calls = mockFetch([
    [/static-0\.png\/jcr:content\.json/, () => { const r = ok({ 'dam:assetState': state }); state = 'processed'; return r }],
    [/static-0\.png\/jcr:content\/metadata\.json/, () => ok({ 'dam:status': approved ? 'approved' : '' })],
    // the first approval does not save
    [/POST .*static-0\.png\/jcr:content\/metadata$/, (url, opts) => { expect(opts.body).toBe('dam%3Astatus=approved'); posts++; approved = posts > 1; return ok({}) }],
    [/HEAD https:\/\/delivery-/, () => (++heads > 1 ? ok('') : status(404))]
  ])
  const r = await da.deliverHtml5(dctx())
  expect(r).toEqual({ previewed: [SLICE.page], remaining: [], warnings: [] })
  expect(posts).toBe(2)
  expect(heads).toBe(2)
  const preview = calls.findIndex((x) => /admin\.hlx\.page\/preview.*medrect/.test(x.url))
  expect(calls.map((x) => x.method).lastIndexOf('HEAD')).toBeLessThan(preview)
  expect(calls[preview].opts.headers).toEqual({ 'x-content-source-authorization': 'Bearer user-tok' })
})

test('deliverHtml5 leaves a slice still processing for the next run, and warns on the last', async () => {
  const calls = mockFetch([[/jcr:content\.json/, ok({ 'dam:assetState': 'processing' })]])
  let r = await da.deliverHtml5(dctx({ approveBy: Date.now() - 1 }))
  expect(r).toEqual({ previewed: [], remaining: [SLICE], warnings: [] })
  expect(calls.some((x) => /admin\.hlx\.page/.test(x.url))).toBe(false)
  r = await da.deliverHtml5(dctx({ approveBy: Date.now() - 1, final: true }))
  expect(r.warnings.map((w) => w.code)).toEqual(['HTML5_ASSET_NOT_DELIVERABLE'])
  expect(r.previewed).toEqual([SLICE.page])
})

test('deliverHtml5 keeps an approved slice Dynamic Media does not serve yet', async () => {
  mockFetch([[/metadata\.json/, ok({ 'dam:status': 'approved' })], [/HEAD https:\/\/delivery-/, status(404)]])
  const r = await da.deliverHtml5(dctx({ deliveredBy: Date.now() - 1 }))
  expect(r.remaining).toEqual([SLICE])
  expect(r.previewed).toEqual([])
})
