/*
 * Preflight - decide, before anything is rendered, whether the job's inputs will run.
 *
 * Pure: no I/O. The caller (engine.js) lists and probes the job folder and passes the
 * results in, so the same checks work for any brand, template or storage.
 *
 * A finding is { severity: 'error' | 'warn', code, message, row?, rows?, rowsTotal?, column? }.
 * `code` is a stable string the UI and tests key on. Row numbers are spreadsheet rows (the
 * header is row 1). A problem that repeats is reported once, with the rows it affects.
 *
 *   runPreflight  - stage 1: needs only the CSV text, the page map and the image catalog
 *   runPsdChecks  - stage 2: needs the Photoshop manifest (first batch of a PSD job)
 */

const { csvRecords } = require('./csv')
const { splitRecord, pagemapNames, artboardsFromManifest, selectArtboards, mapColumns, isImageCell } = require('./psd')
const { parseRef } = require('./images')
const { dropClickthroughColumns } = require('./html5')

const OUTPUT_COLUMN = 'outputFileName'
const OUTNAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/
const OUTNAME_MAX = 120
const ROWS_LISTED = 20
const DEFAULT_LIMITS = { volumeWarn: 200 }

const plural = (n, one, many) => `${n} ${n === 1 ? one : (many || one + 's')}`
const rowsText = (rows) => rows.length === 1 ? `row ${rows[0]}` : `rows ${rows.slice(0, 5).join(', ')}${rows.length > 5 ? ', ...' : ''}`

// Where a finding applies: one row, or the first ROWS_LISTED rows plus the total.
function where (rows, column) {
  const out = {}
  if (column) out.column = column
  if (!rows || !rows.length) return out
  if (rows.length === 1) out.row = rows[0]
  else { out.rows = rows.slice(0, ROWS_LISTED); out.rowsTotal = rows.length }
  return out
}

function collector () {
  const findings = []
  const add = (severity, code, message, rows, column) => findings.push({ severity, code, message, ...where(rows, column) })
  return { findings, error: (...a) => add('error', ...a), warn: (...a) => add('warn', ...a) }
}

// CSV text -> { bom, header, rows: [{ row, cells }] }. Same record splitting the render uses, and
// like the render it never sees a click-through column (that is for the HTML5 ads only).
function parseCsv (csvText) {
  const raw = String(csvText || '')
  const records = csvRecords(dropClickthroughColumns(raw).text)
  return {
    bom: raw.charCodeAt(0) === 0xFEFF,
    header: records.length ? splitRecord(records[0]).map((h) => h.trim()) : [],
    rows: records.slice(1).map((rec, i) => ({ row: i + 2, cells: splitRecord(rec) }))
  }
}

const cellOf = (r, col) => String(r.cells[col] == null ? '' : r.cells[col]).trim()

// Rows, header, ragged rows and the output file name column.
function checkStructure (csv, c) {
  const { header, rows } = csv
  if (csv.bom) c.warn('CSV_BOM', 'The variations CSV starts with a byte-order mark (BOM). The first column name is read correctly, but re-save the file as plain UTF-8 to be safe.')
  if (!header.length) { c.error('CSV_NO_ROWS', 'The variations CSV is empty.'); return }
  if (!rows.length) c.error('CSV_NO_ROWS', 'The variations CSV has a header but no data rows, so nothing would be generated.')

  const seen = new Map()
  header.forEach((h, i) => {
    if (!h) {
      const used = rows.filter((r) => cellOf(r, i)).map((r) => r.row)
      if (used.length) c.error('CSV_HEADER_EMPTY', `Column ${i + 1} has no name but holds values (${rowsText(used)}); those values would be ignored. Name the column or delete it.`, used)
    } else seen.set(h, (seen.get(h) || 0) + 1)
  })
  for (const [h, n] of seen) {
    if (n > 1) c.error('CSV_HEADER_DUP', `Column "${h}" appears ${n} times; only the last one would be used.`, null, h)
  }
  if (!seen.has(OUTPUT_COLUMN)) {
    const near = header.find((h) => h.toLowerCase() === OUTPUT_COLUMN.toLowerCase())
    if (near) c.warn('OUTNAME_COLUMN_CASE', `Column "${near}" is not read as "${OUTPUT_COLUMN}" (names are case-sensitive), so files would be named row1, row2, ...`, null, near)
  }

  const ragged = rows.filter((r) => r.cells.length < header.length || r.cells.slice(header.length).some((x) => String(x).trim()))
  if (ragged.length) {
    const r = ragged[0]
    c.error('CSV_RAGGED', `${plural(ragged.length, 'row')} ${ragged.length === 1 ? 'has' : 'have'} a different number of cells than the header (${header.length} columns); row ${r.row} has ${r.cells.length}. A missing or extra comma shifts values into the wrong columns.`, ragged.map((x) => x.row))
  }
}

