/*
 * generate-idapi-banners — Adobe I/O Runtime action.
 *
 * The server-side engine behind the "Generate Banners" ActionBar button. Given
 * an AEM DAM folder (the "job key"), it: reads + classifies the folder, stages
 * inputs to presigned storage the InDesign API can fetch, executes the registered
 * InDesign capability (headless render), and writes the outputs back into the
 * folder's output/ subfolder — unpublished, for review.
 *
 * This is the deployed twin of cloud/aem-render.mjs. Node 22 (global fetch).
 */

const crypto = require('crypto')
const filesLib = require('@adobe/aio-lib-files')
const { Core } = require('@adobe/aio-sdk')
const { planRelations, assetId, applyPlan } = require('./relations')
const { isDeliverable, isDamFolder } = require('../job-utils')
const { remapSources, linksFromIndd } = require('./remap')
const { damLinksFromTemplate, resolveSwappedImages } = require('./links')
const psd = require('./psd')
const images = require('./images')
const { attachPreview, previewKey } = require('./renditions')
const { classify } = require('./classify')
const { csvRecords } = require('./csv')
const html5 = require('./html5')
const { publishHtml5, sliceOf, reuseHtml5FromSite } = require('./da')
const { runPreflight, runPsdChecks, missingInputs, summarize, parsePreflightPayload, sanitizeIndFindings, MAX_STORED_FINDINGS } = require('./preflight')
const { resolveExecuteUrl } = require('./capability')
const { errorResponse, userBearer, stringParameters, checkMissingRequestInputs } = require('../utils')

const DEFAULT_IMS_ENDPOINT = 'https://ims-na1.adobelogin.com/ims/token/v3'

// Mint a fresh AEM token from an OAuth Server-to-Server credential (recommended)
// or an AEM Service Credential JSON (OAuth S2S or legacy JWT fallback).
const b64url = (x) => Buffer.from(x).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
async function aemTokenFromOAuthS2S (params) {
  const endpoint = params.IMS_ENDPOINT || DEFAULT_IMS_ENDPOINT
  const scopes = params.AEM_OAUTH_SCOPES || 'openid,AdobeID,aem.folders,aem.assets.author,read_organizations'
  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: params.AEM_OAUTH_CLIENT_ID,
    client_secret: params.AEM_OAUTH_CLIENT_SECRET,
    scope: scopes
  })
  const r = await fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body })
  if (!r.ok) throw new Error('AEM OAuth S2S token ' + r.status + ' ' + (await r.text()).slice(0, 150))
  return (await r.json()).access_token
}
async function aemTokenFromServiceCredential (scB64, fallbackImsEndpoint) {
  const parsed = JSON.parse(Buffer.from(scB64, 'base64').toString('utf8'))
  const sc = parsed.integration || parsed
  // Support OAuth S2S JSON payload if provided without a privateKey
  if (!sc.privateKey && (sc.clientId || sc.client_id) && (sc.clientSecret || sc.client_secret)) {
    return aemTokenFromOAuthS2S({
      IMS_ENDPOINT: sc.imsEndpoint ? `https://${sc.imsEndpoint.replace(/^https?:\/\//, '')}/ims/token/v3` : fallbackImsEndpoint,
      AEM_OAUTH_CLIENT_ID: sc.clientId || sc.client_id,
      AEM_OAUTH_CLIENT_SECRET: sc.clientSecret || sc.client_secret,
      AEM_OAUTH_SCOPES: sc.scopes || sc.metascopes
    })
  }
  const now = Math.floor(Date.now() / 1000)
  const payload = { exp: now + 300, iss: sc.org, sub: sc.id, aud: `https://${sc.imsEndpoint}/c/${sc.technicalAccount.clientId}` }
  payload[`https://${sc.imsEndpoint}/s/${sc.metascopes}`] = true
  const si = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' })) + '.' + b64url(JSON.stringify(payload))
  const jwt = si + '.' + b64url(crypto.sign('RSA-SHA256', Buffer.from(si), sc.privateKey))
  const body = new URLSearchParams({ client_id: sc.technicalAccount.clientId, client_secret: sc.technicalAccount.clientSecret, jwt_token: jwt })
  const r = await fetch(`https://${sc.imsEndpoint}/ims/exchange/jwt`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body })
  if (!r.ok) throw new Error('AEM JWT exchange ' + r.status + ' ' + (await r.text()).slice(0, 150))
  return (await r.json()).access_token
}
function hasDurableAemAuth (params = {}) {
  return Boolean((params.AEM_OAUTH_CLIENT_ID && params.AEM_OAUTH_CLIENT_SECRET) || params.AEM_SC_JSON || params.AEM_DEV_TOKEN)
}

// ---- AEM Assets helpers (use the caller's IMS token) ----
const encodePath = (p) => String(p || '').split('/').map(encodeURIComponent).join('/')
function aemApiPath (author, damPath) {
  const rel = damPath.replace(/^\/content\/dam/, '').replace(/^\//, '')
  return `${author}/api/assets/${encodePath(rel)}.json`
}
async function aemList (author, token, damPath) {
  // The Assets HTTP API returns one page of entities at a time (a folder with more than
  // ~20 children silently lost the rest), so page with offset/limit until exhausted.
  const out = []
  const seen = new Set()
  let offset = 0
  for (let i = 0; i < 100; i++) {
    const res = await fetch(`${aemApiPath(author, damPath)}?offset=${offset}&limit=100`, { headers: { Authorization: `Bearer ${token}` } })
    if (!res.ok) throw new Error(`AEM list ${damPath} -> ${res.status}`)
    const j = await res.json()
    const ents = j.entities || []
    if (!ents.length) break
    let added = 0
    for (const e of ents) {
      const name = e.properties && e.properties.name
      if (seen.has(name)) continue
      seen.add(name)
      added++
      out.push({ name, isFolder: (e.class || []).join(',').includes('folder') })
    }
    const total = j.properties && j.properties['srn:paging'] && Number(j.properties['srn:paging'].total)
    offset += ents.length
    if (!added || (total && offset >= total)) break
  }
  return out
}
async function aemListSafe (author, token, damPath) {
  // Optional folders (shared/per-job fonts) may not exist — treat any list
  // failure (404 etc.) as "no entries here" rather than aborting the job.
  try { return await aemList(author, token, damPath) } catch (e) { return [] }
}
async function aemDownload (author, token, damPath) {
  const url = `${author}${damPath.split('/').map(encodeURIComponent).join('/')}`
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } })
  if (!res.ok) throw new Error(`AEM download ${damPath} -> ${res.status}`)
  return Buffer.from(await res.arrayBuffer())
}
// AEM as a Cloud Service direct-binary upload: initiate -> bare block PUT -> complete.
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// Resilient HTTP fetch wrapper that honors Retry-After on 429 Too Many Requests and retries transient 502/504 gateway errors.
async function fetchWithRetry (url, opts, { retries = 3, baseDelayMs = 1500 } = {}) {
  for (let attempt = 1; ; attempt++) {
    const res = await fetch(url, opts)
    if (!res || !(res.status === 429 || res.status === 502 || res.status === 504) || attempt > retries) {
      return res
    }
    let delayMs = baseDelayMs * attempt
    const retryAfter = res.headers && typeof res.headers.get === 'function' ? res.headers.get('retry-after') : null
    if (retryAfter) {
      const secs = Number(retryAfter)
      if (Number.isFinite(secs) && secs > 0) delayMs = Math.min(30000, secs * 1000)
    }
    await sleep(delayMs)
  }
}
async function verifyAemAsset (author, token, damPath) {
  const url = `${author}${damPath.split('/').map(encodeURIComponent).join('/')}`
  const delays = [1000, 2000, 4000, 8000, 15000]
  let lastStatus = 0
  for (let i = 0; i <= delays.length; i++) {
    const res = await fetch(url, { method: 'HEAD', headers: { Authorization: `Bearer ${token}` } })
    lastStatus = res.status
    if (res.ok) return
    if (i < delays.length) await sleep(delays[i])
  }
  throw new Error(`AEM asset ${damPath} was not readable after upload (last status ${lastStatus})`)
}
// initiateUpload does not create missing folders (404), so make them first. Creates each
// missing level via the Assets HTTP API; an already-existing folder is left alone.
async function ensureFolder (author, token, damPath) {
  const headers = { Authorization: `Bearer ${token}` }
  const head = await fetch(aemApiPath(author, damPath), { headers })
  if (head.ok) return
  const cut = damPath.lastIndexOf('/')
  const parent = damPath.slice(0, cut)
  if (/^\/content\/dam\/.+/.test(parent)) await ensureFolder(author, token, parent)
  const name = damPath.slice(cut + 1)
  const rel = damPath.replace(/^\/content\/dam/, '').split('/').map(encodeURIComponent).join('/')
  const res = await fetch(`${author}/api/assets${rel}`, {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({ class: 'assetFolder', properties: { title: name } })
  })
  if (!res.ok && res.status !== 409) throw new Error(`create folder ${damPath} -> ${res.status}`)
}
async function aemUpload (author, token, folderDamPath, name, buf, mime) {
  const encodedFolder = encodePath(folderDamPath)
  const initiate = () => fetch(`${author}${encodedFolder}.initiateUpload.json`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ fileName: name, fileSize: String(buf.length) })
  })
  let ir = await initiate()
  // a folder just created can take a moment to accept uploads, so retry the initiate briefly
  if (ir.status === 404) {
    await ensureFolder(author, token, folderDamPath)
    for (const ms of [0, 1000, 2000, 4000, 8000]) { if (ms) await sleep(ms); ir = await initiate(); if (ir.status !== 404) break }
  }
  if (!ir.ok) throw new Error(`initiateUpload ${name} -> ${ir.status}`)
  const f = (JSON.parse((await ir.text()).replace(/^\)\]\}'?/, '')).files || [])[0]
  if (!f || !f.uploadURIs || !f.uploadURIs.length) throw new Error(`initiateUpload ${name}: no upload URI`)
  const uris = f.uploadURIs, partSize = Math.ceil(buf.length / uris.length)
  for (let i = 0; i < uris.length; i++) {
    const part = buf.subarray(i * partSize, Math.min((i + 1) * partSize, buf.length))
    const pr = await fetch(uris[i], { method: 'PUT', body: part })
    if (!(pr.status === 201 || pr.ok)) throw new Error(`upload PUT ${name} part ${i} -> ${pr.status}`)
  }
  const cr = await fetch(`${author}${encodedFolder}.completeUpload.json`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ fileName: name, mimeType: mime || f.mimeType || 'application/octet-stream', uploadToken: f.uploadToken, fileSize: String(buf.length) })
  })
  if (!cr.ok) throw new Error(`completeUpload ${name} -> ${cr.status}`)
  await verifyAemAsset(author, token, `${folderDamPath}/${name}`)
}

