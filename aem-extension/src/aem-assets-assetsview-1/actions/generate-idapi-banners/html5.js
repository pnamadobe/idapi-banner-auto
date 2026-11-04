'use strict'
// HTML5 banners: turn the capability's per-page manifest into a Document Authoring page that the
// banner-ads `ad` block renders, plus the variations sheet it reads. Pure functions, no I/O.
//
// Block markup (one row per layer, back to front):
//   size | 300x250 | duration 6 | loops 2 | rows /ads/<template>/<campaign>/variations.json
//   name | image|text | source | x,y,w,h | motion | style
const { csvRecords } = require('./csv')
const { rowsFromRecords, splitRecord } = require('./psd')

const PRESETS = ['none', 'fade', 'fadeUp', 'fadeDown', 'slideLeft', 'slideRight', 'wipe', 'zoomIn', 'kenburns', 'pulse']
const CANONICAL = Object.fromEntries(PRESETS.map((p) => [p.toLowerCase(), p]))
const MAX_TOTAL = 30
const MAX_LOOPS = 3
const DEFAULTS = { duration: 6, loops: 1, budgetKB: 150 }
// The click-through column. Names are compared ignoring case, spaces and punctuation (- _ . etc.), so
// `cta-url`, `CTA URL`, `cta_url` and `ctaUrl` are all `ctaurl`. Accepted: a STANDALONE name on its own
// or followed by a SUFFIX, or a PREFIX followed by a SUFFIX (`cta` alone is the button text, not a URL).
// The ad block reads `clickthrough`, so the DA sheet always uses that name.
// Documented in examples/README.md (Step 2) and docs/HTML5-DESIGN.md §3.4: keep all three in step.
const CLICKTHROUGH_STANDALONE = ['clickthrough', 'clickthru', 'clicktag', 'landingpage']
const CLICKTHROUGH_PREFIX = ['click', 'cta', 'landing', 'destination', 'exit']
const CLICKTHROUGH_SUFFIX = ['url', 'link', 'href']
const CLICKTHROUGH_COLUMNS = new Set([
  ...CLICKTHROUGH_STANDALONE,
  ...[...CLICKTHROUGH_STANDALONE, ...CLICKTHROUGH_PREFIX].flatMap((base) => CLICKTHROUGH_SUFFIX.map((s) => base + s))
])
const squash = (k) => String(k).toLowerCase().replace(/[^a-z0-9]/g, '')
const isClickthroughColumn = (k) => CLICKTHROUGH_COLUMNS.has(squash(k))
const columnKey = (k) => (isClickthroughColumn(k) ? 'clickthrough' : k)

const yes = (v) => /^(y|yes|true|1|x)$/i.test(String(v || '').trim())
const num = (v, d) => {
  const t = String(v == null ? '' : v).trim()
  return t !== '' && Number.isFinite(Number(t)) ? Number(t) : d
}

// `preset[@delay][/duration]` -> canonical string, or null when unknown.
function normalizeMotion (str) {
  const m = /^\s*([a-z]+)\s*(?:@\s*(\d*\.?\d+)\s*s?)?\s*(?:\/\s*(\d*\.?\d+)\s*s?)?\s*$/i.exec(String(str || ''))
  if (!m || !CANONICAL[m[1].toLowerCase()]) return null
  return CANONICAL[m[1].toLowerCase()] + (m[2] !== undefined ? `@${Number(m[2])}` : '') + (m[3] !== undefined ? `/${Number(m[3])}` : '')
}

// "hero:kenburns; headline:fadeUp@0.4" -> { map: { hero: 'kenburns', ... }, unknown: ['x:explode'] }
function parseMotionMap (str) {
  const map = {}
  const unknown = []
  for (const part of String(str || '').split(/[;\n]/)) {
    const p = part.trim()
    if (!p) continue
    const i = p.indexOf(':')
    const label = i > 0 ? p.slice(0, i).trim() : ''
    const motion = i > 0 ? normalizeMotion(p.slice(i + 1)) : null
    if (!label || !motion) unknown.push(p)
    else map[label.toLowerCase()] = motion
  }
  return { map, unknown }
}

// A pagemap without an `html5` column opts every page in (the HTML5 button was pressed on purpose);
// with the column, only rows marked yes are HTML5.
const hasHtml5Column = (records) => records.length > 0 && rowsFromRecords([records[0], '']).some((r) => Object.prototype.hasOwnProperty.call(r, 'html5'))

