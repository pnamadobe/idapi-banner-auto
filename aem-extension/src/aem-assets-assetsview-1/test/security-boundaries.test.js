/*
 * Layer 2: Security, Auth & Adversarial Boundary Matrix (SEC-01 .. SEC-07)
 *
 * Tests authentication, IMS Org allowlisting, cross-program AEM SSRF blocking,
 * HTML5 slice origin allowlisting, path traversal prevention, webhook HMAC
 * forgery/replay protection, and log secret redaction across all 5 actions.
 */

const crypto = require('crypto')
const mockStore = new Map()

jest.mock('@adobe/aio-lib-state', () => ({
  init: async () => ({
    get: async (k) => (mockStore.has(k) ? { value: mockStore.get(k) } : undefined),
    put: async (k, v) => { mockStore.set(k, v); return k },
    delete: async (k) => { mockStore.delete(k) }
  })
}))
jest.mock('@adobe/aio-lib-files', () => ({
  init: async () => ({
    write: async () => {},
    generatePresignURL: async (r) => `https://files.example/${r}`,
    delete: async () => {}
  })
}))
jest.mock('@adobe/aio-sdk', () => ({
  Core: { Logger: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }) }
}))

const startAction = require('../actions/generate-idapi-banners').main
const statusAction = require('../actions/generate-idapi-banners-status').main
const packageAction = require('../actions/generate-idapi-banners-package').main
const writebackAction = require('../actions/html5-writeback').main
const { aemAuthor, isTrustedSliceUrl } = require('../actions/generate-idapi-banners/engine')
const pkg = require('../actions/generate-idapi-banners/package')
const utils = require('../actions/utils')

function fakeJwt (claims) {
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url')
  return `${b64({ alg: 'RS256' })}.${b64(claims)}.sig`
}

