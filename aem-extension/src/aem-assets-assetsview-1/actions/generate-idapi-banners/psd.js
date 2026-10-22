/*
 * Photoshop (PSD) template support — pure helpers; no I/O.
 *
 * A PSD template is a document with one artboard per banner size. Layers are
 * matched to CSV columns by *layer name* (the PSD analogue of an InDesign Script
 * Label): a text layer named "headline" takes the "headline" column, a smart
 * object named "hero" takes the image file named in the "hero" column. The same
 * names repeat on every artboard, so edits address layers by id from the manifest.
 *
 * Rendering uses Photoshop API v2 (POST /v2/create-composite): one call per CSV
 * row applies every edit and emits one JPEG per artboard.
 */

const { IMAGE_RE } = require('./links')

// Split one CSV record (RFC-4180, may contain quoted line breaks) into cells.
function splitRecord (rec) {
  const cells = []
  let cell = ''
  let quoted = false
  for (let i = 0; i < rec.length; i++) {
    const ch = rec[i]
    if (quoted) {
      if (ch === '"' && rec[i + 1] === '"') { cell += '"'; i++ } else if (ch === '"') quoted = false
      else cell += ch
    } else if (ch === '"') quoted = true
    else if (ch === ',') { cells.push(cell); cell = '' } else cell += ch
  }
  cells.push(cell)
  return cells
}

// records: array of CSV record strings (header first) -> [{ column: value }]
function rowsFromRecords (records) {
  if (!records.length) return []
  const header = splitRecord(records[0]).map((h) => h.trim())
  return records.slice(1).map((rec) => {
    const cells = splitRecord(rec)
    const row = {}
    header.forEach((h, i) => { if (h) row[h] = cells[i] == null ? '' : cells[i] })
    return row
  })
}

// Pagemap records -> ordered artboard names ("pagenumber,pagename").
function pagemapNames (records) {
  return rowsFromRecords(records)
    .sort((a, b) => Number(a.pagenumber) - Number(b.pagenumber))
    .map((r) => String(r.pagename || '').trim())
    .filter(Boolean)
}

// Manifest -> [{ id, name, layers: Map(name -> { id, type }) }] for each top-level artboard.
// Layer names repeat across artboards, so the Map is per artboard. Nested groups are searched.
function artboardsFromManifest (manifest) {
  const flat = (layers, into) => {
    for (const l of layers || []) {
      if (l.type === 'group_layer' || l.type === 'artboard') flat(l.layers, into)
      else if (!into.has(l.name)) into.set(l.name, { id: l.id, type: l.type, frame: l.referenceFrame || null })
    }
    return into
  }
  return (manifest.layers || []).filter((l) => l.type === 'artboard').map((a) => {
    const layers = flat(a.layers, new Map())
    const rect = a.typeAttributes && a.typeAttributes.artboard && a.typeAttributes.artboard.artboardRect
    const band = layers.get('band')
    return {
      id: a.id,
      name: a.name,
      layers,
      rect: rect ? { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom } : null,
      // Layouts with a content band below the photo (tall/square sizes): the photo area ends where it starts.
      bandTop: band && band.frame ? band.frame.top : null
    }
  })
}

// Keep only artboards listed in the pagemap (in pagemap order). A pagemap name with no
// matching artboard is reported, not silently dropped.
function selectArtboards (artboards, names) {
  const byName = new Map(artboards.map((a) => [a.name, a]))
  const selected = []
  const missing = []
  for (const n of names) { if (byName.has(n)) selected.push(byName.get(n)); else missing.push(n) }
  return { selected, missing }
}

const isImageCell = (v) => IMAGE_RE.test(String(v || '').trim())

// Which CSV columns drive which layers, for preflight: columns with a same-named
// layer on at least one selected artboard.
function mapColumns (columns, artboards) {
  const layerKinds = new Map()
  for (const a of artboards) for (const [name, l] of a.layers) if (!layerKinds.has(name)) layerKinds.set(name, l.type)
  const text = []
  const image = []
  const unmatched = []
  for (const c of columns) {
    const kind = layerKinds.get(c)
    if (kind === 'text_layer') text.push(c)
    else if (kind === 'smart_object_layer') image.push(c)
    else if (c !== 'outputFileName') unmatched.push(c)
  }
  return { text, image, unmatched }
}

// Pixel size of a PNG or JPEG from its header; null if unrecognised.
function imageSize (buf) {
  if (buf.length >= 24 && buf.readUInt32BE(0) === 0x89504e47) return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) }
  if (buf.length > 4 && buf[0] === 0xff && buf[1] === 0xd8) {
    let i = 2
    while (i + 9 < buf.length) {
      if (buf[i] !== 0xff) { i++; continue }
      const marker = buf[i + 1]
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) }
      i += 2 + buf.readUInt16BE(i + 2)
    }
  }
  return null
}

