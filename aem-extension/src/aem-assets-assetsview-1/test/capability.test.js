const { buildCapabilityBundle, resolveExecuteUrl, capabilityCacheKey } = require('../actions/generate-idapi-banners/capability')

describe('InDesign capability self-bootstrap', () => {
  afterEach(() => { delete global.fetch })

  test('buildCapabilityBundle creates a valid deterministic STORE zip with manifest.json and scripts', () => {
    const bundle1 = buildCapabilityBundle()
    const bundle2 = buildCapabilityBundle()
    expect(bundle1.scriptHash).toMatch(/^[a-f0-9]{8}$/)
    expect(bundle1.zip.equals(bundle2.zip)).toBe(true)
    expect(bundle1.zip.readUInt32LE(0)).toBe(0x04034b50) // PK\x03\x04 local header
    const text = bundle1.zip.toString('utf8')
    expect(text).toContain('manifest.json')
    expect(text).toContain('generate_variations.jsx')
    expect(text).toContain('brand_lib.jsx')
  })

  test('resolveExecuteUrl returns explicit INDESIGN_EXECUTE_URL without network calls', async () => {
    global.fetch = jest.fn()
    const url = await resolveExecuteUrl({ INDESIGN_EXECUTE_URL: 'https://indesign.adobe.io/v3/custom/cap' }, 'tok', null)
    expect(url).toBe('https://indesign.adobe.io/v3/custom/cap')
    expect(global.fetch).not.toHaveBeenCalled()
  })

  test('resolveExecuteUrl auto-registers capability on cache miss and caches URL in state', async () => {
    const store = new Map()
    const state = {
      get: jest.fn(async (k) => (store.has(k) ? { value: store.get(k) } : undefined)),
      put: jest.fn(async (k, v) => { store.set(k, v) })
    }
    const execUrl = 'https://indesign.adobe.io/v3/abc123/idapi-banner-exporter'
    global.fetch = jest.fn(async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ url: execUrl })
    }))

    const params = { FFS_CLIENT_ID: 'client-1', FFS_ORG_ID: 'org@AdobeOrg' }
    const first = await resolveExecuteUrl(params, 'ims-tok', state)
    expect(first).toBe(execUrl)
    expect(global.fetch).toHaveBeenCalledTimes(1)
    expect(global.fetch.mock.calls[0][0]).toBe('https://indesign.adobe.io/v3/capability')
    expect(state.put).toHaveBeenCalledTimes(1)

    // Second call hits state cache without calling POST /v3/capability again
    const second = await resolveExecuteUrl(params, 'ims-tok', state)
    expect(second).toBe(execUrl)
    expect(global.fetch).toHaveBeenCalledTimes(1)
    const { scriptHash } = buildCapabilityBundle()
    expect(store.get(capabilityCacheKey('client-1', scriptHash))).toBe(execUrl)
  })
})
