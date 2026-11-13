/*
 * Layer 3: Multi-Tenancy & Concurrency Isolation Matrix (MT-01 .. MT-05)
 *
 * Verifies frontend <-> backend deterministic job ID parity, cross-environment
 * state/lock isolation, job reuse environment updates, regional data residency,
 * and distributed worker lock concurrency.
 */

const crypto = require('crypto')
const mockStore = new Map()
const mockStateInit = jest.fn(async () => ({
  get: async (k) => (mockStore.has(k) ? { value: mockStore.get(k) } : undefined),
  put: async (k, v, opts) => {
    if (opts && opts.ifNotExists && mockStore.has(k)) return undefined
    mockStore.set(k, v)
    return k
  },
  delete: async (k) => { mockStore.delete(k) }
}))

jest.mock('@adobe/aio-lib-state', () => ({
  init: (...args) => mockStateInit(...args)
}))
jest.mock('@adobe/aio-lib-files', () => ({ init: async () => ({}) }))
jest.mock('@adobe/aio-sdk', () => ({
  Core: { Logger: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }) }
}))

const mockInspect = jest.fn()
const mockResolveOut = jest.fn()
const mockBatch = jest.fn()

jest.mock('../actions/generate-idapi-banners/engine', () => ({
  inspectInputs: (...a) => mockInspect(...a),
  resolveOutputFolder: (...a) => mockResolveOut(...a),
  processBatch: (...a) => mockBatch(...a),
  aemContext: async (p) => ({ author: p.aemAuthorUrl || p.AEM_AUTHOR_URL || 'https://author-p100-e1.adobeaemcloud.com', aemToken: 'svc' }),
  hasFolderAccess: async () => true,
  hasDurableAemAuth: () => true,
  writeJobManifest: async () => {},
  finalizeRelations: async () => {}
}))

const startAction = require('../actions/generate-idapi-banners').main
const workerAction = require('../actions/generate-idapi-banners-worker').main
const { keyFor, normalizeScope, outputUrl } = require('../actions/job-utils')

// Exact replica of ModalIndesignBannersGeneration.js deterministicJobId
function modalDeterministicJobId (folder, mode, template, aemAuthorUrl) {
  const editable = mode === 'both' || mode === 'editable'
  const sc = normalizeScope(aemAuthorUrl)
  const input = `${folder}|${editable ? '1' : '0'}${template ? `|${template}` : ''}${mode === 'editable' ? '|editable-only' : ''}${mode === 'html5' ? '|html5' : ''}${sc ? `|@${sc}` : ''}`
  return crypto.createHash('sha256').update(input).digest('hex').slice(0, 48)
}