// The pagemap the InDesign script reads: adds html5=yes to every page when the column is missing.
function pagemapAllHtml5 (text) {
  const records = csvRecords(String(text || ''))
  if (!records.length || hasHtml5Column(records)) return String(text || '')
  return [`${records[0]},html5`, ...records.slice(1).map((r) => (String(r).trim() ? `${r},yes` : r))].join('\n')
}

// Pagemap CSV -> [{ pagenumber, pagename, html5, motion, unknownMotion, duration, loops, budgetKB, tooLong }]
function pagemapHtml5 (text) {
  const records = csvRecords(String(text || ''))
  const all = !hasHtml5Column(records)
  return rowsFromRecords(records)
    .map((r) => {
      const { map, unknown } = parseMotionMap(r.motion)
      const duration = num(r.duration, DEFAULTS.duration)
      const loops = Math.round(num(r.loops, DEFAULTS.loops))
      return {
        pagenumber: Number(r.pagenumber),
        pagename: String(r.pagename || '').trim(),
        html5: all || yes(r.html5),
        motion: map,
        unknownMotion: unknown,
        duration,
        loops,
        budgetKB: num(r.budgetKB || r.budgetkb, DEFAULTS.budgetKB),
        tooLong: duration <= 0 || loops < 1 || loops > MAX_LOOPS || duration * loops > MAX_TOTAL
      }
    })
    .filter((p) => p.pagename)
    .sort((a, b) => a.pagenumber - b.pagenumber)
}

