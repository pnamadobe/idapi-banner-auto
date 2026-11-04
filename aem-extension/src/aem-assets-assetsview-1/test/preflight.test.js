const fs = require('fs')
const path = require('path')
const im = require('../actions/generate-idapi-banners/images')
const { csvRecords } = require('../actions/generate-idapi-banners/csv')
const pf = require('../actions/generate-idapi-banners/preflight')

const F = '/content/dam/job'
const file = (name) => ({ name, isFolder: false })
const fixture = (n) => fs.readFileSync(path.join(__dirname, 'fixtures', 'preflight', n), 'utf8')

const PAGEMAP = 'pagenumber,pagename\n1,A\n2,B\n'
const IMAGES = ['dune-key-1.jpg', 'dune-key-2.jpg', 'dune-key-3.jpg', 'dune-key-4.jpg', 'dune-scrim.png', 'dune-prophecy-treatment.png', 'dune-blank.png']

// Resolve the CSV's image cells against a flat folder, as the engine does.
async function check (csvText, { names = IMAGES, pagemapText = PAGEMAP, ...rest } = {}) {
  const root = names.map(file)
  const plan = await im.resolveImageRefs({ folder: F, rootImages: root, cells: im.csvImageCells(csvRecords(csvText)), list: async () => [] })
  return pf.runPreflight({ csvText, pagemapText, plan, known: names, ...rest })
}
const codes = (r) => r.findings.map((f) => `${f.severity}:${f.code}`)
const find = (r, code) => r.findings.find((f) => f.code === code)

describe('preflight: fixtures from a real project', () => {
  test('a clean CSV is ok with no findings', async () => {
    const r = await check(fixture('12_ok_copy.csv'))
    expect(r.ok).toBe(true)
    expect(r.findings).toEqual([])
    expect(r.stats).toMatchObject({ rows: 12, pages: 2, outputs: 24 })
  })

  test('a typo\'d image name is an error at its row and column', async () => {
    const r = await check(fixture('01_typo_image.csv'))
    expect(r.ok).toBe(false)
    expect(find(r, 'IMG_MISSING')).toMatchObject({ severity: 'error', row: 2, column: 'hero' })
    expect(find(r, 'IMG_MISSING').message).toContain('dune-key-9.jpg')
  })

  test('a wrong-case image name is reported as case-only', async () => {
    const r = await check(fixture('02_wrong_case.csv'))
    expect(find(r, 'IMG_CASE_ONLY')).toMatchObject({ severity: 'error', row: 3 })
    expect(find(r, 'IMG_CASE_ONLY').message).toContain('dune-key-2.jpg')
    expect(find(r, 'IMG_MISSING')).toBeUndefined()
  })

  test('duplicate, empty and unsafe output names are errors', async () => {
    expect(find(await check(fixture('03_dup_name.csv')), 'OUTNAME_DUP')).toMatchObject({ severity: 'error', rows: [2, 3] })
    expect(find(await check(fixture('04_empty_name.csv')), 'OUTNAME_EMPTY')).toMatchObject({ severity: 'error', row: 4 })
    expect(find(await check(fixture('05_unsafe_name.csv')), 'OUTNAME_UNSAFE')).toMatchObject({ severity: 'error', row: 4 })
  })

  test('a BOM is only a warning', async () => {
    const r = await check(fixture('08_bom.csv'))
    expect(r.ok).toBe(true)
    expect(codes(r)).toEqual(['warn:CSV_BOM'])
  })

  test('an image name in a text column that does not exist is an error', async () => {
    const r = await check(fixture('09_image_in_text.csv'))
    expect(find(r, 'IMG_TEXT_MISSING')).toMatchObject({ severity: 'error', row: 2, column: 'status' })
  })

  test('a header-only CSV is an error and skips the per-row checks', async () => {
    const r = await check(fixture('10_no_rows.csv'))
    expect(codes(r)).toEqual(['error:CSV_NO_ROWS'])
  })

  test('an empty cell is a warning', async () => {
    const r = await check(fixture('11_blank_hero.csv'))
    expect(r.ok).toBe(true)
    expect(find(r, 'CELL_EMPTY')).toMatchObject({ severity: 'warn', row: 5, column: 'hero' })
  })

  test('an unknown header is caught against a PSD template (stage 2)', () => {
    const text = ['status', 'cta', 'offer', 'legal']
    const image = ['hero', 'scrimbottom', 'treatmentbottom', 'scrimtop', 'treatmenttop']
    const board = (id, name) => layer(id, name, 'artboard', {
      layers: [
        ...text.map((n, i) => layer(id + i + 1, n, 'text_layer')),
        ...image.map((n, i) => layer(id + 10 + i, n, 'smart_object_layer'))
      ]
    })
    const m = { layers: [board(100, 'A'), board(200, 'B')] }
    const r = pf.runPsdChecks({ csvText: fixture('06_unknown_header.csv'), pagemapText: PAGEMAP, manifest: m, stagedFonts: [] })
    expect(find(r, 'PSD_COLUMN_UNMATCHED')).toMatchObject({ severity: 'error', column: 'headline' })
    const ok = pf.runPsdChecks({ csvText: fixture('12_ok_copy.csv'), pagemapText: PAGEMAP, manifest: m, stagedFonts: [] })
    expect(ok.findings.filter((f) => f.code === 'PSD_COLUMN_UNMATCHED')).toEqual([])
  })
})