// ---- classification (folder-as-key contract) ----
const isFont = (n) => /\.(otf|ttf|ttc|woff2?|dfont)$/i.test(n)
function missingMessage (missing, templateName) {
  return templateName && missing.includes('template')
    ? `the selected template ${templateName} was not found in the folder (also missing: ${missing.filter((k) => k !== 'template').join(', ') || 'nothing else'})`
    : `folder is missing required input(s): ${missing.join(', ')}`
}
// Resolve every image the CSV references (job folder, subfolders, or a path from the job folder),
// throwing a readable error for anything missing, ambiguous or outside the folder. Bare names that
// are nowhere in the folder are tolerated for INDD templates (their Asset Links may supply them).
async function planImages (author, token, folder, c, csvText, { allowBareUnresolved = false } = {}) {
  const plan = await images.resolveImageRefs({
    folder,
    rootImages: c.images,
    cells: images.csvImageCells(csvRecords(csvText)),
    list: (dir) => aemListSafe(author, token, dir)
  })
  const errs = images.problems(plan, folder, { allowBareUnresolved })
  if (errs.length) throw new Error(errs.join('; '))
  return plan
}
// CSV cells that must be rewritten to the flat staged name of the image they point at.
const renameMap = (plan) => new Map(plan.resolved.filter((r) => r.staged !== r.ref).map((r) => [r.ref, r.staged]))
const rewriteCsvText = (text, plan) => {
  const map = renameMap(plan)
  return map.size ? images.rewriteRecords(csvRecords(text), map).join('\n') + '\n' : text
}
// Swapped images that aren't in the job folder may be AEM-linked (Asset Link) in the INDD template.
async function resolveImages (author, folder, templateBuf, plan) {
  const { host } = new URL(author)
  const { fromLinks, unresolved } = resolveSwappedImages(
    new Set(plan.unresolved.map((u) => u.ref)), [], damLinksFromTemplate(templateBuf), host)
  if (unresolved.length) throw new Error(`image(s) referenced by the CSV were not found in ${folder}, its subfolders or the template's AEM links: ${unresolved.join(', ')}`)
  return { fromLinks }
}
function isAllowedAemAuthor (discoveredAuthor, params = {}) {
  const discHost = new URL(discoveredAuthor).host.toLowerCase()
  const defaultAuthor = String(params.AEM_AUTHOR_URL || '').replace(/\/+$/, '')
  const allowedRaw = String(params.ALLOWED_AEM_AUTHORS || '').trim()
  if (allowedRaw) {
    const tokens = allowedRaw.split(',').map((s) => s.trim().replace(/\/+$/, '').toLowerCase()).filter(Boolean)
    if (defaultAuthor) tokens.push(defaultAuthor.toLowerCase())
    return tokens.some((entry) => {
      if (entry === discoveredAuthor.toLowerCase() || entry === discHost) return true
      if (/^p\d+$/i.test(entry)) return discHost.startsWith(`author-${entry}-`)
      try { return new URL(entry).host.toLowerCase() === discHost } catch (e) { return false }
    })
  }
  // When a default AEM_AUTHOR_URL with a Cloud Manager program ID (author-p<N>-e<M>) is configured,
  // allow any environment in the same program (e.g. dev/stage/prod) and reject cross-program hosts.
  const progMatch = /^https:\/\/author-(p\d+)-e\d+\.adobeaemcloud\.com$/i.exec(defaultAuthor)
  const discProg = /^author-(p\d+)-e\d+\.adobeaemcloud\.com$/i.exec(discHost)
  if (progMatch && discProg) {
    return progMatch[1].toLowerCase() === discProg[1].toLowerCase()
  }
  return true
}
function aemAuthor (params = {}) {
  const discoveredAuthor = String(params.aemAuthorUrl || '').replace(/\/+$/, '')
  if (discoveredAuthor) {
    if (!/^https:\/\/author-[a-z0-9-]+\.adobeaemcloud\.com$/i.test(discoveredAuthor)) {
      throw new Error('aemAuthorUrl must be an AEM Cloud author URL')
    }
    if (!isAllowedAemAuthor(discoveredAuthor, params)) {
      throw new Error('aemAuthorUrl is not allowed for this deployment')
    }
  }
  const author = discoveredAuthor || String(params.AEM_AUTHOR_URL || '').replace(/\/+$/, '')
  if (!author) throw new Error('AEM_AUTHOR_URL is not configured for this deployment')
  if (!/^https:\/\//i.test(author)) throw new Error('AEM_AUTHOR_URL must be an https URL')
  return author
}
async function aemContext (params) {
  let aemToken
  if (params.AEM_OAUTH_CLIENT_ID && params.AEM_OAUTH_CLIENT_SECRET) aemToken = await aemTokenFromOAuthS2S(params)
  else if (params.AEM_SC_JSON) aemToken = await aemTokenFromServiceCredential(params.AEM_SC_JSON, params.IMS_ENDPOINT)
  else aemToken = params.AEM_DEV_TOKEN || userBearer(params)
  if (!aemToken) throw new Error('no AEM token')
  return { author: aemAuthor(params), aemToken }
}
// Allowlist of trusted HTTPS origins from which HTML5 static slices may be fetched during slice reuse.
function isTrustedSliceUrl (url) {
  try {
    const u = new URL(String(url || ''))
    if (u.protocol !== 'https:') return false
    const h = u.hostname.toLowerCase()
    return (
      h === 'admin.da.live' ||
      h === 'content.da.live' ||
      /^[a-z0-9-]+\.(aem|hlx)\.(page|live)$/i.test(h) ||
      /^delivery-p\d+-e\d+\.adobeaemcloud\.com$/i.test(h)
    )
  } catch (e) {
    return false
  }
}
// Verify the signed-in caller can read the target DAM folder with their own token (no service credential used).
async function hasFolderAccess (params, userToken, folder) {
  if (!userToken || !isDamFolder(folder)) return false
  const author = aemAuthor(params)
  const res = await fetch(aemApiPath(author, folder), { method: 'HEAD', headers: { Authorization: `Bearer ${userToken}` } })
  return Boolean(res && res.ok)
}
// The folders whose html5.json can name a campaign folder's EDS / DA site: the folder itself, then each
// folder above it up to (not including) /content/dam. The nearest html5.json wins, so one file in a
// brand folder serves every campaign under it and a campaign can still override it.
function html5JsonFolders (folder) {
  const parts = String(folder || '').replace(/\/+$/, '').split('/')
  if (parts.length < 4 || parts[1] !== 'content' || parts[2] !== 'dam') return []
  const out = []
  for (let i = parts.length; i > 3; i--) out.push(parts.slice(0, i).join('/'))
  return out
}
// Finds the nearest html5.json: { text, foundAt, checked } (text and foundAt null when there is none).
// A read failure other than 404 (AEM unreachable, no access) is rethrown as is.
async function html5SiteLookup (author, aemToken, folder) {
  const checked = []
  for (const f of html5JsonFolders(folder)) {
    checked.push(f)
    try {
      return { text: (await aemDownload(author, aemToken, `${f}/html5.json`)).toString('utf8'), foundAt: f, checked }
    } catch (e) {
      if (!/-> 404$/.test(e.message)) throw e
    }
  }
  return { text: null, foundAt: null, checked }
}
// The EDS / DA site of a campaign folder, from the nearest html5.json (html5.siteConfig throws
// HTML5_NO_SITE when there is none or it is invalid).
async function html5SiteFor (author, aemToken, folder) {
  const { text, foundAt } = await html5SiteLookup(author, aemToken, folder)
  return html5.siteConfig(text, foundAt && foundAt !== folder ? foundAt : undefined)
}
// Images opened to check size and format: bounded so a big CSV can't stall the start action.
const PROBE_MAX = 60
const PROBE_CONCURRENCY = 4
const READ_CONCURRENCY = 4
const PROBE_BUDGET_MS = 20000

// Bounded-concurrency helper for read-only AEM GET requests (preserves input order).
// Never used for file/binary writes (stageInputs / aemUpload), which stay strictly sequential.
async function mapConcurrent (items, limit, fn) {
  const list = [...items]
  const out = new Array(list.length)
  let next = 0
  const worker = async () => {
    while (next < list.length) {
      const i = next++
      out[i] = await fn(list[i], i)
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, list.length) }, worker))
  return out
}