// outputFileName: empty, unsafe and duplicate values (duplicates silently overwrite each other).
function checkOutputNames (csv, c) {
  const col = csv.header.indexOf(OUTPUT_COLUMN)
  if (col < 0 || !csv.rows.length) return
  const empty = []
  const unsafe = []
  const bySlug = new Map()
  for (const r of csv.rows) {
    const v = cellOf(r, col)
    if (!v) { empty.push(r.row); continue }
    if (!OUTNAME_RE.test(v) || v.length > OUTNAME_MAX) unsafe.push({ row: r.row, v })
    const k = v.toLowerCase()
    if (!bySlug.has(k)) bySlug.set(k, { v, rows: [] })
    bySlug.get(k).rows.push(r.row)
  }
  if (empty.length) c.error('OUTNAME_EMPTY', `${OUTPUT_COLUMN} is empty in ${rowsText(empty)}; the output file would be named after its row number and could be overwritten later.`, empty, OUTPUT_COLUMN)
  if (unsafe.length) {
    const eg = unsafe.slice(0, 3).map((u) => `"${u.v}"`).join(', ')
    c.error('OUTNAME_UNSAFE', `${OUTPUT_COLUMN} may use only letters, digits, "." "_" and "-" (starting with a letter or digit, up to ${OUTNAME_MAX} characters): ${eg}${unsafe.length > 3 ? ', ...' : ''}.`, unsafe.map((u) => u.row), OUTPUT_COLUMN)
  }
  for (const { v, rows } of bySlug.values()) {
    if (rows.length > 1) c.error('OUTNAME_DUP', `${OUTPUT_COLUMN} "${v}" is used by ${rowsText(rows)}; later rows would overwrite the earlier ones (names are compared ignoring case).`, rows, OUTPUT_COLUMN)
  }
}

// ---- images -------------------------------------------------------------------------------

// Every image-like cell: ref (trimmed cell text) -> [{ row, col }].
function imageOccurrences (csv) {
  const occ = new Map()
  for (const r of csv.rows) {
    r.cells.forEach((cell, col) => {
      const p = parseRef(cell)
      if (!p) return
      if (!occ.has(p.raw)) occ.set(p.raw, [])
      occ.get(p.raw).push({ row: r.row, col })
    })
  }
  return occ
}

// Column index -> 'image' | 'text'. A column is an image column when most of its values are
// image file names (or when the template says so); a stray image name in a text column is a typo.
function columnKinds (csv, templateFacts) {
  const named = templateFacts && Array.isArray(templateFacts.imageColumns) ? new Set(templateFacts.imageColumns) : null
  return csv.header.map((h, col) => {
    if (named) return named.has(h) ? 'image' : 'text'
    const values = csv.rows.map((r) => cellOf(r, col)).filter(Boolean)
    const images = values.filter((v) => parseRef(v)).length
    return values.length && images * 2 >= values.length ? 'image' : 'text'
  })
}

// Lower-cased lookup of the files the job folder holds, to tell "wrong case" from "missing".
function caseIndex (known) {
  const byPath = new Map()
  const byName = new Map()
  for (const p of known || []) {
    byPath.set(p.toLowerCase(), p)
    const base = p.split('/').pop().toLowerCase()
    if (!byName.has(base)) byName.set(base, p)
  }
  return (ref) => {
    const l = ref.toLowerCase()
    return byPath.get(l) || (l.includes('/') ? null : byName.get(l)) || null
  }
}

const uniqueRows = (occs) => [...new Set(occs.map((o) => o.row))]
const columnOf = (csv, occs) => {
  const cols = new Set(occs.map((o) => csv.header[o.col]).filter(Boolean))
  return cols.size === 1 ? [...cols][0] : undefined
}

