const im = require('../actions/generate-idapi-banners/images')

const F = '/content/dam/job'
const file = (name) => ({ name, isFolder: false })
const dir = (name) => ({ name, isFolder: true })
// A fake job folder: root images + subfolders
const tree = {
  [F]: [file('root.jpg'), file('dup.jpg'), file('variations.csv'), dir('hero-images'), dir('components'), dir('output'), dir('fonts')],
  [`${F}/hero-images`]: [file('myAwesomeImage.jpg'), file('dup.jpg'), file('shared.png')],
  [`${F}/components`]: [dir('logos')],
  [`${F}/components/logos`]: [file('logo.png'), file('shared.png')],
  [`${F}/output`]: [file('result-in-output.jpg')],
  [`${F}/fonts`]: [file('font-preview.png')]
}
const list = async (d) => tree[d] || []
const rootImages = [{ name: 'root.jpg' }, { name: 'dup.jpg' }]
const resolve = (cells) => im.resolveImageRefs({ folder: F, rootImages, cells, list })

test('parses references: bare, rooted, relative and invalid', () => {
  expect(im.parseRef('hero.jpg')).toEqual({ raw: 'hero.jpg', dir: [], name: 'hero.jpg' })
  expect(im.parseRef(' /hero-images/a.jpg ')).toEqual({ raw: '/hero-images/a.jpg', dir: ['hero-images'], name: 'a.jpg' })
  expect(im.parseRef('./hero-images/sub/a.PNG')).toMatchObject({ dir: ['hero-images', 'sub'], name: 'a.PNG' })
  expect(im.parseRef('../secret/a.jpg').invalid).toMatch(/\.\./)
  expect(im.parseRef('a\\b.jpg').invalid).toBeDefined()
  expect(im.parseRef('headline text')).toBeNull()
  expect(im.parseRef('')).toBeNull()
})

test('collects image cells from CSV records, ignoring the header and text', () => {
  const recs = ['outputFileName,headline,hero', 'a,"Hi, there",/hero-images/x.jpg', 'b,Bye,y.png']
  expect([...im.csvImageCells(recs)].sort()).toEqual(['/hero-images/x.jpg', 'y.png'])
})

test('resolves a path from the job folder ("/" is the folder itself) and nested paths', async () => {
  const plan = await resolve(['/hero-images/myAwesomeImage.jpg', 'components/logos/logo.png'])
  expect(plan.resolved.map((r) => [r.ref, r.damPath, r.staged])).toEqual([
    ['/hero-images/myAwesomeImage.jpg', `${F}/hero-images/myAwesomeImage.jpg`, 'myAwesomeImage.jpg'],
    ['components/logos/logo.png', `${F}/components/logos/logo.png`, 'logo.png']
  ])
  expect(im.problems(plan, F)).toEqual([])
})

test('a bare name is found in the root first, then uniquely in subfolders', async () => {
  const plan = await resolve(['root.jpg', 'myAwesomeImage.jpg', 'logo.png'])
  expect(plan.resolved.map((r) => [r.ref, r.damPath])).toEqual([
    ['root.jpg', `${F}/root.jpg`],
    ['myAwesomeImage.jpg', `${F}/hero-images/myAwesomeImage.jpg`],
    ['logo.png', `${F}/components/logos/logo.png`]
  ])
})

test('a bare name matching several subfolder files is ambiguous; a path disambiguates', async () => {
  const plan = await resolve(['shared.png', '/hero-images/shared.png'])
  expect(plan.ambiguous).toHaveLength(1)
  expect(im.problems(plan, F)[0]).toMatch(/matches several files .*\/hero-images\/shared\.png.*\/components\/logos\/shared\.png/)
  expect(plan.resolved.map((r) => r.ref)).toEqual(['/hero-images/shared.png'])
})

test('output/ and fonts/ are never searched; missing refs are reported', async () => {
  const plan = await resolve(['result-in-output.jpg', 'font-preview.png', '/nope/x.jpg', 'ghost.jpg'])
  expect(plan.resolved).toEqual([])
  expect(plan.unresolved).toEqual([
    { ref: 'result-in-output.jpg', bare: true }, { ref: 'font-preview.png', bare: true },
    { ref: '/nope/x.jpg', bare: false }, { ref: 'ghost.jpg', bare: true }
  ])
  // INDD templates may still satisfy bare names via Asset Links, never missing paths
  expect(im.problems(plan, F, { allowBareUnresolved: true })).toEqual([`image "/nope/x.jpg" was not found in ${F}`])
})

test('references cannot leave the job folder', async () => {
  const plan = await resolve(['../other/a.jpg'])
  expect(im.problems(plan, F)[0]).toMatch(/\.\./)
})

test('same-named files in different places get distinct staged names; root names win', async () => {
  const plan = await resolve(['dup.jpg', '/hero-images/dup.jpg', '/hero-images/shared.png', '/components/logos/shared.png'])
  const staged = Object.fromEntries(plan.resolved.map((r) => [r.ref, r.staged]))
  expect(staged['dup.jpg']).toBe('dup.jpg') // the root file keeps its name
  expect(staged['/hero-images/dup.jpg']).toBe('hero-images__dup.jpg')
  expect(staged['/hero-images/shared.png']).toBe('shared.png')
  expect(staged['/components/logos/shared.png']).toBe('components__logos__shared.png')
  expect(new Set(Object.values(staged)).size).toBe(4)
})

test('two spellings of the same file share one staged name', async () => {
  const plan = await resolve(['/hero-images/myAwesomeImage.jpg', 'hero-images/myAwesomeImage.jpg', 'myAwesomeImage.jpg'])
  expect(new Set(plan.resolved.map((r) => r.staged))).toEqual(new Set(['myAwesomeImage.jpg']))
})

test('rewrites only the cells that change, keeps other records byte-for-byte', () => {
  const recs = ['outputFileName,headline,hero', 'a,"Line one\nline two",/hero-images/x.jpg', 'b,"Hi, ""you""",y.png']
  const out = im.rewriteRecords(recs, new Map([['/hero-images/x.jpg', 'x.jpg']]))
  expect(out[0]).toBe(recs[0])
  expect(out[1]).toBe('a,"Line one\nline two",x.jpg')
  expect(out[2]).toBe(recs[2])
  expect(im.rewriteRecords(recs, new Map())).toBe(recs)
})
