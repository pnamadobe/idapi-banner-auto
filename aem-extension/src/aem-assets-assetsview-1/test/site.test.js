/*
 * Saving a folder's HTML5 site from the Generate Banners dialog: names are validated, DA and EDS are
 * checked with the user's own token, and html5.json is written as the user into the chosen folder.
 */
jest.mock('@adobe/aio-lib-files', () => ({ init: async () => ({}) }))
jest.mock('@adobe/aio-sdk', () => ({
  Core: { Logger: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }) }
}))
const mockDownload = jest.fn()
const mockUpload = jest.fn()
jest.mock('../actions/generate-idapi-banners/engine', () => ({
  ...jest.requireActual('../actions/generate-idapi-banners/engine'),
  aemDownload: (...a) => mockDownload(...a),
  aemUpload: (...a) => mockUpload(...a)
}))

const { saveSite, pickTarget, siteNames } = require('../actions/generate-idapi-banners/site')

const AUTHOR = 'https://author-p1-e2.adobeaemcloud.com'
const FOLDER = '/content/dam/26H2/hilton-hgv/automation'
const res = (s, headers = {}) => ({ ok: s >= 200 && s < 300, status: s, headers: { get: (h) => headers[h.toLowerCase()] || null } })

function mockFetch ({ da = res(200), eds = res(200) } = {}) {
  const calls = []
  global.fetch = jest.fn(async (url, opts = {}) => {
    calls.push({ url, opts })
    if (url.startsWith('https://admin.da.live/')) { if (da instanceof Error) throw da; return da }
    if (/\.aem\.page\//.test(url)) { if (eds instanceof Error) throw eds; return eds }
    throw new Error(`unexpected ${url}`)
  })
  return calls
}
const save = (extra = {}) => saveSite({ author: AUTHOR, userToken: 'user-tok', folder: FOLDER, target: '/content/dam/26H2/hilton-hgv', org: 'Acme', site: 'banner-ads', ...extra })
const uploaded = () => JSON.parse(mockUpload.mock.calls[0][4].toString('utf8'))

beforeEach(() => {
  mockDownload.mockReset().mockRejectedValue(new Error('AEM download x -> 404'))
  mockUpload.mockReset().mockResolvedValue({})
})

test('pickTarget allows the campaign folder or a folder above it, below /content/dam', () => {
  expect(pickTarget(FOLDER)).toBe(FOLDER)
  expect(pickTarget(FOLDER, '/content/dam/26H2/hilton-hgv/')).toBe('/content/dam/26H2/hilton-hgv')
  expect(() => pickTarget(FOLDER, '/content/dam/other')).toThrow(expect.objectContaining({ status: 400 }))
  expect(() => pickTarget(FOLDER, '/content/dam')).toThrow(expect.objectContaining({ status: 400 }))
  expect(() => pickTarget('/var/x')).toThrow(expect.objectContaining({ status: 400 }))
})

test('siteNames lowercases good names and explains bad ones', () => {
  expect(siteNames(' Acme ', 'Banner-Ads')).toMatchObject({ org: 'acme', site: 'banner-ads' })
  expect(() => siteNames('', 'x')).toThrow(/enter both/)
  expect(() => siteNames('acme/evil', 'x')).toThrow(/^DA org .* is not a valid name \(letters, digits and - only\)$/)
})

test('checks DA and EDS as the user, then writes html5.json into the chosen folder as the user', async () => {
  const calls = mockFetch()
  await expect(save()).resolves.toEqual({ site: 'acme/banner-ads', savedAt: '/content/dam/26H2/hilton-hgv' })
  expect(calls[0].url).toBe('https://admin.da.live/list/acme/banner-ads')
  expect(calls[0].opts.headers.Authorization).toBe('Bearer user-tok')
  expect(calls[1]).toMatchObject({ url: 'https://main--banner-ads--acme.aem.page/blocks/ad/ad.js', opts: { method: 'HEAD' } })
  expect(calls[1].opts.headers).toBeUndefined()
  const [author, token, where, name, , mime] = mockUpload.mock.calls[0]
  expect([author, token, where, name, mime]).toEqual([AUTHOR, 'user-tok', '/content/dam/26H2/hilton-hgv', 'html5.json', 'application/json'])
  expect(uploaded()).toEqual({ DA_ORG: 'acme', DA_SITE: 'banner-ads' })
})

test('keeps other keys of an html5.json already there', async () => {
  mockFetch()
  mockDownload.mockResolvedValue(Buffer.from('{"DA_ORG":"old","DA_SITE":"old","EDS_REF":"stage","DA_ADS_ROOT":"/campaigns"}'))
  await save()
  expect(mockDownload).toHaveBeenCalledWith(AUTHOR, 'user-tok', '/content/dam/26H2/hilton-hgv/html5.json')
  expect(uploaded()).toEqual({ DA_ORG: 'acme', DA_SITE: 'banner-ads', EDS_REF: 'stage', DA_ADS_ROOT: '/campaigns' })
})

test('a bad leftover key stops the save', async () => {
  mockFetch()
  mockDownload.mockResolvedValue(Buffer.from('{"EDS_REF":"bad/ref"}'))
  await expect(save()).rejects.toMatchObject({ status: 400, message: expect.stringMatching(/already in .* EDS_REF/) })
  expect(mockUpload).not.toHaveBeenCalled()
})

test('needs the user token', async () => {
  mockFetch()
  await expect(save({ userToken: '' })).rejects.toMatchObject({ status: 401 })
  expect(global.fetch).not.toHaveBeenCalled()
})

test.each([
  [res(401), 403, /can't open acme\/banner-ads/],
  [res(403), 403, /step 4/],
  [res(404), 404, /not found.*step 3/],
  [res(500), 502, /returned 500/],
  [new Error('ECONNRESET'), 502, /could not reach/],
  [res(200, { 'x-da-actions': '/acme/banner-ads/+**=read' }), 403, /not write/]
])('DA answer %#: nothing is saved', async (da, code, msg) => {
  mockFetch({ da })
  await expect(save()).rejects.toMatchObject({ status: code, message: expect.stringMatching(msg) })
  expect(mockUpload).not.toHaveBeenCalled()
})

test('DA write in the child actions is enough', async () => {
  mockFetch({ da: res(200, { 'x-da-actions': '/acme/banner-ads=read', 'x-da-child-actions': '/acme/banner-ads/+**=read,write' }) })
  await expect(save()).resolves.toMatchObject({ site: 'acme/banner-ads' })
})

test('a site without the ad block is refused; a sign-in-protected or unreachable EDS is not held against it', async () => {
  mockFetch({ eds: res(404) })
  await expect(save()).rejects.toMatchObject({ status: 404, message: expect.stringMatching(/no ad block/) })
  mockFetch({ eds: res(401) })
  await expect(save()).resolves.toBeTruthy()
  mockFetch({ eds: new Error('timeout') })
  await expect(save()).resolves.toBeTruthy()
})

test('an AEM folder the user cannot write to is a 403', async () => {
  mockFetch()
  mockUpload.mockRejectedValue(new Error('initiateUpload /content/dam/26H2/hilton-hgv -> 403'))
  await expect(save()).rejects.toMatchObject({ status: 403, message: expect.stringMatching(/can't add files/) })
  mockUpload.mockRejectedValue(new Error('PUT -> 500'))
  await expect(save()).rejects.toMatchObject({ status: 502 })
})
