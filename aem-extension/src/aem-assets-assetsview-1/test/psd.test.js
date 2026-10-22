const psd = require('../actions/generate-idapi-banners/psd')

// Minimal manifest in the shape returned by POST /v2/generate-manifest (ids are per layer, names repeat per artboard).
const layer = (id, name, type) => ({ id, name, type })
const frame = { left: 100, top: 0, right: 1100, bottom: 400 }
const manifest = {
  layers: [
    { id: 6, name: 'WEB_A_100x50', type: 'artboard', layers: [layer(4, 'bgfill', 'group_layer'), { ...layer(11, 'hero', 'smart_object_layer'), referenceFrame: frame }, layer(14, 'headline', 'text_layer'), layer(15, 'highlight-button', 'solid_color_layer')] },
    { id: 25, name: 'WEB_B_200x50', type: 'artboard', layers: [layer(30, 'hero', 'smart_object_layer'), layer(31, 'headline', 'text_layer'), { id: 40, name: 'grp', type: 'group_layer', layers: [layer(41, 'cardname', 'text_layer')] }] },
    { id: 99, name: 'stray', type: 'solid_color_layer' }
  ]
}

test('reads artboards and per-artboard layer ids, searching nested groups', () => {
  const ab = psd.artboardsFromManifest(manifest)
  expect(ab.map((a) => a.name)).toEqual(['WEB_A_100x50', 'WEB_B_200x50'])
  expect(ab[0].layers.get('headline')).toEqual({ id: 14, type: 'text_layer', frame: null })
  expect(ab[1].layers.get('headline')).toEqual({ id: 31, type: 'text_layer', frame: null })
  expect(ab[1].layers.get('cardname').id).toBe(41)
})

test('pagemap selects artboards in order and reports missing ones', () => {
  const names = psd.pagemapNames(['pagenumber,pagename', '2,WEB_A_100x50', '1,WEB_B_200x50', '3,NOPE'])
  expect(names).toEqual(['WEB_B_200x50', 'WEB_A_100x50', 'NOPE'])
  const { selected, missing } = psd.selectArtboards(psd.artboardsFromManifest(manifest), names)
  expect(selected.map((a) => a.name)).toEqual(['WEB_B_200x50', 'WEB_A_100x50'])
  expect(missing).toEqual(['NOPE'])
})

test('parses CSV rows including quoted line breaks', () => {
  const rows = psd.rowsFromRecords(['outputFileName,headline,cardname,hero', 'a,"HI, THERE","LINDA\nWALKER",x.png'])
  expect(rows).toEqual([{ outputFileName: 'a', headline: 'HI, THERE', cardname: 'LINDA\nWALKER', hero: 'x.png' }])
})

test('builds one composite per row: edits by id, one JPEG output per artboard', () => {
  const artboards = psd.artboardsFromManifest(manifest)
  const row = { outputFileName: 'ski', headline: 'TAP', cardname: 'A\nB', hero: 'ski.png', missingcol: 'z' }
  const body = psd.buildComposite({ sourceUrl: 'https://s/p.psd', fontUrls: ['https://s/f.ttf'], artboards, row, imageUrl: (n) => `https://s/${n}` })
  expect(body.edits.layers).toEqual([
    { id: 11, type: 'smart_object_layer', operation: { type: 'edit' }, smartObject: { smartObjectFile: { source: { url: 'https://s/ski.png' } } } },
    { id: 14, type: 'text_layer', operation: { type: 'edit' }, text: { content: 'TAP' } },
    { id: 30, type: 'smart_object_layer', operation: { type: 'edit' }, smartObject: { smartObjectFile: { source: { url: 'https://s/ski.png' } } } },
    { id: 31, type: 'text_layer', operation: { type: 'edit' }, text: { content: 'TAP' } },
    { id: 41, type: 'text_layer', operation: { type: 'edit' }, text: { content: 'A\rB' } }
  ])
  expect(body.outputs.map((o) => o.layers[0].id)).toEqual([6, 25])
  expect(body.outputs.every((o) => o.mediaType === 'image/jpeg')).toBe(true)
  expect(body.fontOptions).toEqual({ additionalFonts: [{ source: { url: 'https://s/f.ttf' } }], missingFontStrategy: 'fail' })
})

