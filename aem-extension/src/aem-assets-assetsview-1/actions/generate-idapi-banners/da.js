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

// ---- AEM: delivery URLs and approval ----
// author-pX-eY.adobeaemcloud.com -> delivery-pX-eY.adobeaemcloud.com
function deliveryUrl (author, id, name) {
  const host = new URL(author).host.replace(/^author-/, 'delivery-')
  return `https://${host}/adobe/assets/${id}/as/${encodeURIComponent(name)}`
}
const assetApi = (author, damPath) => `${author}/api/assets${enc(damPath.replace(/^\/content\/dam/, ''))}`
// Approve with a Sling POST on the metadata node. The Assets HTTP API PUT answers 200 for dam:status but
// does not save it, so it is only a fallback. A dam:status set while asset processing runs can be dropped
// when processing rewrites the metadata, so wait for processing, approve, read it back, and retry.
async function approveAsset (author, token, damPath) {
  const res = await fetch(`${author}${enc(damPath)}/jcr:content/metadata`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ 'dam:status': 'approved' }).toString()
  })
  if (res.ok && await isApproved(author, token, damPath)) return
  const put = await fetch(assetApi(author, damPath), {
    method: 'PUT',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ class: 'asset', properties: { 'dam:status': 'approved' } })
  })
  if (!res.ok && !put.ok) throw new Error(`approve ${damPath} -> ${res.status} (POST), ${put.status} (PUT)`)
}
async function processed (author, token, damPath) {
  const res = await fetch(`${author}${enc(damPath)}/jcr:content.json`, { headers: { Authorization: `Bearer ${token}` } })
  if (!res.ok) return false
  const state = String((await res.json())['dam:assetState'] || 'processed').toLowerCase()
  return state === 'processed'
}
// Tries until `until` (a shared deadline, so a failing approval can't run the worker into its time limit).
async function approveWhenProcessed (author, token, damPath, sleep, until, maxTries = 10) {
  let last = 'still processing'
  for (let i = 0; i < maxTries; i++) {
    try {
      if (await processed(author, token, damPath)) {
        await approveAsset(author, token, damPath)
        if (await isApproved(author, token, damPath)) return
        last = 'approval did not save'
      }
    } catch (e) { last = e.message }
    if (Date.now() >= until) break
    await sleep(Math.min(2000 * 2 ** i, 8000))
  }
  throw new Error(`${damPath} could not be approved (${last}), so Dynamic Media will not deliver it`)
}
// Dynamic Media serves an asset a little after approval. EDS copies a page's images when it previews the
// page, so wait (bounded) until the slices are served; an image still missing then previews broken.
async function waitDelivered (urls, sleep, until) {
  let pending = [...urls]
  for (let i = 0; pending.length; i++) {
    const left = []
    for (const u of pending) {
      try { const r = await fetch(u, { method: 'HEAD' }); if (!r.ok) left.push(u) } catch (e) { left.push(u) }
    }
    pending = left
    if (!pending.length || Date.now() >= until) break
    await sleep(Math.min(2000 * 2 ** i, 10000))
  }
  return pending
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
    try { p = decodeURIComponent(p) } catch (e) {}
    p = p.replace(/\\/g, '/')
    const m = /(?:^|\/)([^/]+?)--(static-\d+\.png)$/.exec(p) || /(?:^|\/)html5\/([^/]+)\/(static-\d+\.png)$/.exec(p)
    if (m) return { page: m[1], file: m[2] }
  }
  return null
}