// plan: resolveImageRefs output. known: job-folder-relative paths seen while listing.
// probes: Map(damPath -> { size, dims }) for the images that were opened (optional).
function checkImages (csv, c, { plan, known, probes }, kinds) {
  const occ = imageOccurrences(csv)
  const inText = (o) => kinds[o.col] === 'text'
  const caseMatch = caseIndex(known)
  const split = (ref) => {
    const all = occ.get(ref) || []
    return { all, img: all.filter((o) => !inText(o)), txt: all.filter(inText) }
  }

  for (const u of plan.unresolved) {
    const o = split(u.ref)
    const other = caseMatch(u.ref)
    if (other) {
      c.error('IMG_CASE_ONLY', `Image "${u.ref}" is not found, but "${other}" is the same name in different letter case. Names are matched exactly, so rename the file or fix the CSV.`, uniqueRows(o.all), columnOf(csv, o.all))
    } else {
      if (o.img.length) c.error('IMG_MISSING', `Image "${u.ref}" was not found in the job folder${u.bare === false ? '' : ' or its subfolders'}. Upload it or correct the name.`, uniqueRows(o.img), columnOf(csv, o.img))
      if (o.txt.length) c.error('IMG_TEXT_MISSING', `"${u.ref}" looks like an image file name but sits in a text column and no such image exists. It would be typeset as text. Fix the name or the column.`, uniqueRows(o.txt), columnOf(csv, o.txt))
    }
  }
  for (const a of plan.ambiguous) {
    const o = split(a.ref)
    c.error('IMG_AMBIGUOUS', `Image "${a.ref}" matches several files (${a.paths.slice(0, 3).join(', ')}${a.paths.length > 3 ? ', ...' : ''}). Use a path such as "folder/${a.ref}" to pick one.`, uniqueRows(o.all), columnOf(csv, o.all))
  }
  for (const i of plan.invalid) {
    const o = split(i.ref)
    c.error('IMG_INVALID', `Image "${i.ref}" ${i.why}.`, uniqueRows(o.all), columnOf(csv, o.all))
  }

  let unchecked = 0
  for (const r of plan.resolved) {
    const o = split(r.ref)
    if (o.txt.length) c.warn('IMG_IN_TEXT', `"${r.ref}" is an existing image but sits in a text column, so its file name would be typeset as text.`, uniqueRows(o.txt), columnOf(csv, o.txt))
    if (!probes) continue
    const p = probes.get(r.damPath)
    if (!p) { unchecked++; continue }
    if (p.size === 0) c.error('IMG_EMPTY', `Image "${r.ref}" is 0 bytes (an incomplete upload); it cannot be placed.`, uniqueRows(o.all), columnOf(csv, o.all))
    else if (p.size > 0 && !p.dims) c.warn('IMG_UNREADABLE', `Image "${r.ref}" has no readable header (not a valid ${/\.png$/i.test(r.ref) ? 'PNG' : 'JPEG'}?). It may fail to place or be fitted instead of cover-filled.`, uniqueRows(o.all), columnOf(csv, o.all))
  }
  if (unchecked) c.warn('IMG_UNCHECKED', `${plural(unchecked, 'image')} could not be opened to check size and format (limit reached); they are assumed fine.`)

  // Non-image text in an image column is skipped by the render.
  csv.header.forEach((h, col) => {
    if (!h || kinds[col] !== 'image') return
    const bad = csv.rows.filter((r) => cellOf(r, col) && !parseRef(cellOf(r, col)))
    if (bad.length) c.warn('IMG_NOT_IMAGE', `Column "${h}" holds images, but ${rowsText(bad.map((r) => r.row))} ${bad.length === 1 ? 'is' : 'are'} not a .jpg, .jpeg or .png file name ("${cellOf(bad[0], col)}"); the value would be ignored.`, bad.map((r) => r.row), h)
  })
}

// Empty cells, per column (a missing value leaves the template's placeholder in the output).
function checkEmptyCells (csv, c) {
  csv.header.forEach((h, col) => {
    if (!h || h === OUTPUT_COLUMN) return
    const empty = csv.rows.filter((r) => col < r.cells.length && !cellOf(r, col)).map((r) => r.row)
    if (empty.length) c.warn('CELL_EMPTY', `Column "${h}" is empty in ${rowsText(empty)}; the template's own content would be left in place.`, empty, h)
  })
}

// ---- page map -----------------------------------------------------------------------------