async function probeImages (author, token, resolved) {
  const paths = [...new Set(resolved.map((r) => r.damPath))].slice(0, PROBE_MAX)
  const probes = new Map()
  const deadline = Date.now() + PROBE_BUDGET_MS
  let next = 0
  const worker = async () => {
    while (next < paths.length && Date.now() < deadline) {
      const damPath = paths[next++]
      try {
        const buf = await aemDownload(author, token, damPath)
        probes.set(damPath, { size: buf.length, dims: psd.imageSize(buf) })
      } catch (e) { /* not opened: counted as unchecked, not as a problem with the image */ }
    }
  }
  await Promise.all(Array.from({ length: Math.min(PROBE_CONCURRENCY, paths.length) }, worker))
  return probes
}
// Best-effort, non-blocking warmup ping fired during stage-1 preflight for .indd templates.
// Sending an empty job wakes a scaled-to-zero Azure CXP Windows InDesign Server VM while the
// user is still reading the modal, shaving minutes off cold-start queue wait times.
async function warmupIndesign (params) {
  if (!params || !params.FFS_CLIENT_ID || !params.FFS_CLIENT_SECRET || !params.INDESIGN_EXECUTE_URL) return
  try {
    const tok = await imsToken(params)
    await fetch(params.INDESIGN_EXECUTE_URL, {
      method: 'POST',
      headers: { ...idH(params, tok), 'Content-Type': 'application/json' },
      body: JSON.stringify({ assets: [], params: {} })
    })
  } catch (e) { /* non-fatal warmup */ }
}

// Stage-1 preflight: everything decidable from the job folder alone, with no render started.
// Never throws for a problem with the inputs; those come back as findings ({ ok, findings, ... }).
async function inspectInputs (params) {
  const { author, aemToken } = await aemContext(params)
  const entries = await aemList(author, aemToken, params.folder)
  const c = classify(entries, params.template)
  const missing = ['template', 'variations', 'pagemap'].filter((k) => !c[k])
  if (missing.length) {
    const r = missingInputs(missingMessage(missing, params.template))
    return { variationRows: 0, pageCount: 0, template: c.template ? c.template.name : '', variations: c.variations ? c.variations.name : '', pagemap: c.pagemap ? c.pagemap.name : '', ...r }
  }
  if (!isPsd(c.template.name)) {
    // Wake the InDesign API worker pool in parallel with the AEM preflight downloads (bounded to 1.5s)
    Promise.race([warmupIndesign(params), sleep(1500)]).catch(() => {})
  }
  const [variationsBuf, pagemapBuf] = await Promise.all([
    aemDownload(author, aemToken, `${params.folder}/${c.variations.name}`),
    aemDownload(author, aemToken, `${params.folder}/${c.pagemap.name}`)
  ])
  const variationsText = variationsBuf.toString('utf8')
  const pagemapText = pagemapBuf.toString('utf8')
  const known = new Set(c.images.map((i) => i.name))
  const plan = await images.resolveImageRefs({
    folder: params.folder,
    rootImages: c.images,
    cells: images.csvImageCells(csvRecords(variationsText)),
    list: async (dir) => {
      const found = await aemListSafe(author, aemToken, dir)
      found.forEach((e) => { if (!e.isFolder) known.add(dir === params.folder ? e.name : `${dir.slice(params.folder.length + 1)}/${e.name}`) })
      return found
    }
  })
  if (!isPsd(c.template.name) && plan.unresolved.length) {
    // INDD: a swapped image missing from the folder may still be an AEM link inside the template.
    // Only download the template binary when there are unresolved bare image names to check.
    try {
      const templateBuf = await aemDownload(author, aemToken, `${params.folder}/${c.template.name}`)
      const { host } = new URL(author)
      const { unresolved } = resolveSwappedImages(new Set(plan.unresolved.map((u) => u.ref)), [], damLinksFromTemplate(templateBuf), host)
      const still = new Set(unresolved)
      plan.unresolved = plan.unresolved.filter((u) => still.has(u.ref))
    } catch (e) { /* unreadable links: keep every miss */ }
  }
  const probes = await probeImages(author, aemToken, plan.resolved)
  const r = runPreflight({ csvText: variationsText, pagemapText, plan, known: [...known], probes })
  const variationRows = Math.max(0, csvRecords(variationsText).length - 1)
  const pageCount = Math.max(0, csvRecords(pagemapText).length - 1)
  // The sizes an HTML5 run would publish (InDesign only), for the modal's HTML5 page.
  // Where they would go: the folder's own site from html5.json, or why HTML5 can't run here.
  let html5Pages = []
  const site = {}
  if (!isPsd(c.template.name)) {
    try { html5Pages = html5.pagemapHtml5(pagemapText).filter((p) => p.html5).map((p) => p.pagename) } catch (e) { /* unreadable pagemap: preflight reports it */ }
    // Folders the dialog's site picker can save html5.json in (campaign folder first).
    site.html5Folders = html5JsonFolders(params.folder)
    try {
      const found = await html5SiteLookup(author, aemToken, params.folder)
      if (!found.foundAt) site.html5Checked = found.checked
      site.html5FoundAt = found.foundAt
      const cfg = html5.siteConfig(found.text, found.foundAt && found.foundAt !== params.folder ? found.foundAt : undefined)
      site.html5Site = `${cfg.org}/${cfg.site}`
      site.html5Path = html5.campaignPaths(cfg, params.folder.split('/').pop(), c.template.name).base
    } catch (e) {
      site.html5SiteError = e.code === 'HTML5_NO_SITE' ? e.message : `html5.json could not be read: ${e.message}`
    }
  }
  return { variationRows, pageCount, html5Pages, ...site, template: c.template.name, variations: c.variations.name, pagemap: c.pagemap.name, ...r }
}
const isPsd = (name) => /\.psd$/i.test(name || '')
function destFor (kind, name) {
  if (kind === 'template') return 'template/brand-template.indd'
  if (kind === 'psd') return 'template/brand-template.psd'
  if (kind === 'variations') return 'input/brand-variations.csv'
  if (kind === 'pagemap') return 'input/pagemap.csv'
  if (kind === 'image') return 'assets/shots/' + name
  // InDesign auto-activates any font in a "Document Fonts" folder next to the
  // .indd (which stages to template/brand-template.indd), so fonts go here.
  if (kind === 'font') return 'template/Document Fonts/' + name
  return name
}
function mimeOf (name) {
  if (/\.jpe?g$/i.test(name)) return 'image/jpeg'
  if (/\.png$/i.test(name)) return 'image/png'
  if (/\.indd$/i.test(name)) return 'application/x-indesign'
  if (/\.psd$/i.test(name)) return 'image/vnd.adobe.photoshop'
  if (/\.pdf$/i.test(name)) return 'application/pdf'
  if (/\.json$/i.test(name)) return 'application/json'
  if (/\.txt$/i.test(name)) return 'text/plain'
  return 'application/octet-stream'
}
const jobManifestName = '_idapi-job.json'
// Fresh runs normally land in <folder>/output. If that folder already holds assets
// (earlier results), put the run in a datetime-stamped subfolder instead so nothing
// is mixed or overwritten. Chosen once per run and stored on the job, so every batch
// (and a failed-run retry) writes to the same place.
async function resolveOutputFolder (params) {
  const { author, aemToken } = await aemContext(params)
  const base = params.folder + '/output'
  const existing = (await aemListSafe(author, aemToken, base)).filter((e) => e.name !== jobManifestName)
  if (!existing.length) return base
  const stamp = new Date().toISOString().replace(/\.\d+Z$/, '').replace('T', '_').replace(/:/g, '')
  return `${base}/${stamp}`
}
async function writeJobManifest (author, token, folder, manifest) {
  await aemUpload(author, token, manifest.outputFolder || folder + '/output', jobManifestName, Buffer.from(JSON.stringify(manifest, null, 2) + '\n'), 'application/json')
}
function truncateCsv (text, n, offset = 0) {
  // Keep quoted newlines intact; the JSX CSV reader accepts RFC-4180 records.
  const records = csvRecords(String(text || ''))
  return [records[0] || ''].concat(records.slice(1 + offset, 1 + offset + n)).join('\n') + '\n'
}