const stateKey = (cfg, path) => `html5sheet.${crypto.createHash('sha1').update(`${cfg.org}/${cfg.site}${path}`).digest('hex')}`

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
  const paths = h.campaignPaths(cfg, ctx.campaign, ctx.template)
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

  // 2. one DA page per html5 size: write its slices into DA next to the page, then write and preview it.
  // Slices are new renders, not AEM assets: they go straight into DA (the `.<page>` folder, as da.live
  // stores an image dropped into a page) and EDS copies them into the page's media when it previews it.
  // No AEM approval or Dynamic Media delivery is involved.
  const sized = []
  for (const p of pm) {
    if (p.unknownMotion.length) warn('HTML5_MOTION_UNKNOWN', `${p.pagename}: unknown motion ${p.unknownMotion.join(', ')} (ignored)`)
    if (p.tooLong) warn('HTML5_TOO_LONG', `${p.pagename}: duration x loops is over 30 s; the block caps it`)
    const page = manifest[p.pagename]
    if (!page) { warn('HTML5_NO_PAGES', `${p.pagename}: the render produced no HTML5 layers (is the page in the template?)`); continue }
    const mediaDir = `${paths.base}/.${h.slug(p.pagename)}`
    const uploaded = []
    for (const s of page.slices || []) {
      const file = `${s.name}.png`
      const url = ctx.slices.get(`${p.pagename}/${file}`)
      if (!url) { warn('HTML5_DA_ERROR', `${p.pagename}: slice ${file} missing from render outputs`); continue }
      try {
        const buf = await deps.fetchBuf(url)
        const daPath = `${mediaDir}/${file}`
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
      const layers = h.layersFromManifest(page, { sliceUrl: (s) => sliceUrls.get(s.name) || '', pagemapMotion: p.motion, authored })
      const html = h.daPageHtml({ width: page.width, height: page.height, duration: p.duration, loops: p.loops, rowsPath: paths.rowsPath, layers })
      await daPut(cfg, ctx.daToken, `${path}.html`, html, 'text/html')
      await edsPreview(cfg, ctx.edsToken, path, ctx.edsBearer)
      pages.push({ page: p.pagename, path, previewUrl: paths.previewUrl(p.pagename), rows: sheet.data.length })
    } catch (e) { warn(e.code || 'HTML5_DA_ERROR', `${p.pagename}: ${e.message}`) }
  }
  return { pages, rowsUrl: `${cfg.previewOrigin}${paths.rowsPath}`, warnings, delivery: [] }
}

/*
 * The follow-up to publishHtml5: approve each uploaded slice once AEM has processed it, wait until Dynamic
 * Media serves it, then preview its page again so EDS copies the image. A slice still processing at
 * `approveBy`, or approved but not yet served at `deliveredBy`, is returned in `remaining` (for another
 * run); a page is previewed only once none of its slices remain, unless `final` (the last run).
 * ctx: { cfg, edsToken, edsBearer, author, aemToken, slices: [{ damPath, url, page }], approveBy,
 *        deliveredBy, final, sleep, logger }
 * Returns { previewed: [page path], remaining: [slice], warnings }.
 */
async function deliverHtml5 (ctx) {
  const { cfg, author, aemToken } = ctx
  const sleep = ctx.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)))
  const warnings = []
  const warn = (code, message) => { warnings.push({ code, message }); if (ctx.logger) ctx.logger.warn(`${code}: ${message}`) }
  const slices = ctx.slices || []
  const waiting = []
  const queue = [...slices]
  await Promise.all(Array.from({ length: Math.min(6, queue.length) }, async () => {
    for (let s = queue.shift(); s; s = queue.shift()) {
      try {
        await approveWhenProcessed(author, aemToken, s.damPath, sleep, ctx.approveBy, 1000)
      } catch (e) {
        waiting.push(s)
        if (ctx.final) warn('HTML5_ASSET_NOT_DELIVERABLE', e.message)
      }
    }
  }))
  const approved = slices.filter((s) => !waiting.includes(s))
  const late = new Set(await waitDelivered(approved.map((s) => s.url), sleep, ctx.deliveredBy))
  const remaining = [...waiting, ...approved.filter((s) => late.has(s.url))]
  const pagesOf = (list) => [...new Set(list.map((s) => s.page))]
  const blocked = new Set(pagesOf(remaining))
  const previewed = []
  for (const page of pagesOf(slices)) {
    if (blocked.has(page) && !ctx.final) continue
    try {
      await edsPreview(cfg, ctx.edsToken, page, ctx.edsBearer)
      previewed.push(page)
    } catch (e) { warn(e.code || 'HTML5_EDS_ERROR', `${page}: ${e.message}`) }
  }
  if (ctx.final) {
    const notServed = approved.filter((s) => late.has(s.url))
    for (const page of pagesOf(notServed)) {
      warn('HTML5_ASSET_NOT_DELIVERABLE', `${page}: ${notServed.filter((s) => s.page === page).length} slice(s) not yet served by Dynamic Media; preview the page again in DA once they are`)
    }
  }
  return { previewed, remaining, warnings }
}

module.exports = { daGet, daPut, edsPreview, deliveryUrl, approveAsset, isApproved, sliceOf, publishHtml5, deliverHtml5 }