function checkPagemap (pagemapText, c, templateFacts) {
  const records = csvRecords(String(pagemapText || ''))
  if (records.length < 2) { c.error('PAGEMAP_EMPTY', 'The page map is empty. It needs a "pagenumber,pagename" header and one line per page to render.'); return 0 }
  const header = splitRecord(records[0]).map((h) => h.trim())
  if (!header.includes('pagename')) {
    c.error('PAGEMAP_BAD', `The page map needs "pagenumber" and "pagename" columns (found: ${header.filter(Boolean).join(', ') || 'none'}). Names are case-sensitive.`)
    return 0
  }
  const rows = records.slice(1).map((rec, i) => ({ row: i + 2, cells: splitRecord(rec) }))
  const nameCol = header.indexOf('pagename')
  const blank = rows.filter((r) => !cellOf(r, nameCol)).map((r) => r.row)
  if (blank.length) c.warn('PAGEMAP_BLANK_NAME', `The page map has no pagename in ${rowsText(blank)}; those lines are skipped.`, blank)
  const byName = new Map()
  for (const r of rows) {
    const v = cellOf(r, nameCol)
    if (!v) continue
    const k = v.toLowerCase()
    if (!byName.has(k)) byName.set(k, { v, rows: [] })
    byName.get(k).rows.push(r.row)
  }
  for (const { v, rows: rs } of byName.values()) {
    if (rs.length > 1) c.error('PAGEMAP_DUP', `Page "${v}" is listed ${rs.length} times in the page map (${rowsText(rs)}); its output files would overwrite each other.`, rs)
  }
  const pages = [...byName.values()].reduce((n, e) => n + e.rows.length, 0)
  const expected = templateFacts && templateFacts.pageCount
  if (Number.isInteger(expected) && pages !== expected) {
    c.error('PAGEMAP_COUNT', `The page map lists ${plural(pages, 'page')} but the template has ${expected}. Output file names would silently change; make the page map match the template.`)
  }
  return pages
}

// ---- entry points -------------------------------------------------------------------------

function result (c, stats) {
  const findings = [...c.findings.filter((f) => f.severity === 'error'), ...c.findings.filter((f) => f.severity === 'warn')]
  const errors = findings.filter((f) => f.severity === 'error')
  return { ok: errors.length === 0, errors, warnings: findings.filter((f) => f.severity === 'warn'), findings, stats }
}

// Stage 1: everything that can be decided from the job folder alone.
//   csvText, pagemapText  the two CSV files
//   plan                  images.resolveImageRefs() output (INDD: refs the template's links cover removed)
//   known                 job-folder-relative file paths seen while listing (optional; finds wrong-case names)
//   probes                Map(damPath -> { size, dims }) for opened images (optional)
//   templateFacts         { pageCount?, imageColumns? } when the caller knows them (optional)
function runPreflight ({ csvText, pagemapText, plan, known, probes, templateFacts, limits }) {
  const lim = { ...DEFAULT_LIMITS, ...(limits || {}) }
  const c = collector()
  const csv = parseCsv(csvText)
  checkStructure(csv, c)
  checkOutputNames(csv, c)
  if (csv.header.length && csv.rows.length) {
    const kinds = columnKinds(csv, templateFacts)
    checkImages(csv, c, { plan: plan || { resolved: [], unresolved: [], ambiguous: [], invalid: [] }, known, probes }, kinds)
    checkEmptyCells(csv, c)
  }
  const pages = checkPagemap(pagemapText, c, templateFacts)
  const outputs = csv.rows.length * pages
  if (outputs > lim.volumeWarn) c.warn('VOLUME_HIGH', `This job would render ${outputs} files (${plural(csv.rows.length, 'row')} x ${plural(pages, 'page')}). That is a long run; check this is the intended CSV.`)
  return result(c, { rows: csv.rows.length, pages, outputs, images: plan ? plan.resolved.length : 0 })
}

// Required files are missing: nothing else can be checked.
function missingInputs (message) {
  const c = collector()
  c.error('INPUT_MISSING', message)
  return result(c, { rows: 0, pages: 0, outputs: 0, images: 0 })
}

// One-line message for an `error` field: the first few errors, then a count.
const MAX_STORED_FINDINGS = 40
function summarize (findings) {
  const errors = findings.filter((f) => f.severity === 'error')
  if (!errors.length) return 'Preflight found no errors.'
  const head = errors.slice(0, 3).map((f) => f.message).join(' ')
  return `Preflight found ${plural(errors.length, 'problem')}: ${head}${errors.length > 3 ? ` (and ${errors.length - 3} more)` : ''}`
}

// ---- INDD template gate (runs inside the registered InDesign capability script) -------------
// The script fails with errorString "PREFLIGHT:[<findings json>]"; on success it echoes warnings
// under result.json -> preflight.findings. Both come from outside this process, so they are
// parsed defensively and rebuilt field by field rather than stored as received.