const r1 = (n) => Math.round(Number(n) * 10) / 10
const hex = (c) => (/^#?[0-9a-f]{3}([0-9a-f]{3})?$/i.test(String(c || '')) ? `#${String(c).replace(/^#/, '').toLowerCase()}` : null)
const family = (f) => String(f || '').replace(/["\\{};<>]/g, '').trim()

// Capability style -> block style tokens. Text: font, weight, size/lead, colour, align, case,
// tracking, background, radius, valign. Image: focal point and fit.
function styleTokens (el) {
  const s = el.style || {}
  const t = []
  if (el.kind === 'image') {
    const c = el.crop || {}
    if (Number.isFinite(c.fx) && Number.isFinite(c.fy)) t.push(`focus:${Math.round(c.fx)},${Math.round(c.fy)}`)
    if (['cover', 'contain', 'fill'].includes(s.fit)) t.push(`fit:${s.fit}`)
    return t.join(' ')
  }
  if (family(s.font)) t.push(`"${family(s.font)}"`)
  if (s.weight && /^[a-z ]+$/i.test(s.weight) && !/^(regular|roman|normal|book)$/i.test(s.weight)) t.push(String(s.weight).replace(/\s+/g, ''))
  if (s.italic) t.push('italic')
  if (Number(s.size) > 0) t.push(Number(s.lead) > 0 ? `${r1(s.size)}/${r1(s.lead)}` : `${r1(s.size)}`)
  if (hex(s.color)) t.push(hex(s.color))
  if (['center', 'right'].includes(s.align)) t.push(s.align)
  if (s.caps) t.push('caps')
  if (Number(s.track)) t.push(`track:${Math.round(s.track)}`)
  if (hex(s.bg)) t.push(`bg:${hex(s.bg)}`)
  if (Number(s.radius) > 0) t.push(`radius:${r1(s.radius)}`)
  if (['middle', 'bottom'].includes(s.valign)) t.push(`valign:${s.valign}`)
  if (s.button) t.push('button')
  return t.join(' ')
}

const boxStr = (b) => [b.x, b.y, b.w, b.h].map((n) => Math.round(Number(n) || 0)).join(',')

// Page manifest -> block layers back to front. Slices carry an image URL (sliceUrl(slice));
// elements bind to the sheet column named by their label. Motion: authored cell on the existing
// DA page wins, then the pagemap motion map, else empty (the block picks a default).
function layersFromManifest (page, { sliceUrl, pagemapMotion = {}, authored = {} } = {}) {
  const items = [
    ...(page.slices || []).map((s, i) => ({ ...s, kind: 'image', slice: true, z: s.z == null ? i : s.z })),
    ...(page.elements || []).map((e, i) => ({ ...e, name: e.label, z: e.z == null ? 1000 + i : e.z }))
  ].sort((a, b) => a.z - b.z)
  return items.map((it) => {
    const name = String(it.name || it.label)
    const key = name.toLowerCase()
    const motion = key in authored ? authored[key] : (pagemapMotion[key] || '')
    if (it.slice) {
      return { name, kind: 'image', source: sliceUrl ? sliceUrl(it) : it.file, image: true, box: boxStr(it.box || { x: 0, y: 0, w: page.width, h: page.height }), motion, style: '' }
    }
    return { name, kind: it.kind === 'image' ? 'image' : 'text', source: `{${name}}`, box: boxStr(it.box), motion, style: styleTokens(it) }
  })
}

const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
const safeHttp = (u) => (/^https:\/\/[^\s"'<>]+$/i.test(String(u || '')) ? String(u) : '')

// DA source HTML for one size.
function daPageHtml ({ width, height, duration = DEFAULTS.duration, loops = DEFAULTS.loops, rowsPath, layers }) {
  const cell = (inner) => `<div>${inner}</div>`
  const rows = [
    cell([cell('size'), cell(`${Math.round(width)}x${Math.round(height)}`), cell(`duration ${Number(duration)}`), cell(`loops ${Number(loops)}`), cell(`rows ${esc(rowsPath)}`)].join(''))
  ]
  for (const l of layers) {
    const src = l.image && safeHttp(l.source) ? `<img src="${esc(l.source)}" alt="">` : esc(l.source)
    rows.push(cell([cell(esc(l.name)), cell(l.kind), cell(src), cell(l.box), cell(esc(l.motion)), cell(esc(l.style))].join('')))
  }
  return `<body><header></header><main><div><div class="ad">${rows.join('')}</div></div></main><footer></footer></body>`
}

// Existing DA page HTML -> { label: motion } for the layers an author already has, so a re-run
// keeps the motion they typed. Reads the 5th cell of each layer row.
function readDaPage (html) {
  const out = {}
  const block = /<div class="ad">([\s\S]*)<\/div>\s*<\/div>\s*<\/main>/i.exec(String(html || ''))
  if (!block) return out
  const text = (s) => s.replace(/<[^>]*>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&').trim()
  // each row is <div> followed by its cells <div>..</div>; split rows on the cell pattern
  const rowRe = /<div>((?:\s*<div>[\s\S]*?<\/div>)+)\s*<\/div>/g
  let m
  while ((m = rowRe.exec(block[1]))) {
    const cells = [...m[1].matchAll(/<div>([\s\S]*?)<\/div>/g)].map((c) => text(c[1]))
    const name = (cells[0] || '').toLowerCase()
    if (!name || name === 'size' || cells.length < 5) continue
    out[name] = normalizeMotion(cells[4].split('·')[0]) || ''
  }
  return out
}

// The variations CSV without its click-through column(s), for the InDesign/Photoshop render: a link
// fills no frame or layer, and the render's preflight rejects a column that names none. Returns
// { text, dropped }; text is the input unchanged when no column is a click-through one.
function dropClickthroughColumns (csvText) {
  const text = String(csvText || '')
  const records = csvRecords(text)
  if (!records.length) return { text, dropped: [] }
  const header = splitRecord(records[0])
  const drop = new Set(header.map((h, i) => (isClickthroughColumn(h.trim()) ? i : -1)).filter((i) => i >= 0))
  if (!drop.size) return { text, dropped: [] }
  const quote = (v) => (/[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v)
  const eol = /\r\n/.test(text) ? '\r\n' : '\n'
  // A row left with no cells keeps one empty cell, so the render still counts it.
  const out = records.map((rec) => splitRecord(rec).filter((_, i) => !drop.has(i)).map(quote).join(',') || '""')
  return { text: out.join(eol) + (/\r?\n$/.test(text) ? eol : ''), dropped: [...drop].map((i) => header[i].trim()) }
}

// Variations CSV -> DA sheet JSON. Image cells resolve through resolveImage(value, column)
// (returns a delivery URL or the value unchanged).
function variationsSheet (csvText, resolveImage = (v) => v) {
  const data = rowsFromRecords(csvRecords(String(csvText || ''))).map((row) => {
    const out = {}
    for (const [k, v] of Object.entries(row)) {
      const key = columnKey(k)
      if (key !== 'clickthrough') out[key] = resolveImage(v, k)
      else if (!out.clickthrough) out.clickthrough = String(v).trim()
    }
    return out
  })
  return { ':type': 'sheet', total: data.length, limit: data.length, offset: 0, data }
}

// True when the sheet in DA differs from what the last run wrote (an author edited it).
function sheetEdited (current, lastWritten) {
  if (!current || !lastWritten) return false
  const rows = (s) => JSON.stringify((s.data || (s[':names'] && s[s[':names'][0]] && s[s[':names'][0]].data) || []))
  return rows(current) !== rows(lastWritten)
}

const slug = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
const SEG = /^[a-z0-9][a-z0-9-]{0,62}$/i

// The EDS / Document Authoring site an HTML5 run publishes to comes only from html5.json in the
// campaign folder or the nearest folder above it. Each team publishes to its own site, so the deployment has no default site and
// action params are not read. Values are validated so a bad one can't steer requests elsewhere.
// Every problem throws HTML5_NO_SITE with a message the modal shows as is.
const SITE_EXAMPLE = '{"DA_ORG": "<your DA org>", "DA_SITE": "<your EDS site>"}'
const NO_SITE = `HTML5 banners publish to your own EDS site: add html5.json to the campaign folder (or a folder above it) with ${SITE_EXAMPLE}`
function noSite (message) {
  const e = new Error(message)
  e.code = 'HTML5_NO_SITE'
  return e
}
const shown = (v) => JSON.stringify(String(v).slice(0, 64))
function daConfig (site = {}) {
  const pick = (k, d) => String(site[k] || d || '').trim()
  if (!pick('DA_ORG') || !pick('DA_SITE')) throw noSite(NO_SITE)
  const cfg = {
    org: pick('DA_ORG'),
    site: pick('DA_SITE'),
    root: '/' + pick('DA_ADS_ROOT', '/ads').replace(/^\/+|\/+$/g, ''),
    ref: pick('EDS_REF', 'main')
  }
  for (const [k, name] of [['org', 'DA_ORG'], ['site', 'DA_SITE'], ['ref', 'EDS_REF']]) {
    if (!SEG.test(cfg[k])) throw noSite(`html5.json: ${name} ${shown(cfg[k])} is not a valid name`)
  }
  if (!/^(\/[a-z0-9][a-z0-9-]*)+$/i.test(cfg.root)) throw noSite(`html5.json: DA_ADS_ROOT ${shown(cfg.root)} is not a valid path`)
  cfg.org = cfg.org.toLowerCase()
  cfg.site = cfg.site.toLowerCase()
  cfg.root = cfg.root.toLowerCase()
  cfg.previewOrigin = `https://${cfg.ref}--${cfg.site}--${cfg.org}.aem.page`
  // The GitHub repo whose workflow packages the ads for CM360: the site's own repo unless named.
  cfg.repo = pick('GITHUB_REPO', `${cfg.org}/${cfg.site}`)
  if (!/^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/.test(cfg.repo)) throw noSite(`html5.json: GITHUB_REPO ${shown(cfg.repo)} is not owner/repo`)
  return cfg
}

// The campaign folder's html5.json: `text` is its contents, or null when there is none; `foundAt` is
// the folder it was found in when that is a folder above the campaign (for messages).
function siteConfig (text, foundAt) {
  if (text == null || !String(text).trim()) throw noSite(NO_SITE)
  const where = foundAt ? `html5.json in ${foundAt}` : 'html5.json in the campaign folder'
  let site
  try { site = JSON.parse(String(text)) } catch (e) { throw noSite(`${where} is not valid JSON. Expected ${SITE_EXAMPLE}`) }
  if (!site || typeof site !== 'object' || Array.isArray(site)) throw noSite(`${where} must be a JSON object: ${SITE_EXAMPLE}`)
  return daConfig(site)
}

// Paths for a campaign: { pagePath(pagename), sheetPath, rowsPath, previewUrl(pagename, row) }.
// With a template, its file name (no extension) is a folder above the campaign: /ads/<template>/<campaign>/...
function campaignPaths (cfg, campaign, template) {
  const tpl = slug(String(template || '').replace(/\.[^.]+$/, ''))
  const base = `${cfg.root}${tpl ? `/${tpl}` : ''}/${slug(campaign) || 'campaign'}`
  return {
    base,
    pagePath: (pagename) => `${base}/${slug(pagename)}`,
    sheetPath: `${base}/variations`,
    rowsPath: `${base}/variations.json`,
    previewUrl: (pagename, row) => `${cfg.previewOrigin}${base}/${slug(pagename)}${row ? `?v=${encodeURIComponent(row)}` : ''}`
  }
}

module.exports = {
  PRESETS,
  normalizeMotion,
  parseMotionMap,
  pagemapHtml5,
  pagemapAllHtml5,
  styleTokens,
  layersFromManifest,
  daPageHtml,
  readDaPage,
  variationsSheet,
  isClickthroughColumn,
  dropClickthroughColumns,
  sheetEdited,
  daConfig,
  siteConfig,
  campaignPaths,
  slug
}
