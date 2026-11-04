jest.mock('@adobe/aio-sdk', () => ({ Core: { Logger: () => ({ debug () {}, info () {}, warn () {}, error () {} }) } }))
jest.mock('@adobe/aio-lib-files', () => ({ init: async () => ({}) }))
const { renderData } = require('../actions/generate-idapi-banners/engine')

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