test('maps CSV columns to layer kinds and flags unmatched ones', () => {
  const m = psd.mapColumns(['outputFileName', 'headline', 'hero', 'bogus'], psd.artboardsFromManifest(manifest))
  expect(m).toEqual({ text: ['headline'], image: ['hero'], unmatched: ['bogus'] })
})

test('output names follow <artboard>_<outputFileName>.jpg', () => {
  expect(psd.outputName({ name: 'WEB_A_100x50' }, { outputFileName: 'ski' }, 0)).toBe('WEB_A_100x50_ski.jpg')
  expect(psd.outputName({ name: 'X' }, {}, 2)).toBe('X_row3.jpg')
})

test('cover-fit: photo scaled to cover the target, centred', () => {
  const target = { left: 100, top: 0, right: 1100, bottom: 500 }
  expect(psd.coverTransform(target, { width: 2500, height: 1000 })).toEqual({ dimension: { width: 1250, height: 500 }, offset: { horizontal: -25, vertical: 0 } })
  expect(psd.coverTransform(target, { width: 750, height: 1000 })).toEqual({ dimension: { width: 1000, height: 1333 }, offset: { horizontal: 100, vertical: -417 } })
  expect(psd.coverTransform(target, { width: 2000, height: 1000 })).toEqual({ dimension: { width: 1000, height: 500 }, offset: { horizontal: 100, vertical: 0 } })
})

test('artboards expose their rect and the content-band top', () => {
  const m = { layers: [{ id: 1, name: 'A', type: 'artboard', typeAttributes: { artboard: { artboardRect: { left: 0, top: 0, right: 300, bottom: 600 } } },
    layers: [{ id: 2, name: 'band', type: 'shape_layer', referenceFrame: { left: 0, top: 210, right: 300, bottom: 600 } }, { id: 3, name: 'hero', type: 'smart_object_layer', referenceFrame: { left: 0, top: 0, right: 377, bottom: 210 } }] }] }
  const [a] = psd.artboardsFromManifest(m)
  expect(a.rect).toEqual({ left: 0, top: 0, right: 300, bottom: 600 })
  expect(a.bandTop).toBe(210)
})

test('hero is cover-fitted to the artboard above the band with its mask unlinked; card/qr are left alone', () => {
  const m = { layers: [{ id: 1, name: 'A', type: 'artboard', typeAttributes: { artboard: { artboardRect: { left: 0, top: 0, right: 300, bottom: 600 } } },
    layers: [
      { id: 2, name: 'band', type: 'shape_layer', referenceFrame: { left: 0, top: 210, right: 300, bottom: 600 } },
      { id: 3, name: 'hero', type: 'smart_object_layer', referenceFrame: { left: 0, top: 0, right: 377, bottom: 210 } },
      { id: 4, name: 'card', type: 'smart_object_layer', referenceFrame: { left: 20, top: 300, right: 200, bottom: 400 } }] }] }
  const body = psd.buildComposite({ sourceUrl: 's', artboards: psd.artboardsFromManifest(m), row: { hero: 'h.png', card: 'c.png' }, imageUrl: (n) => n, imageDims: () => ({ width: 1700, height: 688 }) })
  const [hero, card] = body.edits.layers
  expect(hero).toMatchObject({ id: 3, pixelMask: { isLinked: false }, transformMode: 'custom' })
  expect(hero.smartObject.autoResize).toBe(false) // canvas = photo's native size
  const w = hero.transform.dimension.width
  expect(hero.transform.offset.horizontal).toBe(Math.round(150 - w / 2))
  expect(card).toEqual({ id: 4, type: 'smart_object_layer', operation: { type: 'edit' }, smartObject: { smartObjectFile: { source: { url: 'c.png' } } } })
})