describe('Layer 3: Multi-Tenancy & Concurrency Isolation Matrix', () => {
  beforeEach(() => {
    mockStore.clear()
    mockStateInit.mockClear()
    mockInspect.mockReset().mockResolvedValue({ ok: true, findings: [], template: 'hero.indd' })
    mockResolveOut.mockReset().mockImplementation(async (p) => `${p.folder}/output/${new URL(p.aemAuthorUrl || 'https://author-p100-e1.adobeaemcloud.com').host}`)
    mockBatch.mockReset().mockResolvedValue({ statusCode: 200, body: { batchRows: 0 } })
    process.env.__OW_NAMESPACE = 'ns'
    process.env.__OW_API_KEY = 'key'
    global.fetch = jest.fn(async () => ({ ok: true, status: 202 }))
  })
  afterEach(() => { delete global.fetch })

  test('MT-01: frontend deterministicJobId matches backend keyFor across all 4 modes and author scopes', () => {
    const folder = '/content/dam/brand/campaign'
    const tpl = 'banner-template.indd'
    const scopes = ['', 'https://author-p100-e200.adobeaemcloud.com', 'https://AUTHOR-p100-e300.adobeaemcloud.com/']
    const modes = [
      { mode: 'images', writeIndd: false, editableOnly: false, html5: false },
      { mode: 'both', writeIndd: true, editableOnly: false, html5: false },
      { mode: 'editable', writeIndd: true, editableOnly: true, html5: false },
      { mode: 'html5', writeIndd: false, editableOnly: false, html5: true }
    ]
    for (const sc of scopes) {
      for (const m of modes) {
        const backendId = keyFor(folder, m.writeIndd, tpl, m.editableOnly, m.html5, sc).slice('idapi-job-'.length)
        const frontendId = modalDeterministicJobId(folder, m.mode, tpl, sc)
        expect(frontendId).toBe(backendId)
      }
    }
  })

  test('MT-02: simultaneous runs on Stage and Prod with identical DAM paths never collide in state', async () => {
    const common = {
      folder: '/content/dam/acme/summer',
      template: 'hero.indd',
      mode: 'both',
      AEM_DEV_TOKEN: 'svc',
      AEM_AUTHOR_URL: 'https://author-p100-e1.adobeaemcloud.com',
      __ow_headers: { authorization: 'Bearer user-tok' }
    }
    const stageRes = await startAction({ ...common, aemAuthorUrl: 'https://author-p100-e100.adobeaemcloud.com', tenant: '@acme-stage' })
    const prodRes = await startAction({ ...common, aemAuthorUrl: 'https://author-p100-e200.adobeaemcloud.com', tenant: '@acme-prod' })

    expect(stageRes.statusCode).toBe(202)
    expect(prodRes.statusCode).toBe(202)
    expect(stageRes.body.jobId).not.toBe(prodRes.body.jobId)
    expect(stageRes.body.outputUrl).toContain('repoId=author-p100-e100.adobeaemcloud.com#/@acme-stage/')
    expect(prodRes.body.outputUrl).toContain('repoId=author-p100-e200.adobeaemcloud.com#/@acme-prod/')

    const stageJob = JSON.parse(mockStore.get(`idapi-job-${stageRes.body.jobId}`))
    const prodJob = JSON.parse(mockStore.get(`idapi-job-${prodRes.body.jobId}`))
    expect(stageJob.aemAuthorUrl).toBe('https://author-p100-e100.adobeaemcloud.com')
    expect(prodJob.aemAuthorUrl).toBe('https://author-p100-e200.adobeaemcloud.com')
  })

  test('MT-03: re-running a completed job updates tenant and outputFolder cleanly', async () => {
    const base = {
      folder: '/content/dam/acme/summer',
      template: 'hero.indd',
      mode: 'images',
      aemAuthorUrl: 'https://author-p100-e100.adobeaemcloud.com',
      tenant: 'tenant-v1',
      AEM_DEV_TOKEN: 'svc',
      __ow_headers: { authorization: 'Bearer user-tok' }
    }
    const first = await startAction(base)
    const stateKey = `idapi-job-${first.body.jobId}`
    const completed = { ...JSON.parse(mockStore.get(stateKey)), status: 'completed', outputs: ['a.jpg'] }
    mockStore.set(stateKey, JSON.stringify(completed))

    mockResolveOut.mockResolvedValueOnce('/content/dam/acme/summer/output/2026-11-13_000000')
    const second = await startAction({ ...base, tenant: '@tenant-v2' })
    expect(second.statusCode).toBe(202)
    const updated = JSON.parse(mockStore.get(stateKey))
    expect(updated.tenant).toBe('@tenant-v2')
    expect(updated.outputFolder).toBe('/content/dam/acme/summer/output/2026-11-13_000000')
    expect(outputUrl(updated, {})).toContain('#/@tenant-v2/assets/browse/content/dam/acme/summer/output/2026-11-13_000000')
  })

  test('MT-04: AIO_STATE_REGION routes state initialization to the configured data residency region', async () => {
    for (const region of ['amer', 'emea', 'apac', 'aus']) {
      await startAction({
        folder: `/content/dam/acme/${region}`,
        AIO_STATE_REGION: region,
        AEM_DEV_TOKEN: 'svc',
        __ow_headers: { authorization: 'Bearer user-tok' }
      })
      expect(mockStateInit).toHaveBeenCalledWith({ region })
    }
  })

  test('MT-05: distributed worker lock prevents concurrent batch execution on the same job', async () => {
    jest.spyOn(global, 'setTimeout').mockImplementation((fn) => { fn(); return 0 })
    const jobId = 'd'.repeat(48)
    const stateKey = `idapi-job-${jobId}`
    mockStore.set(stateKey, JSON.stringify({ stateKey, jobId, folder: '/content/dam/acme', batchSize: 2, rowOffset: 0, status: 'queued' }))
    // Simulate lock already held by an active worker container
    mockStore.set(`${stateKey}-lock`, String(Date.now()))

    const res = await workerAction({ jobId })
    expect(res).toEqual({ statusCode: 202, body: { jobId, status: 'already-running' } })
    expect(mockBatch).not.toHaveBeenCalled()
    jest.restoreAllMocks()
  })
})
