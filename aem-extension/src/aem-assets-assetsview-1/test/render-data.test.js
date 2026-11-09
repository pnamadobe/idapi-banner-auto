jest.mock('@adobe/aio-sdk', () => ({ Core: { Logger: () => ({ debug () {}, info () {}, warn () {}, error () {} }) } }))
jest.mock('@adobe/aio-lib-files', () => ({ init: async () => ({}) }))
const { renderData, aemUpload, aemApiPath } = require('../actions/generate-idapi-banners/engine')

describe('renderData (the script dataURL contents in the status response)', () => {
  test('object data', () => expect(renderData({ status: 'succeeded', data: { html5: { A: {} } } })).toEqual({ html5: { A: {} } }))
  test('JSON string data', () => expect(renderData({ data: '{"links":{}}' })).toEqual({ links: {} }))
  test('per-output data', () => expect(renderData({ outputs: [{ destination: {} }, { data: { rows: 2 } }] })).toEqual({ rows: 2 }))
  test('none', () => {
    expect(renderData({ status: 'succeeded', outputs: [] })).toBeNull()
    expect(renderData({ data: {} })).toBeNull()
    expect(renderData({ data: 'not json' })).toBeNull()
    expect(renderData(null)).toBeNull()
  })
})

describe('AEM path segment encoding', () => {
  afterEach(() => { delete global.fetch })

  test('aemApiPath and aemUpload encode spaces in DAM folder paths for both initiateUpload and completeUpload', async () => {
    const author = 'https://author-p1-e2.adobeaemcloud.com'
    const folder = '/content/dam/Spring Campaign/output'
    expect(aemApiPath(author, folder)).toBe('https://author-p1-e2.adobeaemcloud.com/api/assets/Spring%20Campaign/output.json')

    const urls = []
    global.fetch = jest.fn(async (url) => {
      urls.push(url)
      if (url.endsWith('.initiateUpload.json')) {
        return { ok: true, status: 200, text: async () => JSON.stringify({ files: [{ uploadURIs: ['https://blob.example/part0'], uploadToken: 'tok1' }] }) }
      }
      return { ok: true, status: 200, text: async () => '{}' }
    })

    await aemUpload(author, 'aem-tok', folder, 'banner.jpg', Buffer.from('abc'), 'image/jpeg')
    expect(urls).toEqual([
      'https://author-p1-e2.adobeaemcloud.com/content/dam/Spring%20Campaign/output.initiateUpload.json',
      'https://blob.example/part0',
      'https://author-p1-e2.adobeaemcloud.com/content/dam/Spring%20Campaign/output.completeUpload.json',
      'https://author-p1-e2.adobeaemcloud.com/content/dam/Spring%20Campaign/output/banner.jpg'
    ])
  })
})