test('reads PNG and JPEG sizes from headers', () => {
  const png = Buffer.alloc(24); png.writeUInt32BE(0x89504e47, 0); png.writeUInt32BE(1700, 16); png.writeUInt32BE(688, 20)
  expect(psd.imageSize(png)).toEqual({ width: 1700, height: 688 })
  const jpg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 4, 0, 0, 0xff, 0xc0, 0, 11, 8, 0x02, 0xb0, 0x06, 0xa4, 3, 0, 0, 0])
  expect(psd.imageSize(jpg)).toEqual({ width: 1700, height: 688 })
  expect(psd.imageSize(Buffer.from('nope'))).toBeNull()
})

test('editable PSD output is appended last, without an artboard filter', () => {
  const ab = psd.artboardsFromManifest(manifest)
  const body = psd.buildComposite({ sourceUrl: 's', artboards: ab, row: {}, imageUrl: (n) => n, includePsd: true })
  expect(body.outputs).toHaveLength(3)
  expect(body.outputs[2]).toEqual({ destination: { validityPeriod: 3600 }, mediaType: 'image/vnd.adobe.photoshop' })
  expect(psd.psdOutputName({ outputFileName: 'ski' }, 0)).toBe('ski.psd')
})

test('hero frame: wide frame anchored left, vertically centred; matches the InDesign frames', () => {
  const FA = 1700 / 688
  // APP_CARD photo area 890x520 -> frame 1285x520 starting at the artboard's left edge
  const f = psd.heroFrame({ left: 9040, top: 0, right: 9930, bottom: 520 }, FA)
  expect([f.left, f.top, Math.round(f.right - f.left), Math.round(f.bottom - f.top)]).toEqual([9040, 0, 1285, 520])
  // leaderboard 1000x320 -> width-limited: 1000 x 405, centred vertically (extends past top and bottom)
  const g = psd.heroFrame({ left: 0, top: 896, right: 1000, bottom: 1216 }, FA)
  expect([g.left, Math.round(g.top), Math.round(g.right - g.left), Math.round(g.bottom - g.top)]).toEqual([0, 854, 1000, 405])
})

test('hero is cover-fitted to the wide frame, so the photo extends past the right edge', () => {
  const m = { layers: [{ id: 1, name: 'A', type: 'artboard', typeAttributes: { artboard: { artboardRect: { left: 0, top: 0, right: 890, bottom: 1335 } } },
    layers: [
      { id: 2, name: 'band', type: 'shape_layer', referenceFrame: { left: 0, top: 520, right: 890, bottom: 1335 } },
      { id: 3, name: 'hero', type: 'smart_object_layer', referenceFrame: { left: 0, top: 0, right: 932, bottom: 520 } }] }] }
  const ab = psd.artboardsFromManifest(m)
  const area = psd.buildComposite({ sourceUrl: 's', artboards: ab, row: { hero: 'h.png' }, imageUrl: (n) => n, imageDims: () => ({ width: 2752, height: 1536 }), heroFrameAspect: 0 }).edits.layers[0].transform
  const framed = psd.buildComposite({ sourceUrl: 's', artboards: ab, row: { hero: 'h.png' }, imageUrl: (n) => n, imageDims: () => ({ width: 2752, height: 1536 }), heroFrameAspect: 1700 / 688 }).edits.layers[0].transform
  expect(framed.dimension.width).toBeGreaterThan(area.dimension.width) // zoomed in: only the left part is shown
  expect(framed.offset.horizontal).toBeGreaterThan(-1) // left edge of the photo area stays at/inside the page's left
  expect(framed.offset.horizontal + framed.dimension.width).toBeGreaterThan(890) // photo overhangs the right edge
})

test('editable-only PSD runs request just the PSD output', () => {
  const ab = psd.artboardsFromManifest(manifest)
  const only = psd.buildComposite({ sourceUrl: 's', artboards: ab, row: {}, imageUrl: (n) => n, includePsd: true, includeJpegs: false })
  expect(only.outputs).toEqual([{ destination: { validityPeriod: 3600 }, mediaType: 'image/vnd.adobe.photoshop' }])
  const both = psd.buildComposite({ sourceUrl: 's', artboards: ab, row: {}, imageUrl: (n) => n, includePsd: true })
  expect(both.outputs).toHaveLength(ab.length + 1)
})
