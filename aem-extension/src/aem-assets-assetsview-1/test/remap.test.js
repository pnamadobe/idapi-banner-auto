const { remapSources, linksFromIndd } = require('../actions/generate-idapi-banners/remap')

test('maps recorded local links of swapped images to AEM URLs', () => {
  const src = new Map([['pharma-03.png', '/content/dam/c/a b/pharma-03.png']])
  const links = [
    { name: 'pharma-03.png', path: '/w/assets/shots/pharma-03.png' },
    { name: 'pharma-03.png', path: '/w/assets/shots/pharma-03.png' },
    { name: 'other.png', path: '/w/assets/shots/other.png' }
  ]
  expect(remapSources(links, src, 'https://author-p1-e2.adobeaemcloud.com')).toEqual([
    { sourceURI: '/w/assets/shots/pharma-03.png', destinationURI: 'https://author-p1-e2.adobeaemcloud.com/content/dam/c/a%20b/pharma-03.png' },
    { sourceURI: 'file:////w/assets/shots/pharma-03.png', destinationURI: 'https://author-p1-e2.adobeaemcloud.com/content/dam/c/a%20b/pharma-03.png' },
    { sourceURI: '\\w\\assets\\shots\\pharma-03.png', destinationURI: 'https://author-p1-e2.adobeaemcloud.com/content/dam/c/a%20b/pharma-03.png' }
  ])
  expect(remapSources(undefined, src, 'x')).toEqual([])
})

test('reads staged-image link paths from an INDD, ignoring other file links', () => {
  const buf = Buffer.from('<stRef:filePath>file:///C:/CXP/9222/assets/shots/pharma-06.png</stRef:filePath>\x00file:C:/CXP/9222/assets/shots/pharma-06.png' +
    '<stRef:filePath>file:////Users/x/My%20Dir/assets/brand/lockup.png</stRef:filePath>', 'latin1')
  expect(linksFromIndd(buf)).toEqual([{ name: 'pharma-06.png', path: 'C:/CXP/9222/assets/shots/pharma-06.png' }])
})