// The photo frame a designer would draw for a visible area: a box of aspect `frameAspect` that
// covers the area, left-aligned and vertically centred. When it is wider than the area, the
// right-hand side is cropped, so the LEFT of the photo stays prominent (matches the InDesign
// template, whose hero frames are all the same wide aspect and extend past the page).
function heroFrame (area, frameAspect) {
  const W = area.right - area.left
  const H = area.bottom - area.top
  const width = W / H >= frameAspect ? W : H * frameAspect
  const height = W / H >= frameAspect ? W / frameAspect : H
  const top = area.top + (H - height) / 2
  return { left: area.left, top, right: area.left + width, bottom: top + height }
}

// Cover-fit transform for a full-bleed smart-object layer (the hero): scale the photo uniformly to
// cover `target` (the photo frame), centred on it; the artboard crops the overflow.
// Requires smartObject.autoResize:false (the layer's canvas becomes the photo's native size, so the
// custom dimension is exactly the photo's displayed size; the default autoResize would CROP the
// photo to the placeholder canvas's aspect first) and an unlinked pixel mask (otherwise the mask
// scales with the layer and the photo bleeds past the template's visible area).
// Offsets are top-left document coordinates. Verified live against InDesign renders of the same photos.
function coverTransform (target, size) {
  const W = target.right - target.left
  const H = target.bottom - target.top
  const s = Math.max(W / size.width, H / size.height)
  const width = size.width * s
  const height = size.height * s
  return {
    dimension: { width: Math.round(width), height: Math.round(height) },
    offset: { horizontal: Math.round(target.left + W / 2 - width / 2), vertical: Math.round(target.top + H / 2 - height / 2) }
  }
}

const psdOutputName = (row, index) => `${String(row.outputFileName || `row${index + 1}`).trim()}.psd`
const outputName = (artboard, row, index) => `${artboard.name}_${String(row.outputFileName || `row${index + 1}`).trim()}.jpg`

// One create-composite request body for one CSV row.
//   sourceUrl: presigned URL of the PSD; fontUrls: [url]; imageUrl(name) -> presigned URL
function buildComposite ({ sourceUrl, fontUrls = [], artboards, row, imageUrl, imageDims = () => null, heroFrameAspect = 0, includePsd = false, validityPeriod = 3600 }) {
  const layers = []
  for (const a of artboards) {
    for (const [name, l] of a.layers) {
      const value = row[name]
      if (value == null || value === '') continue
      if (l.type === 'text_layer') {
        layers.push({ id: l.id, type: 'text_layer', operation: { type: 'edit' }, text: { content: String(value).replace(/\r?\n/g, '\r') } })
      } else if (l.type === 'smart_object_layer' && isImageCell(value)) {
        const file = String(value).trim().split('/').pop()
        const size = imageDims(file)
        const edit = { id: l.id, type: 'smart_object_layer', operation: { type: 'edit' }, smartObject: { smartObjectFile: { source: { url: imageUrl(file) } } } }
        // Full-bleed layers (frame spans the artboard width, i.e. the hero) are cover-fitted;
        // smaller ones (card, qr) keep the API's default fit-inside behaviour.
        const r = a.rect
        const fullBleed = size && l.frame && r && l.frame.left <= r.left && l.frame.right >= r.right
        if (fullBleed) {
          const area = { left: r.left, top: r.top, right: r.right, bottom: a.bandTop != null ? a.bandTop : r.bottom }
          const target = heroFrameAspect > 0 ? heroFrame(area, heroFrameAspect) : area
          edit.smartObject.autoResize = false
          edit.pixelMask = { isLinked: false }
          edit.transformMode = 'custom'
          edit.transform = coverTransform(target, size)
        }
        layers.push(edit)
      }
    }
  }
  return {
    image: { source: { url: sourceUrl } },
    fontOptions: { additionalFonts: fontUrls.map((url) => ({ source: { url } })), missingFontStrategy: 'fail' },
    edits: { layers },
    outputs: artboards.map((a) => ({
      destination: { validityPeriod },
      mediaType: 'image/jpeg',
      layers: [{ id: a.id, shouldIncludeChildren: true }],
      cropMode: 'layer_bounds'
    })).concat(includePsd ? [{ destination: { validityPeriod }, mediaType: 'image/vnd.adobe.photoshop' }] : []) // editable PSD (all artboards) is always last
  }
}

module.exports = { splitRecord, rowsFromRecords, pagemapNames, artboardsFromManifest, selectArtboards, mapColumns, outputName, psdOutputName, buildComposite, imageSize, coverTransform, heroFrame, isImageCell }
