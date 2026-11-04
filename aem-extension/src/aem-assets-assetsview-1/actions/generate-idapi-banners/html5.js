'use strict'
// HTML5 banners: turn the capability's per-page manifest into a Document Authoring page that the
// banner-ads `ad` block renders, plus the variations sheet it reads. Pure functions, no I/O.
//
// Block markup (one row per layer, back to front):
//   size | 300x250 | duration 6 | loops 2 | rows /ads/<campaign>/variations.json
//   name | image|text | source | x,y,w,h | motion | style
const { csvRecords } = require('./csv')
const { rowsFromRecords } = require('./psd')

const PRESETS = ['none', 'fade', 'fadeUp', 'fadeDown', 'slideLeft', 'slideRight', 'wipe', 'zoomIn', 'kenburns', 'pulse']
const CANONICAL = Object.fromEntries(PRESETS.map((p) => [p.toLowerCase(), p]))
const MAX_TOTAL = 30
const MAX_LOOPS = 3
const DEFAULTS = { duration: 6, loops: 1, budgetKB: 150 }
const RESERVED = ['clickthrough']

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

// Pagemap CSV -> [{ pagenumber, pagename, html5, motion, unknownMotion, duration, loops, budgetKB, tooLong }]
function pagemapHtml5 (text) {
  return rowsFromRecords(csvRecords(String(text || '')))
    .map((r) => {
      const { map, unknown } = parseMotionMap(r.motion)
      const duration = num(r.duration, DEFAULTS.duration)
      const loops = Math.round(num(r.loops, DEFAULTS.loops))
      return {
        pagenumber: Number(r.pagenumber),
        pagename: String(r.pagename || '').trim(),
        html5: yes(r.html5),
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

// Variations CSV -> DA sheet JSON. Image cells resolve through resolveImage(value, column)
// (returns a delivery URL or the value unchanged).
function variationsSheet (csvText, resolveImage = (v) => v) {
  const data = rowsFromRecords(csvRecords(String(csvText || ''))).map((row) => {
    const out = {}
    for (const [k, v] of Object.entries(row)) out[k] = RESERVED.includes(k.toLowerCase()) ? String(v).trim() : resolveImage(v, k)
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

// Settings: job-folder html5.json override, then action params. Validated so a bad value can't
// steer requests elsewhere.
function daConfig (params = {}, override = {}) {
  const pick = (k, d) => String(override[k] || params[k] || d || '').trim()
  const cfg = {
    org: pick('DA_ORG', 'pnamadobe'),
    site: pick('DA_SITE', 'banner-ads'),
    root: '/' + pick('DA_ADS_ROOT', '/ads').replace(/^\/+|\/+$/g, ''),
    ref: pick('EDS_REF', 'main')
  }
  for (const k of ['org', 'site', 'ref']) if (!SEG.test(cfg[k])) throw new Error(`invalid ${k}: ${cfg[k]}`)
  if (!/^(\/[a-z0-9][a-z0-9-]*)+$/i.test(cfg.root)) throw new Error(`invalid DA_ADS_ROOT: ${cfg.root}`)
  cfg.org = cfg.org.toLowerCase()
  cfg.site = cfg.site.toLowerCase()
  cfg.root = cfg.root.toLowerCase()
  cfg.previewOrigin = `https://${cfg.ref}--${cfg.site}--${cfg.org}.aem.page`
  return cfg
}

// Paths for a campaign: { pagePath(pagename), sheetPath, rowsPath, previewUrl(pagename, row) }
function campaignPaths (cfg, campaign) {
  const base = `${cfg.root}/${slug(campaign) || 'campaign'}`
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
  styleTokens,
  layersFromManifest,
  daPageHtml,
  readDaPage,
  variationsSheet,
  sheetEdited,
  daConfig,
  campaignPaths,
  slug
}
