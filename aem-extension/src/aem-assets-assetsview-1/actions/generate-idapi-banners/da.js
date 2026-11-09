/*
 * HTML5 banners: write the rendered design into Document Authoring (DA) and preview it on
 * Edge Delivery Services. One DA page per size (an `ad` block) plus one variations sheet per
 * campaign. Static slices are written into DA beside each page; images from the variations CSV are
 * existing AEM assets, referenced by their Dynamic Media delivery URLs.
 *
 * Nothing here fails the job: the JPG backups are already written when this runs, so every
 * problem comes back as a warning ({ code, message }).
 */

const crypto = require('crypto')
const h = require('./html5')

const DA_ADMIN = 'https://admin.da.live'
const EDS_ADMIN = 'https://admin.hlx.page'
const IMAGE_CELL = /\.(jpe?g|png|gif|webp|avif|svg|tiff?|psd)$/i

const enc = (p) => p.split('/').map(encodeURIComponent).join('/')
const sourceUrl = (cfg, path) => `${DA_ADMIN}/source/${cfg.org}/${cfg.site}${enc(path)}`
// how a DA page refers to an image stored in DA (EDS ingests it on preview)
const contentUrl = (cfg, path) => `https://content.da.live/${cfg.org}/${cfg.site}${enc(path)}`