// ---- InDesign API (OAuth S2S) + input staging ----
async function imsToken (p) {
  const b = new URLSearchParams({ grant_type: 'client_credentials', client_id: p.FFS_CLIENT_ID, client_secret: p.FFS_CLIENT_SECRET, scope: p.FFS_SCOPES || 'openid,AdobeID,firefly_api,ff_apis,indesign_services' })
  const r = await fetch(p.IMS_ENDPOINT || DEFAULT_IMS_ENDPOINT, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: b })
  if (!r.ok) throw new Error(`IMS token ${r.status}`)
  return (await r.json()).access_token
}
// Stage inputs to Adobe I/O Files (storage provisioned with the App Builder app —
// no external Azure/S3 account, no hand-pasted SAS). Each input is written under a
// unique per-run prefix and handed to the InDesign API as a short-lived presigned
// GET URL; `destination` stays prefix-free so the render's working-folder layout
// (template/, Document Fonts/, …) is preserved. Returns { assets, files, prefix }
// so the caller can delete the staged run afterward.
// Kept strictly sequential: generatePresignURL calls the Adobe I/O Token Vending Machine
// over HTTP per file, so concurrent writes/presigns risk TVM throttling or stream memory spikes.
const STALE_STAGING_MS = 2 * 3600 * 1000
async function cleanupStaleStaging (files, now = Date.now(), maxAgeMs = STALE_STAGING_MS) {
  if (!files || typeof files.list !== 'function' || typeof files.delete !== 'function') return 0
  let deleted = 0
  try {
    const entries = (await files.list('idapi-runs/')) || []
    const prefixes = new Set()
    for (const item of entries) {
      const name = String((item && (item.name || item.path)) || item || '').replace(/^\/+/, '')
      const m = /^idapi-runs\/(\d{10,15})-[a-z0-9]+\//i.exec(name)
      if (m && now - Number(m[1]) > maxAgeMs) prefixes.add(m[0])
    }
    for (const p of prefixes) {
      try { await files.delete(p); deleted++ } catch (e) { /* best-effort */ }
    }
  } catch (e) { /* list not supported or failed */ }
  return deleted
}
async function stageInputs (staged) {
  const files = await filesLib.init()
  await cleanupStaleStaging(files)
  const prefix = `idapi-runs/${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const assets = []
  for (const s of staged) {
    const remote = `${prefix}/${s.dest}`
    await files.write(remote, s.buf)
    const url = await files.generatePresignURL(remote, { expiryInSeconds: 3600, permissions: 'r' })
    assets.push({ source: { url }, destination: s.dest })
  }
  return { assets, files, prefix }
}
const idH = (p, tok) => ({ Authorization: `Bearer ${tok}`, 'x-api-key': p.FFS_CLIENT_ID, 'x-gw-ims-org-id': p.FFS_ORG_ID })
async function submitIndesignJob (p, tok, assets, renderParams) {
  const er = await fetch(p.INDESIGN_EXECUTE_URL, { method: 'POST', headers: { ...idH(p, tok), 'Content-Type': 'application/json' }, body: JSON.stringify({ assets, params: renderParams || {} }) })
  const et = await er.text()
  if (er.status !== 202) throw new Error(`execute ${er.status} ${et}`)
  return JSON.parse(et).statusUrl
}
async function indesignRender (p, tok, assets, renderParams, onStatus) {
  const statusUrl = await submitIndesignJob(p, tok, assets, renderParams)
  const { outputs, status } = await indesignPoll(p, tok, statusUrl, onStatus)
  // The script's dataURL file (result.json) comes back in the status response, not as an upload.
  outputs.data = renderData(status)
  outputs.statusKeys = Object.keys(status || {}) // names only, for diagnostics
  return outputs
}
// The script's response data: the status's `data` (object or JSON string), else a per-output `data`.
function renderData (s) {
  const parse = (v) => {
    if (v && typeof v === 'object' && !Array.isArray(v)) return Object.keys(v).length ? v : null
    if (typeof v === 'string' && v.trim().startsWith('{')) { try { return JSON.parse(v) } catch (e) { return null } }
    return null
  }
  if (!s || typeof s !== 'object') return null
  let d = parse(s.data) || parse(s.result && s.result.data)
  if (d) return d
  for (const o of (s.outputs || [])) { d = parse(o && o.data); if (d) return d }
  return null
}
// First string anywhere inside `v` (any depth) that carries a PREFLIGHT: payload.
function findPreflightText (v, depth = 0) {
  if (typeof v === 'string') return v.includes('PREFLIGHT:') ? v : ''
  if (!v || typeof v !== 'object' || depth > 6) return ''
  for (const x of Object.values(v)) { const t = findPreflightText(x, depth + 1); if (t) return t }
  return ''
}
// When the InDesign API pool has been idle for 45+ minutes, Azure CXP scales Windows InDesign Server
// VMs to zero; cold-booting a fresh VM + downloading staged inputs takes 3 to 4.5 minutes in `not_started`.
// Allow up to 360s (90 polls x 4s) while heartbeating `job.updatedAt` in state every ~30s; if it still
// hasn't started at 360s, the worker automatically requeues the batch onto a fresh activation.
const MAX_NOT_STARTED_POLLS = 90
async function indesignPoll (p, tok, statusUrl, onStatus) {
  let lastSt = 'unknown'
  let notStartedPolls = 0
  for (let n = 0; n < 120; n++) {
    await new Promise((r) => setTimeout(r, 4000))
    const s = await (await fetch(statusUrl, { headers: idH(p, tok) })).json()
    const st = (s.status || '').toLowerCase()
    if (st) lastSt = st
    if (['not_started', 'pending', 'queued'].includes(st)) {
      notStartedPolls++
      if (onStatus && (notStartedPolls === 3 || notStartedPolls % 8 === 0)) {
        const elapsedSec = notStartedPolls * 4
        await onStatus(`Waiting for Adobe InDesign API cloud instance to warm up (${elapsedSec}s elapsed)…`)
      }
      if (notStartedPolls >= MAX_NOT_STARTED_POLLS) {
        const err = new Error('Adobe InDesign API did not start the job after 360 seconds (queue status: not_started). The InDesign API service may be experiencing a queue backlog or outage — please try again in a few minutes.')
        err.retryableColdStart = true
        throw err
      }
      continue
    }
    if (onStatus && ['running', 'in_progress', 'processing'].includes(st) && n < 5) {
      await onStatus('Rendering in Adobe InDesign API…')
    }
    if (['succeeded', 'completed', 'success', 'done'].includes(st)) {
      let page = s, out = []
      for (;;) {
        for (const o of (page.outputs || [])) { const u = o.destination && o.destination.url; if (u) out.push({ src: o.source, url: u }) }
        const next = page.paging && page.paging.nextUrl; if (!next) break
        page = await (await fetch(next, { headers: idH(p, tok) })).json()
      }
      return { outputs: out, status: s }
    }
    if (['failed', 'error', 'cancelled'].includes(st)) {
      // The capability's template gate reports its findings as "PREFLIGHT:[...]" somewhere in the errors.
      const findings = sanitizeIndFindings(parsePreflightPayload(findPreflightText(s.errors || s)))
      if (findings.length) { const e = new Error(summarize(findings)); e.findings = findings; throw e }
      throw new Error(`render ${st}: ${JSON.stringify(s.errors || s)}`)
    }
  }
  throw new Error(`render poll timeout (last status: ${lastSt})`)
}
// Remap an output INDD's local image links to AEM URLs (POST /v3/remap-links).
// Returns { buf, warnings }. targetDocument's documented shape is a string; the
// service has also been seen demanding an array, so retry once on that schema error.
async function remapLinks (p, tok, aemToken, files, prefix, name, buf, dataSource) {
  const remote = `${prefix}/remap/${name}`
  await files.write(remote, buf)
  const url = await files.generatePresignURL(remote, { expiryInSeconds: 3600, permissions: 'r' })
  const endpoint = `${new URL(p.INDESIGN_EXECUTE_URL).origin}/v3/remap-links`
  // targetDocument's shape isn't consistently documented: the service has asked for an
  // array (validation error from the job) and, elsewhere, a string. Try array first,
  // then fall back to string if the failure says that's the problem.
  const run = async (targetDocument) => {
    const r = await fetch(endpoint, {
      method: 'POST',
      headers: { ...idH(p, tok), 'x-aem-token': aemToken, 'Content-Type': 'application/json' },
      body: JSON.stringify({ assets: [{ source: { url }, destination: name }], params: { targetDocument, dataSource } })
    })
    const text = await r.text()
    if (r.status !== 202) throw new Error(`remap-links ${r.status} ${text}`)
    return indesignPoll(p, tok, JSON.parse(text).statusUrl)
  }
  let result
  try {
    result = await run([name])
  } catch (e) {
    if (!/targetDocument/i.test(e.message) || !/expected type: String|expected string/i.test(e.message)) throw e
    result = await run(name)
  }
  const { outputs, status } = result
  const out = outputs.find((o) => /\.indd$/i.test(String(o.src || o.url).split('?')[0])) || outputs[0]
  if (!out) throw new Error('remap-links returned no output')
  const warnings = (status.remapWarnings || (status.data && status.data.remapWarnings) || []).map((w) => w.message || JSON.stringify(w))
  return { buf: Buffer.from(await (await fetch(out.url)).arrayBuffer()), warnings }
}

// ---- Photoshop API v2 (PSD templates) ----
const PS_BASE = (p) => String(p.PS_API_BASE || 'https://photoshop-api.adobe.io').replace(/\/+$/, '')
async function psToken (p) {
  const b = new URLSearchParams({ grant_type: 'client_credentials', client_id: p.FFS_CLIENT_ID, client_secret: p.FFS_CLIENT_SECRET, scope: p.PS_SCOPES || 'openid,AdobeID,read_organizations,firefly_api,ff_apis' })
  const r = await fetch(p.IMS_ENDPOINT || DEFAULT_IMS_ENDPOINT, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: b })
  if (!r.ok) throw new Error(`IMS token (Photoshop) ${r.status}`)
  return (await r.json()).access_token
}
const psH = (p, tok) => ({ Authorization: `Bearer ${tok}`, 'x-api-key': p.FFS_CLIENT_ID, 'Content-Type': 'application/json' })
// Submit a v2 job and poll /v2/status until it finishes. Returns the final status body.
// Transient failures (429 rate limits, presigned URL fetch blips, 502/503/504 gateway errors) are retried with backoff.
async function psJob (p, tok, path, body) {
  const transient = /External download failed|\b429\b|\b50[234]\b|rate[_ ]?limit|timeout|temporarily/i
  const isRateLimit = (msg) => /\b429\b|rate[_ ]?limit/i.test(msg)
  for (let attempt = 1; ; attempt++) {
    try {
      return await psJobOnce(p, tok, path, body)
    } catch (e) {
      if (attempt >= 5 || !transient.test(e.message)) throw e
      await sleep((isRateLimit(e.message) ? 12000 : 5000) * attempt)
    }
  }
}
async function psJobOnce (p, tok, path, body) {
  const r = await fetch(PS_BASE(p) + path, { method: 'POST', headers: psH(p, tok), body: JSON.stringify(body) })
  const text = await r.text()
  if (r.status !== 202) throw new Error(`photoshop ${path} ${r.status} ${text.slice(0, 500)}`)
  const statusUrl = JSON.parse(text).statusUrl
  for (let n = 0; n < 120; n++) {
    await sleep(n < 3 ? 2000 : 4000)
    const s = await (await fetch(statusUrl, { headers: psH(p, tok) })).json()
    if (s.status === 'succeeded') return s
    if (s.status === 'failed') throw new Error(`photoshop ${path} failed: ${JSON.stringify(s.errorDetails || s).slice(0, 800)}`)
  }
  throw new Error(`photoshop ${path} poll timeout`)
}
async function psFetchOutput (p, tok, output) {
  const url = (output.destination || output).url
  const res = await fetch(url, { headers: psH(p, tok) })
  if (!res.ok) throw new Error(`photoshop output download -> ${res.status}`)
  return Buffer.from(await res.arrayBuffer())
}

// The click-through column is for the HTML5 ads (the DA sheet keeps it): it fills no frame or layer,
// and the InDesign script's preflight rejects a column that names no Script Label.
function withoutClickthrough (varText, logger) {
  const { text, dropped } = html5.dropClickthroughColumns(varText)
  if (dropped.length) logger.info(`click-through column(s) not sent to the render: ${dropped.join(', ')}`)
  return text
}

// One batch of a PSD job: one create-composite call per CSV row, one JPEG per pagemap artboard.
async function renderPsdBatch ({ params, job, logger, author, aemToken, folder, c, maxRows, rowOffset, writeEditable, writeImages = true }) {
  const staged = []
  staged.push({ dest: destFor('psd'), buf: await aemDownload(author, aemToken, `${folder}/${c.template.name}`) })
  let varText = (await aemDownload(author, aemToken, `${folder}/${c.variations.name}`)).toString('utf8')
  if (maxRows > 0) varText = truncateCsv(varText, maxRows, rowOffset)
  varText = withoutClickthrough(varText, logger)
  const pagemapText = (await aemDownload(author, aemToken, `${folder}/${c.pagemap.name}`)).toString('utf8')
  // Images may sit in subfolders and be referenced by path; stage each under one flat name and
  // point the CSV cells at those names.
  const plan = await planImages(author, aemToken, folder, c, varText)
  varText = rewriteCsvText(varText, plan)
  const rows = psd.rowsFromRecords(csvRecords(varText))
  const aemSource = new Map(plan.resolved.map((r) => [r.staged, r.damPath])) // staged name -> DAM path
  const imageDims = new Map()
  const downloadedImages = await mapConcurrent(aemSource, READ_CONCURRENCY, async ([n, damPath]) => {
    const buf = await aemDownload(author, aemToken, damPath)
    const size = psd.imageSize(buf)
    if (size) imageDims.set(n, size)
    else logger.warn(`psd: could not read size of ${n}; it will be fitted, not cover-filled`)
    return { dest: destFor('image', n), buf }
  })
  staged.push(...downloadedImages)
  const fontSources = [params.AEM_FONTS_PATH || '/content/dam/fonts', folder + '/fonts']
  const fontByName = new Map()
  for (const fp of fontSources) {
    for (const e of await aemListSafe(author, aemToken, fp)) if (!e.isFolder && isFont(e.name)) fontByName.set(e.name, fp + '/' + e.name)
  }
  const downloadedFonts = await mapConcurrent(fontByName, READ_CONCURRENCY, async ([fname, fpath]) => ({
    dest: destFor('font', fname),
    buf: await aemDownload(author, aemToken, fpath)
  }))
  staged.push(...downloadedFonts)
  logger.info(`psd: ${rows.length} row(s), ${aemSource.size} image(s), ${fontByName.size} font(s)`)

  const { assets, files, prefix } = await stageInputs(staged)
  staged.length = 0 // everything is in I/O Files now; free the buffers (the PSD alone is ~60 MB)
  try {
    const urlOf = new Map(assets.map((a) => [a.destination, a.source.url]))
    const tok = await psToken(params)

    // Layer ids come from the manifest (names repeat across artboards).
    const manifestRes = await psJob(params, tok, '/v2/generate-manifest', { image: { source: { url: urlOf.get(destFor('psd')) } }, extractSmartObjectData: true, outputs: [{ destination: { validityPeriod: 3600 }, mediaType: 'application/json' }] })
    const manifest = JSON.parse((await psFetchOutput(params, tok, manifestRes.result.outputs[0])).toString('utf8'))
    // First batch only: template-aware checks, before any render is paid for. Later batches
    // would only repeat them; stage 1 already covered the whole CSV.
    if (rowOffset === 0) {
      const checked = runPsdChecks({ csvText: varText, pagemapText, manifest, stagedFonts: [...fontByName.keys()] })
      for (const f of checked.findings) logger.warn(`preflight ${f.severity} ${f.code}: ${f.message}`)
      if (!checked.ok && params.preflightOverride !== '1') {
        const err = new Error(summarize(checked.findings))
        err.findings = checked.findings
        throw err
      }
    }
    const all = psd.artboardsFromManifest(manifest)
    const { selected, missing } = psd.selectArtboards(all, psd.pagemapNames(csvRecords(pagemapText)))
    if (missing.length) throw new Error(`pagemap lists artboard(s) not found in the PSD: ${missing.join(', ')}`)
    if (!selected.length) throw new Error('no artboards selected: the pagemap names no artboard in the PSD')
    const cols = rows.length ? psd.mapColumns(Object.keys(rows[0]), selected) : { unmatched: [] }
    if (cols.unmatched.length) logger.warn(`psd: CSV column(s) with no matching layer: ${cols.unmatched.join(', ')}`)

    const outFolder = (job && job.outputFolder) || folder + '/output'
    const written = []
    const psdRecords = []
    for (let i = 0; i < rows.length; i++) {
      const body = psd.buildComposite({
        sourceUrl: urlOf.get(destFor('psd')),
        fontUrls: [...fontByName.keys()].map((n) => urlOf.get(destFor('font', n))),
        artboards: selected,
        row: rows[i],
        imageUrl: (name) => urlOf.get(destFor('image', name)),
        imageDims: (name) => imageDims.get(name) || null,
        includePsd: writeEditable,
        includeJpegs: writeImages,
        // Photo-frame aspect of the matching InDesign template (default 1700/688); 0 disables
        heroFrameAspect: params.PSD_HERO_FRAME_ASPECT === undefined || params.PSD_HERO_FRAME_ASPECT === '' ? 1700 / 688 : Number(params.PSD_HERO_FRAME_ASPECT)
      })
      logger.info(`psd: rendering row ${rowOffset + i + 1} (${body.edits.layers.length} edits, ${body.outputs.length} outputs)`)
      const res = await psJob(params, tok, '/v2/create-composite', body)
      const outs = res.result.outputs || []
      for (let k = 0; writeImages && k < selected.length; k++) {
        const name = psd.outputName(selected[k], rows[i], rowOffset + i)
        await aemUpload(author, aemToken, outFolder, name, await psFetchOutput(params, tok, outs[k]), mimeOf(name))
        written.push(name)
      }
      if (writeEditable) {
        // Editable PSD (all artboards) for this row; remember which job-folder images it uses for relations.
        const name = psd.psdOutputName(rows[i], rowOffset + i)
        await aemUpload(author, aemToken, outFolder, name, await psFetchOutput(params, tok, outs[writeImages ? selected.length : 0]), mimeOf(name))
        written.push(name)
        psdRecords.push({ name, imageNames: [...new Set(Object.values(rows[i]).filter(psd.isImageCell).map((v) => String(v).trim().split('/').pop()))] })
      }
    }
    // AEM relations (Assets View shows these): template -> PSD (derived) and PSD <-> its replaced images (other).
    let relationsCreated = 0
    const relationWarnings = []
    if (psdRecords.length) {
      try {
        const ids = new Map()
        const idOf = async (path) => { if (!ids.has(path)) ids.set(path, await assetId(author, aemToken, path)); return ids.get(path) }
        const records = []
        for (const r of psdRecords) records.push({ inddId: await idOf(`${outFolder}/${r.name}`), imageIds: await Promise.all(r.imageNames.filter((n) => aemSource.has(n)).map((n) => idOf(aemSource.get(n)))) })
        const res = await applyPlan(author, aemToken, planRelations(await idOf(`${folder}/${c.template.name}`), records))
        relationsCreated = res.created
        relationWarnings.push(...res.warnings)
      } catch (e) { relationWarnings.push(e.message) }
      if (relationWarnings.length) logger.warn(`relation warnings: ${relationWarnings.join(' | ')}`)
    }
    return { written, varText, fonts: fontByName.size, outFolder, unmatched: cols.unmatched, relationsCreated, relationWarnings }
  } finally {
    try { await files.delete(`${prefix}/`) } catch (e) { logger.warn(`staging cleanup failed: ${e.message}`) }
  }
}

// ---------------------------------------------------------------------------
async function processBatch (params, job, state) {
  const logger = Core.Logger('main', { level: params.LOG_LEVEL || 'info' })
  try {
    logger.debug(stringParameters(params))
    const errorMessage = checkMissingRequestInputs(params, ['folder'], [])
    if (errorMessage) return errorResponse(400, errorMessage, logger)

    // Authenticate to AEM: prefer the durable Service Credential (JWT, minted fresh
    // each run); fall back to a dev token or the caller's token.
    const { author, aemToken } = await aemContext(params)
    const folder = params.folder                        // /content/dam/<...>
    const maxRows = params.maxRows ? Number(params.maxRows) : 0
    const rowOffset = params.rowOffset ? Number(params.rowOffset) : 0

    // 1. read + classify the AEM folder
    logger.info(`reading AEM folder ${folder}`)
    const entries = await aemList(author, aemToken, folder)
    const c = classify(entries, params.template)
    const missing = ['template', 'variations', 'pagemap'].filter((k) => !c[k])
    if (missing.length) return errorResponse(400, missingMessage(missing, params.template), logger)

    if (isPsd(c.template.name)) {
      const r = await renderPsdBatch({ params, job, logger, author, aemToken, folder, c, maxRows, rowOffset, writeEditable: /^(1|true|yes)$/i.test(String(params.writeIndd || '')), writeImages: !/^(1|true|yes)$/i.test(String(params.skipImages || '')) })
      if (state && job) {
        const completed = new Set(job.outputs || [])
        r.written.forEach((name) => completed.add(name))
        job.outputs = Array.from(completed)
        job.lastBatchCount = r.written.length
        await state.put(job.stateKey, JSON.stringify(job), { ttl: 7 * 24 * 3600, ifExists: true })
      }
      return {
        statusCode: 200,
        body: {
          folder, outputFolder: r.outFolder, template: c.template.name, variations: c.variations.name, fonts: r.fonts,
          count: r.written.filter(isDeliverable).length,
          batchRows: Math.max(0, csvRecords(r.varText).length - 1),
          remapWarnings: [], relationsCreated: r.relationsCreated,
          relationWarnings: [...r.relationWarnings, ...(r.unmatched.length ? [`CSV column(s) with no matching layer: ${r.unmatched.join(', ')}`] : [])],
          outputs: r.written
        }
      }
    }

    // 2. pull inputs → buffers, mapped to render destinations
    const staged = []
    const templateBuf = await aemDownload(author, aemToken, folder + '/' + c.template.name)
    staged.push({ dest: destFor('template'), buf: templateBuf })
    let varText = (await aemDownload(author, aemToken, folder + '/' + c.variations.name)).toString('utf8')
    const fullVarText = varText // the HTML5 variations sheet holds every row, with the cells as authored
    if (maxRows > 0) varText = truncateCsv(varText, maxRows, rowOffset)
    varText = withoutClickthrough(varText, logger)
    // HTML5 (DA / Edge Delivery) runs with the first batch only: one design per size, rows bind at view time
    const wantHtml5 = rowOffset === 0 && /^(1|true|yes)$/i.test(String(params.writeHtml5 || ''))
    // HTML5-only run (the HTML5 button): no flattened images. The script exports the HTML5 layers before its row
    // loop, so the render gets a header-only CSV and renders no rows; the batch rows still plan the image sources.
    const flag = (v) => /^(1|true|yes)$/i.test(String(v || ''))
    const html5Only = wantHtml5 && !flag(params.writeIndd) && flag(params.skipImages)
    // swapped images: job-folder images, images in its subfolders (referenced by path or by name), plus
    // those AEM-linked in the template that the CSV references. Each is staged under one flat name and
    // the CSV cells are rewritten to those names.
    const plan = await planImages(author, aemToken, folder, c, varText, { allowBareUnresolved: true })
    varText = rewriteCsvText(varText, plan)
    staged.push({ dest: destFor('variations'), buf: Buffer.from(html5Only ? truncateCsv(varText, 0) : varText, 'utf8') })
    const pagemapBuf = await aemDownload(author, aemToken, folder + '/' + c.pagemap.name)
    // HTML5 runs: a pagemap without an html5 column means every page (the script only exports layers for html5=yes pages).
    staged.push({ dest: destFor('pagemap'), buf: wantHtml5 ? Buffer.from(html5.pagemapAllHtml5(pagemapBuf.toString('utf8')), 'utf8') : pagemapBuf })
    const firstPage = psd.pagemapNames(csvRecords(pagemapBuf.toString('utf8')))[0] || '' // its JPG becomes each .indd's AEM preview
    const { fromLinks } = await resolveImages(author, folder, templateBuf, plan)
    const aemSource = new Map(c.images.map((im) => [im.name, `${folder}/${im.name}`]))
    const fullPlan = fullVarText !== varText
      ? await planImages(author, aemToken, folder, c, withoutClickthrough(fullVarText, logger), { allowBareUnresolved: true })
      : plan
    const subfolderImages = new Map(fullPlan.resolved.filter((r) => !aemSource.has(r.staged)).map((r) => [r.staged, r.damPath]))
    subfolderImages.forEach((damPath, name) => aemSource.set(name, damPath))
    fromLinks.forEach((l) => aemSource.set(l.name, l.damPath))

    // Fast path for HTML5-only runs: when this template's HTML5 pages and slices already exist on the
    // EDS/DA site (from an earlier run or another animation style), reuse their exported geometry and
    // static slices directly and skip calling the InDesign API.
    const setPhase = async (phase) => {
      if (!state || !job || job.phase === phase) return
      job.phase = phase
      job.updatedAt = new Date().toISOString()
      try { await state.put(job.stateKey, JSON.stringify(job), { ttl: 7 * 24 * 3600, ifExists: true }) } catch (e) { /* non-fatal */ }
    }
    let cachedHtml5 = null
    if (html5Only) {
      try {
        const cfg = await html5SiteFor(author, aemToken, folder)
        cachedHtml5 = await reuseHtml5FromSite({
          cfg,
          daToken: params.DA_TOKEN || params.daUserToken || '',
          campaign: folder.split('/').pop(),
          template: c.template.name,
          pagemapText: pagemapBuf.toString('utf8')
        })
        if (cachedHtml5) {
          logger.info(`html5: reusing ${Object.keys(cachedHtml5.manifest).length} page(s) from ${cachedHtml5.fromBase} (skipping InDesign API render)`)
          job && (job.phase = `Reusing existing HTML5 layers (${Object.keys(cachedHtml5.manifest).length} sizes) — publishing to Document Authoring…`)
        }
      } catch (e) { logger.warn(`html5 reuse check failed: ${e.message}`) }
    }

    const outFolder = (job && job.outputFolder) || folder + '/output'
    const written = []
    const remapWarnings = []
    const inddRecords = []   // { name, imageNames } for relations
    const previews = new Map() // variation -> JPG buffer of its first page
    let linkMap = {}
    let gateFindings = []
    let html5Manifest = cachedHtml5 ? cachedHtml5.manifest : null
    let renderDiag = cachedHtml5 ? `reused from ${cachedHtml5.fromBase}` : ''
    const html5Slices = cachedHtml5 ? cachedHtml5.slices : new Map() // '<page>/static-N.png' -> rendered output URL
    let fontCount = 0
    let stagedFiles = null
    let stagedPrefix = ''
    let renditionsCreated = 0
    const renditionWarnings = []
    let relationsCreated = 0
    const relationWarnings = []
    let html5Result

    try {
      if (!cachedHtml5) {
        const allImageTasks = [
          ...c.images.map((im) => [im.name, `${folder}/${im.name}`]),
          ...subfolderImages.entries(),
          ...fromLinks.map((l) => [l.name, l.damPath])
        ]
        // On an HTML5-only run, InDesign renders 0 CSV rows and hides every live CSV-bound image frame
        // while exporting static slices; swapped images are delivered by Dynamic Media URLs in the DA
        // sheet instead. Skipping CSV-swapped images avoids staging and C2PA-relinking 100+ MB of hero PNGs.
        // On multi-batch image/editable runs, only stage CSV-swapped images needed by THIS batch's rows
        // plus any static folder images not referenced in the CSV (e.g. brand lockups / placeholders).
        const allSwappedDamPaths = new Set(fullPlan.resolved.map((r) => r.damPath))
        const batchSwappedDamPaths = new Set(plan.resolved.map((r) => r.damPath))
        const imageTasks = html5Only
          ? allImageTasks.filter(([, damPath]) => !allSwappedDamPaths.has(damPath))
          : allImageTasks.filter(([, damPath]) => !allSwappedDamPaths.has(damPath) || batchSwappedDamPaths.has(damPath))
        staged.push(...(await mapConcurrent(imageTasks, READ_CONCURRENCY, async ([name, damPath]) => ({
          dest: destFor('image', name),
          buf: await aemDownload(author, aemToken, damPath)
        }))))
        logger.info(`swapped images: ${c.images.length} from folder, ${subfolderImages.size} from subfolders, ${fromLinks.length} from template Asset Links (staged ${imageTasks.length})`)

        // 2b. fonts: the render box only has what we ship. Gather from a shared org
        // fonts folder (AEM_FONTS_PATH, default /content/dam/fonts) plus an optional
        // per-job fonts/ subfolder (which overrides shared on name clash), and stage
        // them into the working folder's "Document Fonts/" for auto-activation.
        const fontSources = [params.AEM_FONTS_PATH || '/content/dam/fonts', folder + '/fonts']
        const fontByName = new Map()
        for (const fp of fontSources) {
          for (const e of await aemListSafe(author, aemToken, fp)) {
            if (!e.isFolder && isFont(e.name)) fontByName.set(e.name, fp + '/' + e.name)
          }
        }
        fontCount = fontByName.size
        staged.push(...(await mapConcurrent(fontByName, READ_CONCURRENCY, async ([fname, fpath]) => ({
          dest: destFor('font', fname),
          buf: await aemDownload(author, aemToken, fpath)
        }))))
        logger.info(`fonts bundled: ${fontByName.size} (from ${fontSources.join(', ')})`)

        // 3. stage to Adobe I/O Files → presigned source URLs
        logger.info(`staging ${staged.length} inputs`)
        const { assets, files, prefix } = await stageInputs(staged)
        stagedFiles = files
        stagedPrefix = prefix
        staged.length = 0 // free input buffers once written to Adobe I/O Files

        // 4. render on the InDesign API (auto-registers the capability bundle if INDESIGN_EXECUTE_URL is omitted)
        logger.info('rendering on the InDesign API')
        const idTok = await imsToken(params)
        const executeUrl = await resolveExecuteUrl(params, idTok, state, logger)
        const renderConfig = { ...params, INDESIGN_EXECUTE_URL: executeUrl }
        // writeIndd: also emit an editable .indd per variation (the second modal button)
        const writeIndd = /^(1|true|yes)$/i.test(String(params.writeIndd || ''))
        const skipImages = writeIndd && /^(1|true|yes)$/i.test(String(params.skipImages || ''))
        // the editable option also yields a multi-page PDF of each variation (all sizes) to view in AEM
        // The template checks run once, in the first batch, inside the capability script (needs the re-registered script).
        const gate = rowOffset === 0 ? { preflightGate: '1', ...(params.preflightOverride === '1' ? { preflightOverride: '1' } : {}) } : {}
        const outputs = await indesignRender(renderConfig, idTok, assets, { writeIndd, writePdf: writeIndd, ...gate, ...(wantHtml5 ? { writeHtml5: '1' } : {}) }, setPhase)

        // 5. write outputs back to AEM <folder>/output (unpublished → review)
        logger.info(`writing ${outputs.length} outputs to ${outFolder}`)
        const rj = outputs.find((o) => String(o.src || o.url).split(/[\\/]/).pop().split('?')[0] === 'result.json')
        renderDiag = `no result.json (status keys: ${(outputs.statusKeys || []).join(', ') || 'none'})`
        if (rj || outputs.data) {
          try {
            const resultJson = outputs.data || await (await fetch(rj.url)).json()
            linkMap = resultJson.links || {}
            gateFindings = sanitizeIndFindings(resultJson.preflight && resultJson.preflight.findings)
            html5Manifest = resultJson.html5 || null
            renderDiag = `result.json keys: ${Object.keys(resultJson).join(', ') || 'none'}`
          } catch (e) { logger.warn(`result.json unreadable: ${e.message}`); renderDiag = 'result.json unreadable' }
        }
        // Names only (never the presigned URLs): what the render handed back, for HTML5 failures.
        renderDiag += `; ${outputs.length} output(s): ${outputs.map((o) => String(o.src || o.url).split(/[\\/]/).pop().split('?')[0]).slice(0, 8).join(', ')}`
        logger.info(`render returned ${renderDiag}`)
        for (const f of gateFindings) logger.warn(`preflight ${f.severity} ${f.code}: ${f.message}`)
        for (const o of outputs) {
          const name = String(o.src || o.url).split(/[\\/]/).pop().split('?')[0]
          if (name === 'result.json') continue
          const slice = sliceOf(o.src, o.url)
          if (slice) { html5Slices.set(`${slice.page}/${slice.file}`, o.url); continue } // published by step 5c
          if (job && name !== '_run_log.txt' && (job.outputs || []).includes(name)) continue // the log is rewritten every run
          // Editable-only run: the rendered page images are not delivered. The first page's JPG is still kept in
          // memory as the .indd's AEM preview (see attachPreview below); every other image is skipped unfetched.
          if ((skipImages || html5Only) && /\.(jpe?g|png)$/i.test(name)) {
            const pk = writeIndd && previewKey(name, firstPage)
            if (pk) previews.set(pk, Buffer.from(await (await fetch(o.url)).arrayBuffer()))
            continue
          }
          let buf = Buffer.from(await (await fetch(o.url)).arrayBuffer())
          const pk = previewKey(name, firstPage)
          if (pk) previews.set(pk, buf)
          if (/\.indd$/i.test(name)) {
            // Restore AEM Asset Link references: the render left swapped images linked to
            // local staged copies. A failed remap keeps the unremapped INDD rather than the job.
            // Read the link paths from the INDD itself (authoritative); fall back to the script's record.
            const dataSource = remapSources([...linksFromIndd(buf), ...(linkMap[name] || [])], aemSource, author)
            inddRecords.push({ name, imageNames: [...new Set([...linksFromIndd(buf), ...(linkMap[name] || [])].map((l) => l.name).filter((n) => aemSource.has(n)))] })
            logger.info(`remap ${name}: ${dataSource.length} mapping(s); script recorded ${(linkMap[name] || []).length} link(s)`)
            if (dataSource.length) {
              try {
                const r = await remapLinks(renderConfig, idTok, aemToken, files, prefix, name, buf, dataSource)
                buf = r.buf
                r.warnings.forEach((w) => remapWarnings.push(`${name}: ${w}`))
              } catch (e) {
                logger.warn(`remap-links failed for ${name}: ${e.message}`)
                remapWarnings.push(`${name}: remap failed (${e.message.slice(0, 200)}); INDD keeps local links`)
              }
            } else {
              remapWarnings.push(`${name}: no swapped-image links recorded; INDD keeps local links`)
            }
          }
          await aemUpload(author, aemToken, outFolder, name, buf, mimeOf(name))
          written.push(name)
        }
      }
      // 5a. AEM cannot thumbnail the generated .indd (the InDesign API embeds no page preview), so attach the
      // first page's rendered JPG as its standard renditions. Failures only warn.
      for (const r of inddRecords) {
        const preview = previews.get(r.name.replace(/\.indd$/i, ''))
        if (!preview) { renditionWarnings.push(`${r.name}: no rendered ${firstPage || 'first-page'} image to use as its preview`); continue }
        try {
          const res = await attachPreview(author, aemToken, await assetId(author, aemToken, `${outFolder}/${r.name}`), preview)
          renditionsCreated += res.created
          renditionWarnings.push(...res.warnings.map((w) => `${r.name}: ${w}`))
        } catch (e) { renditionWarnings.push(`${r.name}: ${e.message}`) }
      }
      if (renditionWarnings.length) logger.warn(`rendition warnings: ${renditionWarnings.join(' | ')}`)
      // 5b. AEM relations (Assets View shows these, not the automatic Asset Link references):
      // template -> INDD (derived) and INDD <-> its source images (other). Failures only warn.
      if (inddRecords.length) {
        try {
          const templateId = await assetId(author, aemToken, `${folder}/${c.template.name}`)
          const ids = new Map()
          const idOf = async (path) => { if (!ids.has(path)) ids.set(path, await assetId(author, aemToken, path)); return ids.get(path) }
          const records = []
          for (const r of inddRecords) {
            const pdfName = r.name.replace(/\.indd$/i, '.pdf')
            records.push({
              inddId: await idOf(`${outFolder}/${r.name}`),
              imageIds: await Promise.all(r.imageNames.map((n) => idOf(aemSource.get(n)))),
              // the variation's multi-page PDF, if the render produced one, is derived from the INDD
              derivedIds: written.includes(pdfName) ? [await idOf(`${outFolder}/${pdfName}`)] : []
            })
          }
          const res = await applyPlan(author, aemToken, planRelations(templateId, records))
          relationsCreated = res.created
          relationWarnings.push(...res.warnings)
        } catch (e) {
          relationWarnings.push(e.message)
        }
        if (relationWarnings.length) logger.warn(`relation warnings: ${relationWarnings.join(' | ')}`)
        logger.info(`relations created: ${relationsCreated}`)
      }
      if (remapWarnings.length) logger.warn(`remap warnings: ${remapWarnings.join(' | ')}`)

      // 5c. HTML5: the variations sheet, the static slices (into DA beside each page) and one DA page per
      // size, then an EDS preview. Any JPGs are already written, so every failure only warns.
      if (wantHtml5) {
        try {
          const cfg = await html5SiteFor(author, aemToken, folder)
          const ids = new Map()
          const idOf = async (path) => { if (!ids.has(path)) ids.set(path, await assetId(author, aemToken, path)); return ids.get(path) }
          html5Result = await publishHtml5({
            cfg,
            // DA and EDS calls are made as the signed-in user (daUserToken, passed through by the start
            // action and never stored); DA_TOKEN / EDS_ADMIN_TOKEN override it when configured.
            daToken: params.DA_TOKEN || params.daUserToken || '',
            edsToken: params.EDS_ADMIN_TOKEN || '',
            edsBearer: params.daUserToken || '',
            author,
            aemToken,
            outFolder,
            folder,
            campaign: folder.split('/').pop(),
            template: c.template.name,
            animationStyle: params.animationStyle || (job && job.animationStyle) || html5.DEFAULT_ANIMATION_STYLE,
            manifest: html5Manifest,
            pagemapText: pagemapBuf.toString('utf8'),
            csvText: fullVarText,
            slices: html5Slices,
            imageSource: new Map([...fullPlan.resolved.map((r) => [r.ref, r.damPath]), ...aemSource]),
            state,
            logger,
            deps: {
              upload: (dir, name, buf, mime) => aemUpload(author, aemToken, dir, name, buf, mime),
              assetId: idOf,
              fetchBuf: async (url) => {
                if (!isTrustedSliceUrl(url)) throw new Error(`untrusted slice URL ${url}`)
                const isDaSource = /^https:\/\/admin\.da\.live\//i.test(url)
                const tok = isDaSource ? (params.DA_TOKEN || params.daUserToken || '') : ''
                const res = await fetch(url, tok ? { headers: { Authorization: `Bearer ${tok}` } } : undefined)
                if (!res.ok) throw new Error(`fetch slice ${url} -> ${res.status}`)
                return Buffer.from(await res.arrayBuffer())
              }
            }
          })
          logger.info(`html5: ${html5Result.pages.length} page(s) previewed, ${html5Result.warnings.length} warning(s)`)
          // No HTML5 section in the render's result: say what did come back, so the job error is actionable.
          if (!html5Manifest || !Object.keys(html5Manifest).length) {
            for (const w of html5Result.warnings) if (w.code === 'HTML5_NO_PAGES') w.message += ` [${renderDiag}]`
          }
        } catch (e) {
          html5Result = { pages: [], warnings: [{ code: e.code || 'HTML5_DA_ERROR', message: e.message }] }
          logger.warn(`html5 publish failed: ${e.message}`)
        }
      }
    } finally {
      // 6. always tidy up staged inputs in Adobe I/O Files, even when rendering or upload throws.
      if (stagedFiles && stagedPrefix) {
        try { await stagedFiles.delete(`${stagedPrefix}/`) } catch (e) { logger.warn(`staging cleanup failed: ${e.message}`) }
      }
    }

    if (state && job) {
      const completed = new Set(job.outputs || [])
      written.forEach((name) => completed.add(name))
      job.outputs = Array.from(completed)
      job.lastBatchCount = written.length
      if (gateFindings.length) {
        // keep stage-1 findings and add the template ones (overridden errors + warnings); errors first
        const merged = [...(job.findings || []), ...gateFindings.filter((f) => !(job.findings || []).some((o) => o.code === f.code && o.message === f.message))]
        job.findings = [...merged.filter((f) => f.severity === 'error'), ...merged.filter((f) => f.severity !== 'error')].slice(0, MAX_STORED_FINDINGS)
      }
      await state.put(job.stateKey, JSON.stringify(job), { ttl: 7 * 24 * 3600, ifExists: true })
    }

    return {
      statusCode: 200,
      body: {
        folder,
        outputFolder: outFolder,
        template: c.template.name,
        variations: c.variations.name,
        fonts: fontCount,
        count: written.filter(isDeliverable).length,
        // an HTML5-only run is one batch: 0 rows tells the worker the job is done
        batchRows: html5Only ? 0 : Math.max(0, csvRecords(varText).length - 1),   // records, not lines: quoted cells may contain line breaks (cardname)
        remapWarnings,
        relationsCreated,
        relationWarnings,
        renditionsCreated,
        renditionWarnings,
        ...(html5Result ? { html5: html5Result } : {}),
        outputs: written
      }
    }
  } catch (error) {
    logger.error(error)
    // Template checks fail the job before any render; keep their findings for the status action.
    if (error.findings && state && job) {
      job.findings = error.findings.slice(0, MAX_STORED_FINDINGS)
      try { await state.put(job.stateKey, JSON.stringify(job), { ttl: 7 * 24 * 3600, ifExists: true }) } catch (e) { logger.warn(`could not store findings: ${e.message}`) }
    }
    return errorResponse(500, `generation failed: ${error.message}`, logger)
  }
}

// AEM infers "derived" relations from a file's XMP after upload; a generated PDF's XMP points at the template
// the INDD was saved from, so a little after upload AEM relates each PDF to the *template* and drops the
// INDD -> PDF relation we created straight after the upload. Once a job has finished, put it back.
// Returns { fixed, warnings }.
async function finalizeRelations (author, token, outFolder, outputs) {
  const pdfs = outputs.filter((n) => /\.pdf$/i.test(n) && outputs.includes(n.replace(/\.pdf$/i, '.indd')))
  const warnings = []
  let fixed = 0
  if (!pdfs.length) return { fixed, warnings }
  for (const wait of [30000, 20000]) {
    await sleep(wait)
    const plan = []
    for (const pdf of pdfs) {
      try {
        const inddId = await assetId(author, token, `${outFolder}/${pdf.replace(/\.pdf$/i, '.indd')}`)
        const pdfId = await assetId(author, token, `${outFolder}/${pdf}`)
        const res = await fetch(`${author}/adobe/assets/${inddId}/relations`, { headers: { Authorization: `Bearer ${token}` } })
        const items = res.ok ? (await res.json()).items || [] : []
        if (!items.some((i) => i.assetId === pdfId && i.relationType === 'derived')) plan.push({ onId: inddId, items: [{ assetId: pdfId, relationType: 'derived' }] })
      } catch (e) { warnings.push(`${pdf}: ${e.message}`) }
    }
    if (!plan.length) break
    const r = await applyPlan(author, token, plan)
    fixed += r.created
    warnings.push(...r.warnings)
  }
  return { fixed, warnings }
}

exports.finalizeRelations = finalizeRelations
exports.processBatch = processBatch
exports.inspectInputs = inspectInputs
exports.resolveOutputFolder = resolveOutputFolder
exports.aemContext = aemContext
exports.aemAuthor = aemAuthor
exports.isAllowedAemAuthor = isAllowedAemAuthor
exports.hasDurableAemAuth = hasDurableAemAuth
exports.isTrustedSliceUrl = isTrustedSliceUrl
exports.fetchWithRetry = fetchWithRetry
exports.cleanupStaleStaging = cleanupStaleStaging
exports.hasFolderAccess = hasFolderAccess
exports.html5SiteFor = html5SiteFor
exports.html5SiteLookup = html5SiteLookup
exports.html5JsonFolders = html5JsonFolders
exports.ensureFolder = ensureFolder
exports.aemUpload = aemUpload
exports.aemDownload = aemDownload
exports.writeJobManifest = writeJobManifest
exports.jobManifestName = jobManifestName
exports.aemListSafe = aemListSafe
exports.verifyAemAsset = verifyAemAsset
exports.aemApiPath = aemApiPath
exports.renderData = renderData
