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
const { isDeliverable } = require('../job-utils')
const { remapSources, linksFromIndd } = require('./remap')
const { damLinksFromTemplate, resolveSwappedImages } = require('./links')
const psd = require('./psd')
const images = require('./images')
const { classify } = require('./classify')
const { errorResponse, getBearerToken, stringParameters, checkMissingRequestInputs } = require('../utils')

// Mint a fresh AEM token from an AEM Service Credential (JWT flow). The whole
// credential JSON is passed base64-encoded via AEM_SC_JSON. Durable: no manual tokens.
const b64url = (x) => Buffer.from(x).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
async function aemTokenFromServiceCredential (scB64) {
  const sc = JSON.parse(Buffer.from(scB64, 'base64').toString('utf8')).integration
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

// ---- AEM Assets helpers (use the caller's IMS token) ----
function aemApiPath (author, damPath) {
  const rel = damPath.replace(/^\/content\/dam/, '').replace(/^\//, '')
  return `${author}/api/assets/${rel}.json`
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
  const initiate = () => fetch(`${author}${folderDamPath.split('/').map(encodeURIComponent).join('/')}.initiateUpload.json`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ fileName: name, fileSize: String(buf.length) })
  })
  let ir = await initiate()
  if (ir.status === 404) { await ensureFolder(author, token, folderDamPath); ir = await initiate() }
  if (!ir.ok) throw new Error(`initiateUpload ${name} -> ${ir.status}`)
  const f = (JSON.parse((await ir.text()).replace(/^\)\]\}'?/, '')).files || [])[0]
  if (!f || !f.uploadURIs || !f.uploadURIs.length) throw new Error(`initiateUpload ${name}: no upload URI`)
  const uris = f.uploadURIs, partSize = Math.ceil(buf.length / uris.length)
  for (let i = 0; i < uris.length; i++) {
    const part = buf.subarray(i * partSize, Math.min((i + 1) * partSize, buf.length))
    const pr = await fetch(uris[i], { method: 'PUT', body: part })
    if (!(pr.status === 201 || pr.ok)) throw new Error(`upload PUT ${name} part ${i} -> ${pr.status}`)
  }
  const cr = await fetch(`${author}${folderDamPath}.completeUpload.json`, {
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
function csvRecords (text) {
  const records = []
  let record = ''
  let quoted = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    record += ch
    if (ch === '"') quoted = text[i + 1] === '"' ? quoted : !quoted
    if ((ch === '\n' || (ch === '\r' && text[i + 1] !== '\n')) && !quoted) {
      if (record.replace(/\r?\n$/, '').trim()) records.push(record.replace(/\r?\n$/, ''))
      record = ''
    }
  }
  if (record.trim()) records.push(record)
  return records
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
async function aemContext (params) {
  let aemToken
  if (params.AEM_SC_JSON) aemToken = await aemTokenFromServiceCredential(params.AEM_SC_JSON)
  else aemToken = params.AEM_DEV_TOKEN || getBearerToken(params)
  if (!aemToken) throw new Error('no AEM token')
  const discoveredAuthor = String(params.aemAuthorUrl || '').replace(/\/+$/, '')
  if (discoveredAuthor && !/^https:\/\/author-[a-z0-9-]+\.adobeaemcloud\.com$/i.test(discoveredAuthor)) {
    throw new Error('aemAuthorUrl must be an AEM Cloud author URL')
  }
  const author = discoveredAuthor || String(params.AEM_AUTHOR_URL || '').replace(/\/+$/, '')
  if (!author) throw new Error('AEM_AUTHOR_URL is not configured for this deployment')
  if (!/^https:\/\//i.test(author)) throw new Error('AEM_AUTHOR_URL must be an https URL')
  return { author, aemToken }
}
async function inspectInputs (params) {
  const { author, aemToken } = await aemContext(params)
  const entries = await aemList(author, aemToken, params.folder)
  const c = classify(entries, params.template)
  const missing = ['template', 'variations', 'pagemap'].filter((k) => !c[k])
  if (missing.length) throw new Error(missingMessage(missing, params.template))
  const templateBuf = await aemDownload(author, aemToken, `${params.folder}/${c.template.name}`)
  const variationsText = (await aemDownload(author, aemToken, `${params.folder}/${c.variations.name}`)).toString('utf8')
  const pagemapText = (await aemDownload(author, aemToken, `${params.folder}/${c.pagemap.name}`)).toString('utf8')
  if (isPsd(c.template.name)) {
    // PSD layers are filled from images in the job folder (or its subfolders) only (no Asset Links).
    await planImages(author, aemToken, params.folder, c, variationsText)
  } else {
    await resolveImages(author, params.folder, templateBuf, await planImages(author, aemToken, params.folder, c, variationsText, { allowBareUnresolved: true }))
  }
  const variationRows = Math.max(0, csvRecords(variationsText).length - 1)
  const pageCount = Math.max(0, csvRecords(pagemapText).length - 1)
  return { variationRows, pageCount, template: c.template.name, variations: c.variations.name, pagemap: c.pagemap.name }
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
  const records = []
  let record = ''
  let quoted = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    record += ch
    if (ch === '"') quoted = text[i + 1] === '"' ? quoted : !quoted
    if ((ch === '\n' || (ch === '\r' && text[i + 1] !== '\n')) && !quoted) {
      records.push(record.replace(/\r?\n$/, ''))
      record = ''
    }
  }
  if (record.trim()) records.push(record)
  return [records[0] || ''].concat(records.slice(1 + offset, 1 + offset + n)).join('\n') + '\n'
}

// ---- InDesign API (OAuth S2S) + input staging ----
async function imsToken (p) {
  const b = new URLSearchParams({ grant_type: 'client_credentials', client_id: p.FFS_CLIENT_ID, client_secret: p.FFS_CLIENT_SECRET, scope: p.FFS_SCOPES || 'openid,AdobeID,firefly_api,ff_apis,indesign_services' })
  const r = await fetch(p.IMS_ENDPOINT, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: b })
  if (!r.ok) throw new Error(`IMS token ${r.status}`)
  return (await r.json()).access_token
}
// Stage inputs to Adobe I/O Files (storage provisioned with the App Builder app —
// no external Azure/S3 account, no hand-pasted SAS). Each input is written under a
// unique per-run prefix and handed to the InDesign API as a short-lived presigned
// GET URL; `destination` stays prefix-free so the render's working-folder layout
// (template/, Document Fonts/, …) is preserved. Returns { assets, files, prefix }
// so the caller can delete the staged run afterward.
async function stageInputs (staged) {
  const files = await filesLib.init()
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
async function indesignRender (p, tok, assets, renderParams) {
  const er = await fetch(p.INDESIGN_EXECUTE_URL, { method: 'POST', headers: { ...idH(p, tok), 'Content-Type': 'application/json' }, body: JSON.stringify({ assets, params: renderParams || {} }) })
  const et = await er.text()
  if (er.status !== 202) throw new Error(`execute ${er.status} ${et}`)
  return (await indesignPoll(p, tok, JSON.parse(et).statusUrl)).outputs
}
async function indesignPoll (p, tok, statusUrl) {
  for (let n = 0; n < 200; n++) {
    await new Promise((r) => setTimeout(r, 4000))
    const s = await (await fetch(statusUrl, { headers: idH(p, tok) })).json()
    const st = (s.status || '').toLowerCase()
    if (['succeeded', 'completed', 'success', 'done'].includes(st)) {
      let page = s, out = []
      for (;;) {
        for (const o of (page.outputs || [])) { const u = o.destination && o.destination.url; if (u) out.push({ src: o.source, url: u }) }
        const next = page.paging && page.paging.nextUrl; if (!next) break
        page = await (await fetch(next, { headers: idH(p, tok) })).json()
      }
      return { outputs: out, status: s }
    }
    if (['failed', 'error', 'cancelled'].includes(st)) throw new Error(`render ${st}: ${JSON.stringify(s.errors || s)}`)
  }
  throw new Error('render poll timeout')
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
  const r = await fetch(p.IMS_ENDPOINT, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: b })
  if (!r.ok) throw new Error(`IMS token (Photoshop) ${r.status}`)
  return (await r.json()).access_token
}
const psH = (p, tok) => ({ Authorization: `Bearer ${tok}`, 'x-api-key': p.FFS_CLIENT_ID, 'Content-Type': 'application/json' })
// Submit a v2 job and poll /v2/status until it finishes. Returns the final status body.
// Transient failures (the service fetching one of our presigned URLs, gateway blips) are retried.
async function psJob (p, tok, path, body) {
  const transient = /External download failed|\b50[234]\b|timeout|temporarily/i
  for (let attempt = 1; ; attempt++) {
    try {
      return await psJobOnce(p, tok, path, body)
    } catch (e) {
      if (attempt >= 3 || !transient.test(e.message)) throw e
      await sleep(5000 * attempt)
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

// One batch of a PSD job: one create-composite call per CSV row, one JPEG per pagemap artboard.
async function renderPsdBatch ({ params, job, state, logger, author, aemToken, folder, c, maxRows, rowOffset, writeEditable }) {
  const staged = []
  staged.push({ dest: destFor('psd'), buf: await aemDownload(author, aemToken, `${folder}/${c.template.name}`) })
  let varText = (await aemDownload(author, aemToken, `${folder}/${c.variations.name}`)).toString('utf8')
  if (maxRows > 0) varText = truncateCsv(varText, maxRows, rowOffset)
  const pagemapText = (await aemDownload(author, aemToken, `${folder}/${c.pagemap.name}`)).toString('utf8')
  // Images may sit in subfolders and be referenced by path; stage each under one flat name and
  // point the CSV cells at those names.
  const plan = await planImages(author, aemToken, folder, c, varText)
  varText = rewriteCsvText(varText, plan)
  const rows = psd.rowsFromRecords(csvRecords(varText))
  const aemSource = new Map(plan.resolved.map((r) => [r.staged, r.damPath])) // staged name -> DAM path
  const imageDims = new Map()
  for (const [n, damPath] of aemSource) {
    const buf = await aemDownload(author, aemToken, damPath)
    const size = psd.imageSize(buf)
    if (size) imageDims.set(n, size)
    else logger.warn(`psd: could not read size of ${n}; it will be fitted, not cover-filled`)
    staged.push({ dest: destFor('image', n), buf })
  }
  const fontSources = [params.AEM_FONTS_PATH || '/content/dam/fonts', folder + '/fonts']
  const fontByName = new Map()
  for (const fp of fontSources) {
    for (const e of await aemListSafe(author, aemToken, fp)) if (!e.isFolder && isFont(e.name)) fontByName.set(e.name, fp + '/' + e.name)
  }
  for (const [fname, fpath] of fontByName) staged.push({ dest: destFor('font', fname), buf: await aemDownload(author, aemToken, fpath) })
  logger.info(`psd: ${rows.length} row(s), ${aemSource.size} image(s), ${fontByName.size} font(s)`)

  const { assets, files, prefix } = await stageInputs(staged)
  staged.length = 0 // everything is in I/O Files now; free the buffers (the PSD alone is ~60 MB)
  const urlOf = new Map(assets.map((a) => [a.destination, a.source.url]))
  const tok = await psToken(params)

  // Layer ids come from the manifest (names repeat across artboards).
  const manifestRes = await psJob(params, tok, '/v2/generate-manifest', { image: { source: { url: urlOf.get(destFor('psd')) } }, extractSmartObjectData: true, outputs: [{ destination: { validityPeriod: 3600 }, mediaType: 'application/json' }] })
  const manifest = JSON.parse((await psFetchOutput(params, tok, manifestRes.result.outputs[0])).toString('utf8'))
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
      // Photo-frame aspect of the matching InDesign template (default 1700/688); 0 disables
      heroFrameAspect: params.PSD_HERO_FRAME_ASPECT === undefined || params.PSD_HERO_FRAME_ASPECT === '' ? 1700 / 688 : Number(params.PSD_HERO_FRAME_ASPECT)
    })
    logger.info(`psd: rendering row ${rowOffset + i + 1} (${body.edits.layers.length} edits, ${body.outputs.length} outputs)`)
    const res = await psJob(params, tok, '/v2/create-composite', body)
    const outs = res.result.outputs || []
    for (let k = 0; k < selected.length; k++) {
      const name = psd.outputName(selected[k], rows[i], rowOffset + i)
      await aemUpload(author, aemToken, outFolder, name, await psFetchOutput(params, tok, outs[k]), mimeOf(name))
      written.push(name)
    }
    if (writeEditable) {
      // Editable PSD (all artboards) for this row; remember which job-folder images it uses for relations.
      const name = psd.psdOutputName(rows[i], rowOffset + i)
      await aemUpload(author, aemToken, outFolder, name, await psFetchOutput(params, tok, outs[selected.length]), mimeOf(name))
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
  try { await files.delete(`${prefix}/`) } catch (e) { logger.warn(`staging cleanup failed: ${e.message}`) }
  return { written, varText, fonts: fontByName.size, outFolder, unmatched: cols.unmatched, relationsCreated, relationWarnings }
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
      const r = await renderPsdBatch({ params, job, state, logger, author, aemToken, folder, c, maxRows, rowOffset, writeEditable: /^(1|true|yes)$/i.test(String(params.writeIndd || '')) })
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
    if (maxRows > 0) varText = truncateCsv(varText, maxRows, rowOffset)
    // swapped images: job-folder images, images in its subfolders (referenced by path or by name), plus
    // those AEM-linked in the template that the CSV references. Each is staged under one flat name and
    // the CSV cells are rewritten to those names.
    const plan = await planImages(author, aemToken, folder, c, varText, { allowBareUnresolved: true })
    varText = rewriteCsvText(varText, plan)
    staged.push({ dest: destFor('variations'), buf: Buffer.from(varText, 'utf8') })
    staged.push({ dest: destFor('pagemap'), buf: await aemDownload(author, aemToken, folder + '/' + c.pagemap.name) })
    const { fromLinks } = await resolveImages(author, folder, templateBuf, plan)
    const aemSource = new Map(c.images.map((im) => [im.name, `${folder}/${im.name}`]))
    const subfolderImages = new Map(plan.resolved.filter((r) => !aemSource.has(r.staged)).map((r) => [r.staged, r.damPath]))
    subfolderImages.forEach((damPath, name) => aemSource.set(name, damPath))
    fromLinks.forEach((l) => aemSource.set(l.name, l.damPath))
    for (const im of c.images) staged.push({ dest: destFor('image', im.name), buf: await aemDownload(author, aemToken, folder + '/' + im.name) })
    for (const [name, damPath] of subfolderImages) staged.push({ dest: destFor('image', name), buf: await aemDownload(author, aemToken, damPath) })
    for (const l of fromLinks) staged.push({ dest: destFor('image', l.name), buf: await aemDownload(author, aemToken, l.damPath) })
    logger.info(`swapped images: ${c.images.length} from folder, ${subfolderImages.size} from subfolders, ${fromLinks.length} from template Asset Links`)

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
    for (const [fname, fpath] of fontByName) {
      staged.push({ dest: destFor('font', fname), buf: await aemDownload(author, aemToken, fpath) })
    }
    logger.info(`fonts bundled: ${fontByName.size} (from ${fontSources.join(', ')})`)

    // 3. stage to Adobe I/O Files → presigned source URLs
    logger.info(`staging ${staged.length} inputs`)
    const { assets, files, prefix } = await stageInputs(staged)

    // 4. render on the InDesign API
    logger.info('rendering on the InDesign API')
    const idTok = await imsToken(params)
    // writeIndd: also emit an editable .indd per variation (the second modal button)
    const writeIndd = /^(1|true|yes)$/i.test(String(params.writeIndd || ''))
    const outputs = await indesignRender(params, idTok, assets, { writeIndd })

    // 5. write outputs back to AEM <folder>/output (unpublished → review)
    const outFolder = (job && job.outputFolder) || folder + '/output'
    logger.info(`writing ${outputs.length} outputs to ${outFolder}`)
    const written = []
    const remapWarnings = []
    const inddRecords = []   // { name, imageNames } for relations
    // result.json (from the script) records each saved INDD's local image links.
    let linkMap = {}
    const rj = outputs.find((o) => String(o.src || o.url).split(/[\\/]/).pop().split('?')[0] === 'result.json')
    if (rj) { try { linkMap = (await (await fetch(rj.url)).json()).links || {} } catch (e) { logger.warn(`result.json unreadable: ${e.message}`) } }
    for (const o of outputs) {
      const name = String(o.src || o.url).split(/[\\/]/).pop().split('?')[0]
      if (name === 'result.json') continue
      if (job && (job.outputs || []).includes(name)) continue
      let buf = Buffer.from(await (await fetch(o.url)).arrayBuffer())
      if (/\.indd$/i.test(name)) {
        // Restore AEM Asset Link references: the render left swapped images linked to
        // local staged copies. A failed remap keeps the unremapped INDD rather than the job.
        // Read the link paths from the INDD itself (authoritative); fall back to the script's record.
        const dataSource = remapSources([...linksFromIndd(buf), ...(linkMap[name] || [])], aemSource, author)
        inddRecords.push({ name, imageNames: [...new Set([...linksFromIndd(buf), ...(linkMap[name] || [])].map((l) => l.name).filter((n) => aemSource.has(n)))] })
        logger.info(`remap ${name}: ${dataSource.length} mapping(s); script recorded ${(linkMap[name] || []).length} link(s)`)
        if (dataSource.length) {
          try {
            const r = await remapLinks(params, idTok, aemToken, files, prefix, name, buf, dataSource)
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
    // 5b. AEM relations (Assets View shows these, not the automatic Asset Link references):
    // template -> INDD (derived) and INDD <-> its source images (other). Failures only warn.
    let relationsCreated = 0
    const relationWarnings = []
    if (inddRecords.length) {
      try {
        const templateId = await assetId(author, aemToken, `${folder}/${c.template.name}`)
        const ids = new Map()
        const idOf = async (path) => { if (!ids.has(path)) ids.set(path, await assetId(author, aemToken, path)); return ids.get(path) }
        const records = []
        for (const r of inddRecords) {
          records.push({ inddId: await idOf(`${outFolder}/${r.name}`), imageIds: await Promise.all(r.imageNames.map((n) => idOf(aemSource.get(n)))) })
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

    // 6. tidy up the staged inputs — the render is done and outputs are in AEM.
    try { await files.delete(`${prefix}/`) } catch (e) { logger.warn(`staging cleanup failed: ${e.message}`) }

    if (state && job) {
      const completed = new Set(job.outputs || [])
      written.forEach((name) => completed.add(name))
      job.outputs = Array.from(completed)
      job.lastBatchCount = written.length
      await state.put(job.stateKey, JSON.stringify(job), { ttl: 7 * 24 * 3600, ifExists: true })
    }

    return {
      statusCode: 200,
      body: {
        folder,
        outputFolder: outFolder,
        template: c.template.name,
        variations: c.variations.name,
        fonts: fontByName.size,
        count: written.filter(isDeliverable).length,
        batchRows: Math.max(0, csvRecords(varText).length - 1),   // records, not lines: quoted cells may contain line breaks (cardname)
        remapWarnings,
        relationsCreated,
        relationWarnings,
        outputs: written
      }
    }
  } catch (error) {
    logger.error(error)
    return errorResponse(500, `generation failed: ${error.message}`, logger)
  }
}

exports.processBatch = processBatch
exports.inspectInputs = inspectInputs
exports.resolveOutputFolder = resolveOutputFolder
exports.aemContext = aemContext
exports.ensureFolder = ensureFolder
exports.aemUpload = aemUpload
exports.aemDownload = aemDownload
exports.writeJobManifest = writeJobManifest
exports.jobManifestName = jobManifestName