// ---- DA source API ----
async function daGet (cfg, token, path) {
  const res = await fetch(sourceUrl(cfg, path), { headers: { Authorization: `Bearer ${token}` } })
  if (res.status === 404) return null
  if (!res.ok) throw daError('read', path, res.status)
  return res.text()
}
// multipart/form-data with a single `data` part (built by hand: no FormData global needed)
function multipart (name, filename, body, contentType) {
  const boundary = `----da${crypto.randomBytes(12).toString('hex')}`
  const safe = String(filename).replace(/["\r\n]/g, '_')
  const head = `--${boundary}\r\nContent-Disposition: form-data; name="${name}"; filename="${safe}"\r\nContent-Type: ${contentType}\r\n\r\n`
  return { boundary, buf: Buffer.concat([Buffer.from(head), Buffer.isBuffer(body) ? body : Buffer.from(String(body)), Buffer.from(`\r\n--${boundary}--\r\n`)]) }
}
async function daPut (cfg, token, path, body, contentType) {
  const { boundary, buf } = multipart('data', path.split('/').pop(), body, contentType)
  const res = await fetch(sourceUrl(cfg, path), {
    method: 'PUT',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': `multipart/form-data; boundary=${boundary}` },
    body: buf
  })
  if (!res.ok) throw daError('write', path, res.status)
}
function daError (verb, path, status) {
  const e = new Error(`DA ${verb} ${path} -> ${status}`)
  e.code = status === 401 || status === 403 ? 'HTML5_DA_NO_ACCESS' : 'HTML5_DA_ERROR'
  return e
}

// ---- EDS admin: preview a path so it is served from <ref>--<site>--<org>.aem.page ----
// token: an EDS admin API key (x-auth-token). Without one the preview is tried unauthenticated (open
// sites allow it) and, if the site requires sign-in, again with the signed-in user's IMS token (bearer),
// the same way da.live itself calls admin.hlx.page.
// EDS reads the page back from content.da.live to preview it. For a DA org with permissions set, that
// read needs the signed-in user's token in x-content-source-authorization (as DA's own Preview button
// sends it); Authorization is only for an EDS site that itself requires sign-in.
async function edsPreview (cfg, token, path, bearer) {
  const url = `${EDS_ADMIN}/preview/${cfg.org}/${cfg.site}/${cfg.ref}${enc(path)}`
  const source = bearer ? { 'x-content-source-authorization': `Bearer ${bearer}` } : {}
  let res = await fetch(url, { method: 'POST', headers: { ...(token ? { 'x-auth-token': token } : {}), ...source } })
  if (!token && bearer && (res.status === 401 || res.status === 403)) {
    res = await fetch(url, { method: 'POST', headers: { Authorization: `Bearer ${bearer}`, ...source } })
  }
  if (res.status === 404) { const e = new Error(`EDS preview ${path} -> 404 (is AEM Code Sync installed and the DA site connected?)`); e.code = 'HTML5_NO_EDS_SITE'; throw e }
  if (!res.ok) {
    const header = (name) => (res.headers && typeof res.headers.get === 'function' ? res.headers.get(name) || '' : '')
    const why = header('x-error-code') === 'AEM_BACKEND_FETCH_FAILED'
      ? ' (EDS could not read the page from DA: check that you can open it in da.live)'
      : header('x-error') ? ` (${header('x-error').replace(/https?:\/\/\S+/g, '').trim().slice(0, 200)})` : ''
    const e = new Error(`EDS preview ${path} -> ${res.status}${why}`)
    e.code = res.status === 401 || res.status === 403 ? 'HTML5_DA_NO_ACCESS' : 'HTML5_EDS_ERROR'
    throw e
  }
}

// ---- AEM: delivery URLs and approval check ----
// author-pX-eY.adobeaemcloud.com -> delivery-pX-eY.adobeaemcloud.com
function deliveryUrl (author, id, name) {
  const host = new URL(author).host.replace(/^author-/, 'delivery-')
  return `https://${host}/adobe/assets/${id}/as/${encodeURIComponent(name)}`
}
async function isApproved (author, token, damPath) {
  const res = await fetch(`${author}${enc(damPath)}/jcr:content/metadata.json`, { headers: { Authorization: `Bearer ${token}` } })
  if (!res.ok) return false
  return String((await res.json())['dam:status'] || '').toLowerCase() === 'approved'
}

// A static slice from the render's outputs: '<page>--static-N.png' (the render hands outputs back by bare
// file name, so the page is in the name), or the older 'html5/<page>/static-N.png' path. Accepts the output's
// source path or its URL (query dropped, %-decoded, either slash).
function sliceOf (...srcs) {
  for (const src of srcs) {
    let p = String(src || '').split('?')[0]
    try { p = decodeURIComponent(p) } catch (e) { /* keep raw */ }
    p = p.replace(/\\/g, '/')
    const m = /(?:^|\/)([^/]+?)--(static-\d+\.png)$/.exec(p) || /(?:^|\/)html5\/([^/]+)\/(static-\d+\.png)$/.exec(p)
    if (m) return { page: m[1], file: m[2] }
  }
  return null
}

const stateKey = (cfg, path) => `html5sheet.${crypto.createHash('sha1').update(`${cfg.org}/${cfg.site}${path}`).digest('hex')}`

function candidateBases (cfg, campaign, template) {
  const tpl = h.slug(String(template || '').replace(/\.[^.]+$/, ''))
  const camp = h.slug(campaign) || 'campaign'
  const out = []
  const add = (p) => { if (p && !out.includes(p)) out.push(p) }
  for (const s of h.ANIMATION_STYLES) add(h.campaignPaths(cfg, campaign, template, s.id).base)
  add(h.campaignPaths(cfg, campaign, template).base)
  if (tpl) {
    add(`/ads/${tpl}/${camp}`)
    for (const s of h.ANIMATION_STYLES) add(`/ads/${tpl}/${camp}/${s.id}`)
  }
  add(`/ads/${camp}`)
  return out
}

async function fetchExistingPage (cfg, daToken, base, pagename) {
  const pageSlug = h.slug(pagename)
  const previewUrl = `${cfg.previewOrigin}${base}/${pageSlug}`
  try {
    const res = await fetch(previewUrl)
    if (res && res.ok && typeof res.text === 'function') {
      const parsed = h.parseAdPage(await res.text(), previewUrl)
      if (parsed) return parsed
    }
  } catch (e) { /* fall back to DA source */ }
  if (daToken) {
    try {
      const raw = await daGet(cfg, daToken, `${base}/${pageSlug}.html`)
      if (raw) {
        const parsed = h.parseAdPage(raw, `${cfg.previewOrigin}${base}/`)
        if (parsed) return parsed
      }
    } catch (e) { /* not at this base */ }
  }
  return null
}

// Check if this template's HTML5 pages + static slices already exist on the EDS/DA site (under any
// style subfolder or legacy /ads/<template>/<campaign> folder). When all pagemap HTML5 sizes exist,
// returns { manifest, slices, fromBase } so switching or adding animation styles takes seconds and
// skips the InDesign API render completely.
async function reuseHtml5FromSite ({ cfg, daToken, campaign, template, pagemapText }) {
  const pm = h.pagemapHtml5(pagemapText).filter((p) => p.html5)
  if (!pm.length) return null
  for (const base of candidateBases(cfg, campaign, template)) {
    const first = await fetchExistingPage(cfg, daToken, base, pm[0].pagename)
    if (!first) continue
    const rest = await Promise.all(pm.slice(1).map((p) => fetchExistingPage(cfg, daToken, base, p.pagename)))
    if (rest.some((r) => !r)) continue
    const all = [first, ...rest]
    const manifest = {}
    const slices = new Map()
    pm.forEach((p, idx) => {
      const parsed = all[idx]
      manifest[p.pagename] = parsed
      for (const s of parsed.slices || []) {
        if (s.url) slices.set(`${p.pagename}/${s.name}.png`, s.url)
      }
    })
    return { manifest, slices, fromBase: base }
  }
  return null
}

/*
 * ctx: {
 *   cfg (daConfig), daToken, edsToken, edsBearer, author, aemToken, outFolder, folder, campaign,
 *   manifest (result.json "html5"), pagemapText, csvText (full variations CSV),
 *   slices: Map('<page>/static-N.png' -> rendered output URL),
 *   imageSource: Map(cell value -> DAM path) for swapped images,
 *   state (aio-lib-state, optional), logger,
 *   deps: { upload(folder, name, buf, mime), assetId(damPath), fetchBuf(url) }
 * }
 * Returns { pages: [{ page, path, previewUrl, rows }], rowsUrl, warnings }.
 */
async function publishHtml5 (ctx) {
  const { cfg, author, aemToken, deps } = ctx
  const warnings = []
  const warn = (code, message) => { warnings.push({ code, message }); if (ctx.logger) ctx.logger.warn(`${code}: ${message}`) }
  const paths = h.campaignPaths(cfg, ctx.campaign, ctx.template, ctx.animationStyle)
  const pages = []
  const manifest = ctx.manifest || {}
  const pm = h.pagemapHtml5(ctx.pagemapText).filter((p) => p.html5)
  if (!pm.length) { warn('HTML5_NO_PAGES', 'no pagemap row has html5 = yes'); return { pages, warnings } }
  // DA writes are made as the signed-in user (or with DA_TOKEN); there is no service-token fallback.
  if (!ctx.daToken) { warn('HTML5_DA_NO_ACCESS', 'no Document Authoring token: start HTML5 banners from the Generate Banners dialog while signed in, or configure DA_TOKEN'); return { pages, warnings } }

  // 1. variations sheet (image cells -> delivery URLs of approved assets)
  const urlCache = new Map()
  const resolveImage = (v) => {
    const s = String(v == null ? '' : v).trim()
    return IMAGE_CELL.test(s) && urlCache.has(s) ? urlCache.get(s) : v
  }
  for (const rec of h.variationsSheet(ctx.csvText).data) {
    for (const [col, v] of Object.entries(rec)) {
      const s = String(v).trim()
      if (col === 'clickthrough' || !IMAGE_CELL.test(s) || urlCache.has(s)) continue
      const damPath = (ctx.imageSource && ctx.imageSource.get(s)) || (s.startsWith('/content/dam/') ? s : `${ctx.folder}/${s}`)
      try {
        if (!(await isApproved(author, aemToken, damPath))) {
          warn('HTML5_ASSET_NOT_DELIVERABLE', `${col} "${s}": ${damPath} is not approved, so Dynamic Media will not deliver it`)
        }
        urlCache.set(s, deliveryUrl(author, await deps.assetId(damPath), damPath.split('/').pop()))
      } catch (e) {
        warn('HTML5_ASSET_NOT_DELIVERABLE', `${col} "${s}": ${e.message}`)
        urlCache.set(s, s)
      }
    }
  }
  const sheet = h.variationsSheet(ctx.csvText, resolveImage)
  if (!sheet.data.some((r) => r.clickthrough)) {
    warn('HTML5_NO_CLICKTHROUGH', 'the variations CSV has no click-through column (e.g. clickthrough, clickthru, clickTag, cta-url, cta-link, landing-page) or it is empty; exported ads will not click through')
  }

  try {
    const key = stateKey(cfg, paths.rowsPath)
    const current = await daGet(cfg, ctx.daToken, paths.rowsPath)
    let last = null
    if (ctx.state) { try { const r = await ctx.state.get(key); last = r && r.value ? JSON.parse(r.value) : null } catch (e) { /* no record */ } }
    let currentJson = null
    try { currentJson = current ? JSON.parse(current) : null } catch (e) { /* not JSON */ }
    if (currentJson && (!last || h.sheetEdited(currentJson, last))) {
      warn('HTML5_SHEET_EDITED', `${paths.rowsPath} was edited in DA since the last run; it was left as is`)
    } else {
      await daPut(cfg, ctx.daToken, paths.rowsPath, JSON.stringify(sheet), 'application/json')
      if (ctx.state) await ctx.state.put(key, JSON.stringify(sheet), { ttl: 365 * 24 * 3600 })
    }
    await edsPreview(cfg, ctx.edsToken, paths.rowsPath, ctx.edsBearer)
  } catch (e) {
    warn(e.code || 'HTML5_DA_ERROR', e.message)
    if (e.code === 'HTML5_DA_NO_ACCESS' || e.code === 'HTML5_NO_EDS_SITE') return { pages, warnings }
  }

  // 2. one DA page per html5 size: write its slices into DA in the same folder, then write and preview it.
  // Slices are new renders, not AEM assets: they go straight into DA alongside the page (`<size>-static-N.png`)
  // so no per-size subfolder is created, and EDS copies them into the page's media when it previews it.
  // No AEM approval or Dynamic Media delivery is involved.
  const sized = []
  for (const p of pm) {
    if (p.unknownMotion.length) warn('HTML5_MOTION_UNKNOWN', `${p.pagename}: unknown motion ${p.unknownMotion.join(', ')} (ignored)`)
    if (p.tooLong) warn('HTML5_TOO_LONG', `${p.pagename}: duration x loops is over 30 s; the block caps it`)
    const page = manifest[p.pagename]
    if (!page) { warn('HTML5_NO_PAGES', `${p.pagename}: the render produced no HTML5 layers (is the page in the template?)`); continue }
    const uploaded = []
    for (const s of page.slices || []) {
      const file = `${s.name}.png`
      const url = ctx.slices.get(`${p.pagename}/${file}`)
      if (!url) { warn('HTML5_DA_ERROR', `${p.pagename}: slice ${file} missing from render outputs`); continue }
      try {
        const buf = await deps.fetchBuf(url)
        const daPath = `${paths.base}/${h.slug(p.pagename)}-${file}`
        await daPut(cfg, ctx.daToken, daPath, buf, 'image/png')
        uploaded.push({ name: s.name, file, url: contentUrl(cfg, daPath) })
      } catch (e) { warn(e.code || 'HTML5_DA_ERROR', `${p.pagename}/${file}: ${e.message}`) }
    }
    // no budget check here: these are raw 2x PNG uploads. The packager re-encodes them per
    // budget step (JPEG back slice, smaller widths) and flags HTML5_OVER_BUDGET on the zip.
    sized.push({ p, page, uploaded })
  }
  for (const { p, page, uploaded } of sized) {
    const sliceUrls = new Map(uploaded.filter((u) => u.url).map((u) => [u.name, u.url]))
    const path = paths.pagePath(p.pagename)
    try {
      const authored = h.readDaPage(await daGet(cfg, ctx.daToken, `${path}.html`))
      const layers = h.layersFromManifest(page, { sliceUrl: (s) => sliceUrls.get(s.name) || '', pagemapMotion: p.motion, authored, text: cfg.text, animationStyle: ctx.animationStyle, duration: p.duration })
      const html = h.daPageHtml({ width: page.width, height: page.height, duration: p.duration, loops: p.loops, rowsPath: paths.rowsPath, layers })
      await daPut(cfg, ctx.daToken, `${path}.html`, html, 'text/html')
      await edsPreview(cfg, ctx.edsToken, path, ctx.edsBearer)
      pages.push({ page: p.pagename, path, previewUrl: paths.previewUrl(p.pagename), rows: sheet.data.length })
    } catch (e) { warn(e.code || 'HTML5_DA_ERROR', `${p.pagename}: ${e.message}`) }
  }
  return { pages, rowsUrl: `${cfg.previewOrigin}${paths.rowsPath}`, warnings }
}

module.exports = { daGet, daPut, edsPreview, deliveryUrl, isApproved, sliceOf, publishHtml5, reuseHtml5FromSite }