// Pull the JSON array that follows "PREFLIGHT:" out of a string (bracket-matched, string-aware,
// so trailing text such as a stack or a wrapping message doesn't break it). Returns an array or null.
function parsePreflightPayload (text) {
  const s = String(text == null ? '' : text)
  const at = s.indexOf('PREFLIGHT:')
  if (at < 0) return null
  const start = s.indexOf('[', at)
  if (start < 0) return null
  let depth = 0
  let inStr = false
  for (let i = start; i < s.length; i++) {
    const ch = s[i]
    if (inStr) {
      if (ch === '\\') i++
      else if (ch === '"') inStr = false
    } else if (ch === '"') inStr = true
    else if (ch === '[') depth++
    else if (ch === ']' && --depth === 0) {
      try { const v = JSON.parse(s.slice(start, i + 1)); return Array.isArray(v) ? v : null } catch (e) { return null }
    }
  }
  return null
}

const IND_CODE_RE = /^INDD_[A-Z_]+$/
const MESSAGE_MAX = 400
const asRows = (v) => (Array.isArray(v) ? v : []).map(Number).filter((n) => Number.isInteger(n) && n > 0)

// Keep only well-formed INDD_* findings, with bounded text and the same row/column shape as
// every other finding. Errors first, capped at MAX_STORED_FINDINGS.
function sanitizeIndFindings (raw) {
  if (!Array.isArray(raw)) return []
  const out = []
  for (const f of raw) {
    if (!f || typeof f !== 'object' || !IND_CODE_RE.test(String(f.code))) continue
    const rows = asRows(f.rows)
    const total = Number(f.rowsTotal)
    const w = where(rows, typeof f.column === 'string' ? f.column.slice(0, 120) : '')
    if (w.rows && Number.isInteger(total) && total >= rows.length) w.rowsTotal = total
    out.push({ severity: f.severity === 'error' ? 'error' : 'warn', code: String(f.code), message: String(f.message == null ? '' : f.message).slice(0, MESSAGE_MAX), ...w })
  }
  out.sort((a, b) => (a.severity === b.severity ? 0 : a.severity === 'error' ? -1 : 1))
  return out.slice(0, MAX_STORED_FINDINGS)
}

// ---- stage 2: Photoshop template ----------------------------------------------------------

const quote = (s) => `"${s}"`
const list = (items, max = 10) => items.slice(0, max).map(quote).join(', ') + (items.length > max ? `, and ${items.length - max} more` : '')
// "Poppins-SemiBold.ttf" and the PostScript name "Poppins-SemiBold" compare equal.
const fontKey = (s) => String(s || '').replace(/\.[A-Za-z0-9]+$/, '').toLowerCase().replace(/[^a-z0-9]/g, '')

// Fonts the text layers use, read from the raw manifest: [{ name, available, layers }].
// `name` is the PostScript name; `available` is false only when Photoshop said so (else true / null).
// The V2 shape is text.characterStyles[].font.{postScriptName,isAvailable}; the V1 flat fields
// (fontName, fontAvailable) are accepted too. An unknown shape yields no fonts, never an error.
function fontsFromManifest (manifest) {
  const fonts = new Map()
  const note = (name, available, layer) => {
    if (!name || typeof name !== 'string') return
    const f = fonts.get(name) || { name, available: null, layers: [] }
    if (available === false) f.available = false
    else if (available === true && f.available === null) f.available = true
    if (layer && !f.layers.includes(layer)) f.layers.push(layer)
    fonts.set(name, f)
  }
  const visit = (layers, depth) => {
    if (!Array.isArray(layers) || depth > 20) return
    for (const l of layers) {
      if (!l || typeof l !== 'object') continue
      const styles = l.text && Array.isArray(l.text.characterStyles) ? l.text.characterStyles : []
      for (const s of styles) {
        if (!s || typeof s !== 'object') continue
        const f = s.font && typeof s.font === 'object' ? s.font : s
        note(f.postScriptName || f.fontName || (typeof s.font === 'string' ? s.font : ''), f.isAvailable !== undefined ? f.isAvailable : f.fontAvailable, l.name)
      }
      visit(l.layers, depth + 1)
      visit(l.children, depth + 1)
    }
  }
  if (manifest && typeof manifest === 'object') {
    visit(manifest.layers, 0)
    visit(manifest.artboards, 0)
  }
  return [...fonts.values()]
}