describe('preflight: not tied to any brand', () => {
  const csv = 'outputFileName,title,photo\nsummer-a,Hi,pics/beach.JPG\nsummer-b,Yo,pics/beach.JPG\n'

  test('resolves a path reference and passes', async () => {
    const root = []
    const list = async (d) => (d === `${F}/pics` ? [file('beach.JPG')] : [])
    const plan = await im.resolveImageRefs({ folder: F, rootImages: root, cells: im.csvImageCells(csvRecords(csv)), list })
    const r = pf.runPreflight({ csvText: csv, pagemapText: PAGEMAP, plan, known: ['pics/beach.JPG'] })
    expect(r.ok).toBe(true)
    expect(r.stats).toMatchObject({ rows: 2, pages: 2, outputs: 4, images: 1 })
  })

  test('reports a missing image with no brand-specific wording', async () => {
    const r = await check(csv, { names: [] })
    expect(find(r, 'IMG_MISSING')).toMatchObject({ severity: 'error', column: 'photo', rows: [2, 3] })
  })

  test('ragged rows, duplicate headers and a case-variant outputFileName header are reported', async () => {
    const r = await check('outputfilename,a,a\none,x\ntwo,y,z,extra\n', { names: [] })
    expect(codes(r)).toEqual(expect.arrayContaining(['error:CSV_HEADER_DUP', 'error:CSV_RAGGED', 'warn:OUTNAME_COLUMN_CASE']))
  })

  test('a CSV with no rows or no header is an error, never a crash', async () => {
    expect(find(await check(''), 'CSV_NO_ROWS')).toBeTruthy()
    expect(find(pf.runPreflight({ csvText: 'a,b\n1,2\n', pagemapText: '' }), 'PAGEMAP_EMPTY')).toBeTruthy()
  })
})

describe('preflight: image probes', () => {
  const csv = 'outputFileName,photo\na,one.jpg\nb,two.png\nc,three.png\n'
  const names = ['one.jpg', 'two.png', 'three.png']
  const probe = (size, dims) => ({ size, dims })

  test('a 0-byte image is an error; an unreadable header is a warning', async () => {
    const probes = new Map([
      [`${F}/one.jpg`, probe(0, null)],
      [`${F}/two.png`, probe(10, null)],
      [`${F}/three.png`, probe(999, { width: 4, height: 4 })]
    ])
    const r = await check(csv, { names, probes })
    expect(find(r, 'IMG_EMPTY')).toMatchObject({ severity: 'error', row: 2, column: 'photo' })
    expect(find(r, 'IMG_UNREADABLE')).toMatchObject({ severity: 'warn', row: 3 })
    expect(r.ok).toBe(false)
  })

  test('images that were not opened are summarised once', async () => {
    const probes = new Map([[`${F}/one.jpg`, probe(5, { width: 1, height: 1 })]])
    const r = await check(csv, { names, probes })
    expect(find(r, 'IMG_UNCHECKED')).toMatchObject({ severity: 'warn' })
    expect(find(r, 'IMG_UNCHECKED').message).toContain('2 images')
    expect(r.ok).toBe(true)
  })
})

