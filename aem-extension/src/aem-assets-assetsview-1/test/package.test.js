const pkg = require('../actions/generate-idapi-banners/package')
const { daConfig } = require('../actions/generate-idapi-banners/html5')

const SECRET = 'x'.repeat(40)
const PAGEMAP = 'pagenumber,pagename,html5,budgetKB\n1,MedRect_300x250,yes,120\n2,Leader_728x90,no,\n3,Half_300x600,yes,\n'
const CSV = 'outputFileName,headline\nSpring,Hi\nSummer,Yo\n'

describe('writeback token', () => {
  const claims = { job: 'a'.repeat(48), run: 'r1', outFolder: '/content/dam/x/output', template: 't.indd' }
  test('round-trips the claims', () => {
    expect(pkg.verifyToken(SECRET, pkg.mintToken(SECRET, claims))).toMatchObject(claims)
  })
  test('rejects a tampered body or signature', () => {
    const [body, sig] = pkg.mintToken(SECRET, claims).split('.')
    const forged = Buffer.from(JSON.stringify({ ...claims, outFolder: '/content/dam/other', exp: 9e9 })).toString('base64url')
    expect(() => pkg.verifyToken(SECRET, `${forged}.${sig}`)).toThrow('bad token signature')
    expect(() => pkg.verifyToken('y'.repeat(40), `${body}.${sig}`)).toThrow('bad token signature')
    expect(() => pkg.verifyToken(SECRET, 'nope')).toThrow('malformed token')
    expect(() => pkg.verifyToken(SECRET, `${body}.${sig}.x`)).toThrow('malformed token')
  })
  test('expires after the TTL', () => {
    const t = pkg.mintToken(SECRET, claims, 0)
    expect(() => pkg.verifyToken(SECRET, t, (pkg.TOKEN_TTL_S + 1) * 1000)).toThrow('token expired')
  })
  test('needs a long enough secret', () => {
    expect(() => pkg.mintToken('short', claims)).toThrow('not configured')
  })
})

test('safeName allows bare file names only', () => {
  expect(pkg.safeName('MedRect_300x250_Spring.zip')).toBe(true)
  for (const n of ['../x', 'a/b', '.hidden', 'a\\b', 'a\nb', '', 'x'.repeat(201), 3]) expect(pkg.safeName(n)).toBe(false)
})

test('buildAds crosses html5 sizes with rows and finds backups', () => {
  const ads = pkg.buildAds({ pagemapText: PAGEMAP, csvText: CSV, outputs: ['MedRect_300x250_Spring.jpg'], cfg: daConfig({ DA_ORG: 'pnamadobe', DA_SITE: 'banner-ads' }), campaign: 'Spring Sale' })
  expect(ads.map((a) => a.name)).toEqual(['MedRect_300x250_Spring', 'MedRect_300x250_Summer', 'Half_300x600_Spring', 'Half_300x600_Summer'])
  expect(ads[0]).toEqual({ page: 'MedRect_300x250', path: '/ads/spring-sale/medrect-300x250', row: 'Spring', budgetKB: 120, name: 'MedRect_300x250_Spring', backup: 'MedRect_300x250_Spring.jpg' })
  expect(ads[1].backup).toBeUndefined()
  expect(ads[2].budgetKB).toBe(150)
})

test('buildAds narrows by pages and rows', () => {
  const ads = pkg.buildAds({ pagemapText: PAGEMAP, csvText: CSV, cfg: daConfig({ DA_ORG: 'pnamadobe', DA_SITE: 'banner-ads' }), campaign: 'c', pages: ['Half_300x600'], rows: ['Summer'] })
  expect(ads.map((a) => a.name)).toEqual(['Half_300x600_Summer'])
})

test('buildAds puts ads under the template sub-folder', () => {
  const ads = pkg.buildAds({ pagemapText: PAGEMAP, csvText: CSV, cfg: daConfig({ DA_ORG: 'pnamadobe', DA_SITE: 'banner-ads' }), campaign: 'Spring Sale', template: 'United Summer.indd', pages: ['Half_300x600'], rows: ['Summer'] })
  expect(ads[0].path).toBe('/ads/united-summer/spring-sale/half-300x600')
})

test('expectedNames and mimeFor', () => {
  expect(pkg.expectedNames({ name: 'A' })).toEqual(['A.zip', 'A_preview.gif', 'A_storyboard.jpg'])
  expect(['a.zip', 'a.gif', 'a.JPG', 'a.exe'].map(pkg.mimeFor)).toEqual(['application/zip', 'image/gif', 'image/jpeg', undefined])
})

describe('dispatch', () => {
  afterEach(() => { delete global.fetch })
  test('posts a repository_dispatch and expects 204', async () => {
    global.fetch = jest.fn(async () => ({ ok: true, status: 204 }))
    await pkg.dispatch('pnamadobe/banner-ads', 'ghtok', { job: 'j' })
    const [url, opts] = global.fetch.mock.calls[0]
    expect(url).toBe('https://api.github.com/repos/pnamadobe/banner-ads/dispatches')
    expect(opts.headers.Authorization).toBe('Bearer ghtok')
    expect(JSON.parse(opts.body)).toEqual({ event_type: 'package', client_payload: { job: 'j' } })
  })
  test('rejects bad repos, a missing token and API errors', async () => {
    global.fetch = jest.fn(async () => ({ ok: false, status: 404 }))
    await expect(pkg.dispatch('../evil', 't', {})).rejects.toThrow('invalid GITHUB_REPO')
    await expect(pkg.dispatch('a/b', '', {})).rejects.toThrow('GITHUB_DISPATCH_TOKEN')
    await expect(pkg.dispatch('a/b', 't', {})).rejects.toThrow('-> 404')
  })
})

test('zipMetadata drops empty values', () => {
  const m = pkg.zipMetadata({ bytes: 1000, budgetKB: 150, step: 2, over: false, fidelity: { verdict: 'pass', score: 0.98 }, previewUrl: '' }, { page: 'P', row: 'R' }, 't.indd')
  expect(m).toEqual({ 'html5:bytes': 1000, 'html5:budgetKB': 150, 'html5:budgetStep': 2, 'html5:overBudget': false, 'html5:fidelityScore': 0.98, 'html5:fidelityVerdict': 'pass', 'html5:page': 'P', 'html5:row': 'R', 'html5:sourceTemplate': 't.indd' })
})