// Stage 2 for a PSD template: needs the manifest, so it runs on the first batch of a job.
//   manifest     the parsed generate-manifest output
//   stagedFonts  font file names that will be sent with the render
function runPsdChecks ({ csvText, pagemapText, manifest, stagedFonts }) {
  const c = collector()
  const csv = parseCsv(csvText)
  const all = artboardsFromManifest(manifest)
  const names = pagemapNames(csvRecords(String(pagemapText || '')))
  let selected = []

  if (!all.length) {
    c.error('PSD_NO_ARTBOARDS', 'The Photoshop template has no artboards, so there is nothing to render. Each page in the page map must be an artboard.')
  } else {
    const sel = selectArtboards(all, names)
    selected = sel.selected
    if (sel.missing.length) {
      c.error('PSD_PAGEMAP_MISSING', `The page map lists ${plural(sel.missing.length, 'artboard')} that ${sel.missing.length === 1 ? 'is' : 'are'} not in the Photoshop template: ${list(sel.missing)}. The template has: ${list(all.map((a) => a.name))}. Names are case-sensitive.`)
    } else if (!selected.length) {
      c.error('PSD_NO_SELECTION', 'The page map names no artboard, so nothing would be rendered.')
    }
  }

  if (selected.length && csv.header.length) {
    const columns = [...new Set(csv.header.filter((h) => h && h !== OUTPUT_COLUMN))]
    const layerNames = new Set()
    const kinds = new Map() // layer name -> Set(layer types) across the selected artboards
    for (const a of selected) {
      for (const [name, l] of a.layers) {
        layerNames.add(name)
        if (!kinds.has(name)) kinds.set(name, new Set())
        kinds.get(name).add(l.type)
      }
    }
    const byLower = new Map([...layerNames].map((n) => [n.toLowerCase(), n]))

    for (const h of mapColumns(columns, selected).unmatched) {
      const near = byLower.get(h.toLowerCase())
      c.error('PSD_COLUMN_UNMATCHED', `Column "${h}" matches no text or image layer on the selected artboards, so it would have no effect.${near && near !== h ? ` Did you mean "${near}"? Layer names are case-sensitive.` : ' Rename it to a layer name, or delete the column.'}`, null, h)
    }

    for (const h of columns) {
      const types = kinds.get(h)
      if (!types || types.size !== 1) continue // unmatched, or a name used for both kinds of layer
      const col = csv.header.lastIndexOf(h)
      const values = csv.rows.map((r) => ({ row: r.row, v: cellOf(r, col) })).filter((x) => x.v)
      if (types.has('text_layer')) {
        const bad = values.filter((x) => isImageCell(x.v))
        if (bad.length) c.error('PSD_IMAGE_IN_TEXT_LAYER', `Column "${h}" fills a text layer, but ${rowsText(bad.map((x) => x.row))} ${bad.length === 1 ? 'holds' : 'hold'} an image file name ("${bad[0].v}"); it would be typeset as text. Use the image layer's column instead.`, bad.map((x) => x.row), h)
      } else if (types.has('smart_object_layer')) {
        const bad = values.filter((x) => !isImageCell(x.v))
        if (bad.length) c.warn('PSD_TEXT_IN_IMAGE_LAYER', `Column "${h}" fills an image layer, but ${rowsText(bad.map((x) => x.row))} ${bad.length === 1 ? 'is' : 'are'} not a .jpg, .jpeg or .png file name ("${bad[0].v}"); the layer would keep its placeholder.`, bad.map((x) => x.row), h)
      }
    }
  }

  const have = new Set((stagedFonts || []).map(fontKey))
  const lost = fontsFromManifest(manifest).filter((f) => f.available === false && !have.has(fontKey(f.name)))
  if (lost.length) {
    const used = lost.map((f) => `"${f.name}"${f.layers.length ? ` (${f.layers.slice(0, 3).join(', ')})` : ''}`).join(', ')
    c.warn('PSD_FONT_MISSING', `The template uses ${plural(lost.length, 'font')} that Photoshop reports as unavailable, with no matching font file staged: ${used}. Text would fail to render. Add a font file for ${lost.length === 1 ? 'it' : 'each'} to the job's fonts folder.`)
  }

  return result(c, { rows: csv.rows.length, pages: selected.length, outputs: csv.rows.length * selected.length, images: 0 })
}

module.exports = { parsePreflightPayload, sanitizeIndFindings, runPreflight, runPsdChecks, summarize, MAX_STORED_FINDINGS, fontsFromManifest, missingInputs, parseCsv, result, collector, where, columnKinds, OUTPUT_COLUMN, DEFAULT_LIMITS, plural, rowsText }