describe('Layer 2: Security, Auth & Adversarial Boundary Matrix', () => {
  beforeEach(() => {
    mockStore.clear()
    global.fetch = jest.fn(async () => ({ ok: true, status: 200, json: async () => ({}), text: async () => '' }))
  })
  afterEach(() => { delete global.fetch })

  test('SEC-01: unauthenticated calls to start, status, and package are rejected with 401 before any network call', async () => {
    const base = { folder: '/content/dam/acme/camp', AEM_DEV_TOKEN: 'svc', AEM_AUTHOR_URL: 'https://author-p100-e200.adobeaemcloud.com' }
    expect((await startAction(base)).error.statusCode).toBe(401)
    expect((await statusAction({ ...base, jobId: 'a'.repeat(48) })).error.statusCode).toBe(401)
    expect((await packageAction({ ...base, jobId: 'a'.repeat(48) })).error.statusCode).toBe(401)
    expect(global.fetch).not.toHaveBeenCalled()
  })

  test('SEC-02: ALLOWED_IMS_ORGS blocks foreign IMS org headers and foreign JWT org claims with 403', async () => {
    const base = {
      folder: '/content/dam/acme/camp',
      AEM_DEV_TOKEN: 'svc',
      AEM_AUTHOR_URL: 'https://author-p100-e200.adobeaemcloud.com',
      ALLOWED_IMS_ORGS: '111111@AdobeOrg, 222222@AdobeOrg'
    }
    // Foreign header
    const res1 = await startAction({
      ...base,
      __ow_headers: { authorization: 'Bearer tok', 'x-gw-ims-org-id': '999999@AdobeOrg' }
    })
    expect(res1.error.statusCode).toBe(403)
    expect(res1.error.body.error).toMatch(/IMS organization is not authorized/)

    // Foreign JWT claim (even when x-gw-ims-org-id header is omitted)
    const badJwt = fakeJwt({ org: '888888@AdobeOrg', sub: 'user1' })
    const res2 = await statusAction({
      ...base,
      jobId: 'a'.repeat(48),
      __ow_headers: { authorization: `Bearer ${badJwt}` }
    })
    expect(res2.error.statusCode).toBe(403)

    // Matching JWT claim passes org check
    const goodJwt = fakeJwt({ org: '222222@AdobeOrg', sub: 'user1' })
    expect(utils.isAllowedImsOrg({ ...base, __ow_headers: { authorization: `Bearer ${goodJwt}` } })).toBe(true)
  })

  test('SEC-03: aemAuthor blocks SSRF hosts, non-HTTPS schemes, and cross-program AEM author URLs', () => {
    const cfg = { AEM_AUTHOR_URL: 'https://author-p100-e200.adobeaemcloud.com' }
    const badUrls = [
      'http://author-p100-e200.adobeaemcloud.com',
      'https://evil.example.com',
      'https://169.254.169.254',
      'https://author-p100-e200.adobeaemcloud.com.evil.com',
      'https://author-p100-e200.adobeaemcloud.com@evil.com',
      'https://author-p100-e200.adobeaemcloud.com/path',
      'https://author-p999-e1.adobeaemcloud.com' // cross-program!
    ]
    for (const u of badUrls) {
      expect(() => aemAuthor({ ...cfg, aemAuthorUrl: u })).toThrow()
    }
    // Same Cloud Manager program (p100) across environments is permitted
    expect(aemAuthor({ ...cfg, aemAuthorUrl: 'https://author-p100-e300.adobeaemcloud.com/' }))
      .toBe('https://author-p100-e300.adobeaemcloud.com')
    // Explicitly allowlisted second program is permitted
    expect(aemAuthor({ ...cfg, ALLOWED_AEM_AUTHORS: 'p999, author-p777-e1.adobeaemcloud.com', aemAuthorUrl: 'https://author-p999-e5.adobeaemcloud.com' }))
      .toBe('https://author-p999-e5.adobeaemcloud.com')
  })

  test('SEC-04: isTrustedSliceUrl blocks SSRF attempts via injected HTML5 slice URLs', () => {
    for (const bad of [
      'http://admin.da.live/org/site/s.png',
      'https://169.254.169.254/latest/meta-data/',
      'https://attacker.example.com/slice.png',
      'file:///etc/passwd',
      'javascript:alert(1)'
    ]) {
      expect(isTrustedSliceUrl(bad)).toBe(false)
    }
    for (const good of [
      'https://admin.da.live/source/org/site/s.png',
      'https://content.da.live/org/site/s.png',
      'https://main--site--org.aem.page/s.png',
      'https://main--site--org.aem.live/s.png',
      'https://main--site--org.hlx.page/s.png',
      'https://delivery-p100-e200.adobeaemcloud.com/adobe/assets/urn:aaid:aem:1/as/s.png'
    ]) {
      expect(isTrustedSliceUrl(good)).toBe(true)
    }
  })

  test('SEC-05: path traversal and malformed folder/template/jobId inputs are rejected with 400', async () => {
    const auth = { __ow_headers: { authorization: 'Bearer tok' }, AEM_DEV_TOKEN: 'svc', AEM_AUTHOR_URL: 'https://author-p1-e1.adobeaemcloud.com' }
    for (const badFolder of ['/content/dam/../etc', '/content/dam/a/../b', '/etc/passwd', '/content/dam', '/content/dam/a\\b', '/content/dam/a\x00b']) {
      expect((await startAction({ ...auth, folder: badFolder })).error.statusCode).toBe(400)
      expect((await statusAction({ ...auth, folder: badFolder })).error.statusCode).toBe(400)
    }
    for (const badTpl of ['../evil.indd', 'sub/t.indd', 't.exe', 't.indd.jpg', 'a\\b.psd']) {
      expect((await startAction({ ...auth, folder: '/content/dam/acme', template: badTpl })).error.statusCode).toBe(400)
    }
    for (const badId of ['../abc', 'z'.repeat(48), 'a'.repeat(47), 'a'.repeat(49)]) {
      expect((await statusAction({ ...auth, jobId: badId })).error.statusCode).toBe(400)
      expect((await packageAction({ ...auth, jobId: badId })).error.statusCode).toBe(400)
    }
  })

  test('SEC-06: html5-writeback blocks non-POST, HMAC tampering, token replay, unauthorized backup reads, and bad file tuples', async () => {
    const secret = crypto.randomBytes(24).toString('hex')
    const jobId = 'c'.repeat(48)
    const outFolder = '/content/dam/acme/output'
    const ad = { page: 'P', path: '/p', row: 'R', budgetKB: 150, name: 'P_R', backup: 'P_R.jpg' }
    mockStore.set(`idapi-job-${jobId}`, JSON.stringify({ jobId, folder: '/content/dam/acme', outputFolder: outFolder, template: 't.indd' }))
    mockStore.set(`idapi-pkg-${jobId}`, JSON.stringify({ jobId, run: 'run-1', outFolder, ads: [ad], results: {}, status: 'running' }))

    const validTok = pkg.mintToken(secret, { job: jobId, run: 'run-1', outFolder, template: 't.indd' })
    const wb = (extra) => writebackAction({ HTML5_WRITEBACK_SECRET: secret, AEM_DEV_TOKEN: 'svc', AEM_AUTHOR_URL: 'https://author-p1-e1.adobeaemcloud.com', __ow_method: 'post', token: validTok, ...extra })

    // 1. GET rejected with 405
    expect((await wb({ __ow_method: 'get', op: 'done' })).error.statusCode).toBe(405)
    // 2. Forged signature rejected with 401
    expect((await wb({ token: `${validTok}x`, op: 'done' })).error.statusCode).toBe(401)
    // 3. Replayed token for different run or outFolder rejected with 401
    const wrongRunTok = pkg.mintToken(secret, { job: jobId, run: 'run-OLD', outFolder, template: 't.indd' })
    expect((await wb({ token: wrongRunTok, op: 'done' })).error.statusCode).toBe(401)
    // 4. Unauthorized backup read rejected with 403
    expect((await wb({ op: 'backup', file: 'other-asset.jpg' })).error.statusCode).toBe(403)
    expect((await wb({ op: 'backup', file: '../P_R.jpg' })).error.statusCode).toBe(403)
    // 5. Unexpected file in initiate rejected with 400
    expect((await wb({
      op: 'initiate',
      ad: 0,
      files: [{ name: 'P_R.zip', mime: 'application/zip', size: 100 }, { name: 'evil.sh', mime: 'text/plain', size: 10 }]
    })).error.statusCode).toBe(400)
  })

  test('SEC-07: stringParameters redacts all credential, secret, token, and key parameters and headers', () => {
    const secrets = [
      'val-ffs-secret',
      'val-oauth-secret',
      'val-sc-json',
      'val-dev-token',
      'val-gh-token',
      'val-wb-secret',
      'val-user-token',
      'val-da-token',
      'val-bearer-hdr'
    ]
    const raw = {
      folder: '/content/dam/acme',
      FFS_CLIENT_SECRET: secrets[0],
      AEM_OAUTH_CLIENT_SECRET: secrets[1],
      AEM_SC_JSON: secrets[2],
      AEM_DEV_TOKEN: secrets[3],
      GITHUB_DISPATCH_TOKEN: secrets[4],
      HTML5_WRITEBACK_SECRET: secrets[5],
      userToken: secrets[6],
      daUserToken: secrets[7],
      __ow_headers: {
        authorization: `Bearer ${secrets[8]}`,
        'x-gw-ims-org-id': '12345@AdobeOrg'
      }
    }
    const logged = utils.stringParameters(raw)
    for (const s of secrets) {
      expect(logged).not.toContain(s)
    }
    expect(logged).toContain('/content/dam/acme')
    expect(logged).toContain('12345@AdobeOrg')
  })
})
