const { damLinksFromTemplate, csvImageRefs, resolveSwappedImages } = require('../actions/generate-idapi-banners/links')

const tpl = Buffer.from(
  '<stRef:filePath>https://author-p1-e2.adobeaemcloud.com/content/dam/c/a/pharma-01.png</stRef:filePath>\x00' +
  'aems://%24placeholder/content/dam/c/a/pharma-01.png\x00aems://%24placeholder/content/dam/c/a/pharma-02.png!' +
  '<stRef:filePath>file:///Users/x/lockup.png</stRef:filePath>', 'latin1')

test('reads DAM paths from https and aems links, ignoring file links', () => {
  const l = damLinksFromTemplate(tpl)
  expect([...l.keys()].sort()).toEqual(['pharma-01.png', 'pharma-02.png'])
  expect(l.get('pharma-01.png')).toEqual({ damPath: '/content/dam/c/a/pharma-01.png', host: 'author-p1-e2.adobeaemcloud.com' })
  expect(l.get('pharma-02.png').host).toBeNull()
})

test('collects image refs from CSV records, incl. quoted cells', () => {
  const recs = ['outputFileName,hero,header', 'a,pharma-01.png,"Hi, there.png ok"', 'b,"sub/pharma-02.png",Text']
  expect([...csvImageRefs(recs)].sort()).toEqual(['pharma-01.png', 'pharma-02.png'])
})

test('resolves folder first, then template links, else unresolved; rejects foreign host', () => {
  const links = new Map([['a.png', { damPath: '/content/dam/x/a.png', host: 'author-p1-e2.adobeaemcloud.com' }],
    ['evil.png', { damPath: '/content/dam/x/evil.png', host: 'author-other.adobeaemcloud.com' }]])
  const r = resolveSwappedImages(new Set(['in.png', 'a.png', 'evil.png', 'gone.png']), ['in.png'], links, 'author-p1-e2.adobeaemcloud.com')
  expect(r.fromLinks).toEqual([{ name: 'a.png', damPath: '/content/dam/x/a.png' }])
  expect(r.unresolved.sort()).toEqual(['evil.png', 'gone.png'])
})
