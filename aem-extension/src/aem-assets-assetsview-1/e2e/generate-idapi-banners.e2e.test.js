/* 
* <license header>
*/

const { Config } = require('@adobe/aio-sdk').Core
const fetch = require('node-fetch')

// get action url
const namespace = Config.get('runtime.namespace')
const hostname = Config.get('cna.hostname') || 'adobeioruntime.net'
const runtimePackage = 'aem-assets-assetsview-1'
const actionUrl = `https://${namespace}.${hostname}/api/v1/web/${runtimePackage}/generate-idapi-banners`

// The deployed action validates the caller's bearer token in-action (require-adobe-auth is false).
// If the Authorization header is missing, the action returns 401.
test('returns a 401 when missing Authorization header', async () => {
  const res = await fetch(actionUrl)
  expect(res).toEqual(expect.objectContaining({
    status: 401
  }))
})
