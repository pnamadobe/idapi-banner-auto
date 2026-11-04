/*
 * The start action's saveSite=1 branch: it saves the site as the caller and starts nothing.
 */
const mockSave = jest.fn()
jest.mock('@adobe/aio-lib-state', () => ({ init: async () => ({ get: async () => undefined, put: async () => {} }) }))
jest.mock('@adobe/aio-sdk', () => ({
  Core: { Logger: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }) }
}))
jest.mock('../actions/generate-idapi-banners/engine', () => ({
  aemContext: async () => ({ author: 'https://author.example', aemToken: 'svc' }),
  inspectInputs: jest.fn()
}))
jest.mock('../actions/generate-idapi-banners/site', () => ({ saveSite: (...a) => mockSave(...a) }))

const { main } = require('../actions/generate-idapi-banners')
const params = (extra) => ({ folder: '/content/dam/x/y', AEM_DEV_TOKEN: 'svc', saveSite: '1', org: 'acme', site: 'ads', target: '/content/dam/x', __ow_headers: { authorization: 'Bearer user-tok' }, ...extra })

beforeEach(() => { mockSave.mockReset(); global.fetch = jest.fn() })

test('saves with the caller token and returns the site', async () => {
  mockSave.mockResolvedValue({ site: 'acme/ads', savedAt: '/content/dam/x' })
  const res = await main(params())
  expect(res).toEqual({ statusCode: 200, body: { site: 'acme/ads', savedAt: '/content/dam/x' } })
  expect(mockSave).toHaveBeenCalledWith({ author: 'https://author.example', userToken: 'user-tok', folder: '/content/dam/x/y', target: '/content/dam/x', org: 'acme', site: 'ads' })
  expect(global.fetch).not.toHaveBeenCalled()
})

test('a failed save keeps its status and message', async () => {
  mockSave.mockRejectedValue(Object.assign(new Error('nope'), { status: 403 }))
  const res = await main(params())
  expect(res.error).toEqual({ statusCode: 403, body: { error: 'nope' } })
})

test('falls back to the userToken in the body when the header is missing', async () => {
  mockSave.mockResolvedValue({ site: 'acme/ads', savedAt: '/content/dam/x' })
  await main(params({ __ow_headers: {}, userToken: 'body-tok' }))
  expect(mockSave).toHaveBeenCalledWith(expect.objectContaining({ userToken: 'body-tok' }))
})