describe('preflight: pagemap and volume', () => {
  const csv = 'outputFileName,t\na,x\nb,y\n'

  test('a page count that differs from the template is an error', async () => {
    const r = await check(csv, { names: [], templateFacts: { pageCount: 3 } })
    expect(find(r, 'PAGEMAP_COUNT')).toMatchObject({ severity: 'error' })
  })

  test('a matching page count passes', async () => {
    const r = await check(csv, { names: [], templateFacts: { pageCount: 2 } })
    expect(r.ok).toBe(true)
  })

  test('a duplicate page name is an error', async () => {
    const r = await check(csv, { names: [], pagemapText: 'pagenumber,pagename\n1,A\n2,A\n' })
    expect(find(r, 'PAGEMAP_DUP')).toMatchObject({ severity: 'error' })
  })

  test('a large job warns with the number of outputs', async () => {
    const rows = Array.from({ length: 150 }, (_, i) => `n${i},x`).join('\n')
    const r = await check(`outputFileName,t\n${rows}\n`, { names: [] })
    expect(find(r, 'VOLUME_HIGH')).toMatchObject({ severity: 'warn' })
    expect(find(r, 'VOLUME_HIGH').message).toContain('300')
    expect(r.ok).toBe(true)
  })

  test('the limit can be raised', async () => {
    const rows = Array.from({ length: 150 }, (_, i) => `n${i},x`).join('\n')
    const r = await check(`outputFileName,t\n${rows}\n`, { names: [], limits: { volumeWarn: 1000 } })
    expect(find(r, 'VOLUME_HIGH')).toBeUndefined()
  })

  test('row lists are capped but the total is kept', async () => {
    const rows = Array.from({ length: 40 }, (_, i) => `n${i},`).join('\n')
    const r = await check(`outputFileName,t\n${rows}\n`, { names: [] })
    const f = find(r, 'CELL_EMPTY')
    expect(f.rows.length).toBe(20)
    expect(f.rowsTotal).toBe(40)
  })
})

describe('preflight: errors sort before warnings', () => {
  test('findings are ordered by severity', async () => {
    const r = await check('﻿outputFileName,hero\na,nope.jpg\nb,\n', { names: [] })
    const sev = r.findings.map((f) => f.severity)
    expect(sev).toEqual([...sev].sort((a, b) => (a === b ? 0 : a === 'error' ? -1 : 1)))
    expect(r.errors.length).toBeGreaterThan(0)
    expect(r.warnings.length).toBeGreaterThan(0)
  })

  test('missing inputs become one error finding', () => {
    const r = pf.missingInputs('template is missing')
    expect(r.ok).toBe(false)
    expect(codes(r)).toEqual(['error:INPUT_MISSING'])
  })
})

// ---- stage 2 ----

const layer = (id, name, type, extra) => ({ id, name, type, ...extra })
const font = (postScriptName, isAvailable) => ({ text: { content: 'x', characterStyles: [{ font: { postScriptName, isAvailable } }] } })

function manifest (fonts = {}) {
  const board = (id, name) => layer(id, name, 'artboard', {
    layers: [
      layer(id + 1, 'status', 'text_layer', fonts.status || {}),
      layer(id + 2, 'cta', 'text_layer', {}),
      layer(id + 3, 'hero', 'smart_object_layer', {})
    ]
  })
  return { layers: [board(10, 'A'), board(20, 'B')] }
}

describe('preflight: Photoshop template checks', () => {
  const csv = 'outputFileName,status,cta,hero\na,Now,Go,one.jpg\n'

  test('a matching CSV and pagemap pass', () => {
    const r = pf.runPsdChecks({ csvText: csv, pagemapText: PAGEMAP, manifest: manifest(), stagedFonts: [] })
    expect(r.ok).toBe(true)
    expect(r.findings).toEqual([])
    expect(r.stats).toMatchObject({ rows: 1, pages: 2, outputs: 2 })
  })

  test('a pagemap artboard missing from the PSD lists what the PSD has', () => {
    const r = pf.runPsdChecks({ csvText: csv, pagemapText: 'pagenumber,pagename\n1,A\n2,C\n', manifest: manifest(), stagedFonts: [] })
    const f = find(r, 'PSD_PAGEMAP_MISSING')
    expect(f.severity).toBe('error')
    expect(f.message).toContain('"C"')
    expect(f.message).toContain('"A", "B"')
  })

  test('an unmatched column suggests the right-case layer name', () => {
    const r = pf.runPsdChecks({ csvText: 'outputFileName,Status\na,x\n', pagemapText: PAGEMAP, manifest: manifest(), stagedFonts: [] })
    expect(find(r, 'PSD_COLUMN_UNMATCHED').message).toContain('Did you mean "status"')
  })

  test('an image name in a text-layer column is an error; text in an image column warns', () => {
    const r = pf.runPsdChecks({ csvText: 'outputFileName,status,hero\na,pic.jpg,hello\n', pagemapText: PAGEMAP, manifest: manifest(), stagedFonts: [] })
    expect(find(r, 'PSD_IMAGE_IN_TEXT_LAYER')).toMatchObject({ severity: 'error', row: 2, column: 'status' })
    expect(find(r, 'PSD_TEXT_IN_IMAGE_LAYER')).toMatchObject({ severity: 'warn', row: 2, column: 'hero' })
  })

  test('a missing font warns unless a matching file is staged', () => {
    const m = manifest({ status: font('Poppins-SemiBold', false) })
    const lost = pf.runPsdChecks({ csvText: csv, pagemapText: PAGEMAP, manifest: m, stagedFonts: [] })
    expect(find(lost, 'PSD_FONT_MISSING')).toMatchObject({ severity: 'warn' })
    expect(find(lost, 'PSD_FONT_MISSING').message).toContain('Poppins-SemiBold')
    expect(lost.ok).toBe(true)
    const staged = pf.runPsdChecks({ csvText: csv, pagemapText: PAGEMAP, manifest: m, stagedFonts: ['Poppins-SemiBold.ttf'] })
    expect(find(staged, 'PSD_FONT_MISSING')).toBeUndefined()
  })

  test('available fonts and unknown manifest shapes produce no font finding', () => {
    expect(pf.fontsFromManifest(manifest({ status: font('Arial', true) }))).toEqual([{ name: 'Arial', available: true, layers: ['status'] }])
    expect(pf.fontsFromManifest(null)).toEqual([])
    expect(pf.fontsFromManifest({ layers: [{ name: 'x', text: { characterStyles: [{ weird: 1 }] } }] })).toEqual([])
  })

  test('a click-through column is not a layer and is never checked against one', () => {
    const r = pf.runPsdChecks({ csvText: 'outputFileName,status,clickthru,CTA URL\na,Now,,https://x.example\n', pagemapText: PAGEMAP, manifest: manifest(), stagedFonts: [] })
    expect(r.findings).toEqual([])
  })

  test('a template with no artboards is an error', () => {
    const r = pf.runPsdChecks({ csvText: csv, pagemapText: PAGEMAP, manifest: { layers: [] }, stagedFonts: [] })
    expect(codes(r)).toContain('error:PSD_NO_ARTBOARDS')
  })
})

describe('summarize', () => {
  const err = (message) => ({ severity: 'error', code: 'X', message })

  test('names the first three errors and counts the rest', () => {
    const s = pf.summarize([err('One.'), err('Two.'), err('Three.'), err('Four.'), { severity: 'warn', code: 'W', message: 'Warn.' }])
    expect(s).toContain('4 problems')
    expect(s).toContain('One. Two. Three.')
    expect(s).toContain('(and 1 more)')
    expect(s).not.toContain('Warn.')
  })

  test('says so when there are no errors', () => {
    expect(pf.summarize([{ severity: 'warn', code: 'W', message: 'w' }])).toMatch(/no errors/)
  })
})

describe('INDD template gate payload (from the registered capability script)', () => {
  const f = (over) => ({ severity: 'error', code: 'INDD_IMG_MISSING', message: 'row 2: hero "nope.jpg" was not found', rows: [2], column: 'hero', ...over })

  test('parsePreflightPayload finds the array after the marker, whatever surrounds it', () => {
    const payload = JSON.stringify([f(), f({ code: 'INDD_FONT_MISSING', message: 'brackets ] and [ "quotes" in text' })])
    const wrapped = `script error: PREFLIGHT:${payload} at line 12 [stack]`
    expect(pf.parsePreflightPayload(wrapped)).toEqual(JSON.parse(payload))
  })

  test('parsePreflightPayload returns null when there is no usable payload', () => {
    expect(pf.parsePreflightPayload('render failed: boom')).toBeNull()
    expect(pf.parsePreflightPayload('PREFLIGHT: nothing here')).toBeNull()
    expect(pf.parsePreflightPayload('PREFLIGHT:[{"code": ')).toBeNull()
    expect(pf.parsePreflightPayload('PREFLIGHT:[not json]')).toBeNull()
    expect(pf.parsePreflightPayload('PREFLIGHT:{"a":1}')).toBeNull()
    expect(pf.parsePreflightPayload(undefined)).toBeNull()
  })

  test('sanitizeIndFindings keeps only INDD_* findings and rebuilds their shape', () => {
    const out = pf.sanitizeIndFindings([
      f({ rows: [2, 3, 'x', -1, 2.5], rowsTotal: 40, evil: '<script>' }),
      f({ code: 'CSV_BOM' }),
      f({ code: 'indd_lower' }),
      null,
      'str',
      f({ severity: 'bogus', code: 'INDD_FONT_UNKNOWN', rows: undefined, column: undefined })
    ])
    expect(out.map((x) => x.code)).toEqual(['INDD_IMG_MISSING', 'INDD_FONT_UNKNOWN'])
    expect(out[0]).toEqual({ severity: 'error', code: 'INDD_IMG_MISSING', message: 'row 2: hero "nope.jpg" was not found', rows: [2, 3], rowsTotal: 40, column: 'hero' })
    expect(out[0]).not.toHaveProperty('evil')
    expect(out[1].severity).toBe('warn')
  })

  test('sanitizeIndFindings clips long messages, puts errors first and caps the count', () => {
    expect(pf.sanitizeIndFindings([f({ message: 'x'.repeat(5000) })])[0].message).toHaveLength(400)
    const mixed = [f({ severity: 'warn', code: 'INDD_FONT_UNKNOWN' }), f()]
    expect(pf.sanitizeIndFindings(mixed).map((x) => x.severity)).toEqual(['error', 'warn'])
    expect(pf.sanitizeIndFindings(Array.from({ length: 100 }, () => f()))).toHaveLength(pf.MAX_STORED_FINDINGS)
    expect(pf.sanitizeIndFindings('nope')).toEqual([])
  })
})

describe('csvRecords', () => {
  test('a cell ending in an escaped quote does not swallow the next rows', () => {
    expect(csvRecords('a,b\n1,"say ""hi"""\n2,c\n')).toEqual(['a,b', '1,"say ""hi"""', '2,c'])
    expect(csvRecords('a\n"x\ny"\nz\n')).toEqual(['a', '"x\ny"', 'z'])
  })
})

test('an empty click-through cell is not an empty-cell warning', async () => {
  const r = await check('outputFileName,status,clickthru\na,Now,\nb,Later,https://x.example\n')
  expect(r.findings.filter((f) => f.code === 'CELL_EMPTY')).toEqual([])
  expect(r.ok).toBe(true)
})
