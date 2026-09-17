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
  const res = await fetch(aemApiPath(author, damPath), { headers: { Authorization: `Bearer ${token}` } })
  if (!res.ok) throw new Error(`AEM list ${damPath} -> ${res.status}`)
  const j = await res.json()
  return (j.entities || []).map((e) => ({
    name: e.properties && e.properties.name,
    isFolder: (e.class || []).join(',').includes('folder')
  }))
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
async function aemUpload (author, token, folderDamPath, name, buf, mime) {
  const ir = await fetch(`${author}${folderDamPath}.initiateUpload.json`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ fileName: name, fileSize: String(buf.length) })
  })
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
}

// ---- classification (folder-as-key contract) ----
const isFont = (n) => /\.(otf|ttf|ttc|woff2?|dfont)$/i.test(n)
function classify (entries) {
  const assets = entries.filter((e) => !e.isFolder)
  const isCsv = (n) => /\.csv$/i.test(n)
  const isImg = (n) => /\.(jpe?g|png)$/i.test(n)
  const template = assets.find((e) => /template/i.test(e.name) && /\.indd$/i.test(e.name))
  const pagemap = assets.find((e) => /pagemap/i.test(e.name) && isCsv(e.name))
  const variations = assets.find((e) => isCsv(e.name) && e !== pagemap && !/pagemap/i.test(e.name))
  const images = assets.filter((e) => isImg(e.name))
  return { template, variations, pagemap, images }
}
function destFor (kind, name) {
  if (kind === 'template') return 'template/brand-template.indd'
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
  if (/\.json$/i.test(name)) return 'application/json'
  if (/\.txt$/i.test(name)) return 'text/plain'
  return 'application/octet-stream'
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
  const statusUrl = JSON.parse(et).statusUrl
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
      return out
    }
    if (['failed', 'error', 'cancelled'].includes(st)) throw new Error(`render ${st}: ${JSON.stringify(s.errors || s)}`)
  }
  throw new Error('render poll timeout')
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
    let aemToken
    if (params.AEM_SC_JSON) aemToken = await aemTokenFromServiceCredential(params.AEM_SC_JSON)
    else aemToken = params.AEM_DEV_TOKEN || getBearerToken(params)
    if (!aemToken) return errorResponse(401, 'no AEM token', logger)
    const discoveredAuthor = String(params.aemAuthorUrl || '').replace(/\/+$/, '')
    if (discoveredAuthor && !/^https:\/\/author-[a-z0-9-]+\.adobeaemcloud\.com$/i.test(discoveredAuthor)) {
      return errorResponse(400, 'aemAuthorUrl must be an AEM Cloud author URL', logger)
    }
    const author = discoveredAuthor || String(params.AEM_AUTHOR_URL || '').replace(/\/+$/, '')
    if (!author) return errorResponse(500, 'AEM_AUTHOR_URL is not configured for this deployment', logger)
    if (!/^https:\/\//i.test(author)) return errorResponse(500, 'AEM_AUTHOR_URL must be an https URL', logger)
    const folder = params.folder                        // /content/dam/<...>
    const maxRows = params.maxRows ? Number(params.maxRows) : 0
    const rowOffset = params.rowOffset ? Number(params.rowOffset) : 0

    // 1. read + classify the AEM folder
    logger.info(`reading AEM folder ${folder}`)
    const entries = await aemList(author, aemToken, folder)
    const c = classify(entries)
    const missing = ['template', 'variations', 'pagemap'].filter((k) => !c[k]).concat(c.images.length ? [] : ['images'])
    if (missing.length) return errorResponse(400, `folder is missing required input(s): ${missing.join(', ')}`, logger)

    // 2. pull inputs → buffers, mapped to render destinations
    const staged = []
    staged.push({ dest: destFor('template'), buf: await aemDownload(author, aemToken, folder + '/' + c.template.name) })
    let varText = (await aemDownload(author, aemToken, folder + '/' + c.variations.name)).toString('utf8')
    if (maxRows > 0) varText = truncateCsv(varText, maxRows, rowOffset)
    staged.push({ dest: destFor('variations'), buf: Buffer.from(varText, 'utf8') })
    staged.push({ dest: destFor('pagemap'), buf: await aemDownload(author, aemToken, folder + '/' + c.pagemap.name) })
    for (const im of c.images) staged.push({ dest: destFor('image', im.name), buf: await aemDownload(author, aemToken, folder + '/' + im.name) })

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
    const outFolder = folder + '/output'
    logger.info(`writing ${outputs.length} outputs to ${outFolder}`)
    const written = []
    for (const o of outputs) {
      const name = String(o.src || o.url).split(/[\\/]/).pop().split('?')[0]
      if (name === 'result.json') continue
      if (job && (job.outputs || []).includes(name)) continue
      const buf = Buffer.from(await (await fetch(o.url)).arrayBuffer())
      await aemUpload(author, aemToken, outFolder, name, buf, mimeOf(name))
      written.push(name)
      if (state && job) {
        job.outputs = Array.from(new Set([...(job.outputs || []), name]))
        await state.put(job.stateKey, JSON.stringify(job), { ttl: 7 * 24 * 3600, ifExists: true })
      }
    }

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
        count: written.length,
        batchRows: varText.trim() ? Math.max(0, varText.trim().split(/\r?\n/).length - 1) : 0,
        outputs: written
      }
    }
  } catch (error) {
    logger.error(error)
    return errorResponse(500, `generation failed: ${error.message}`, logger)
  }
}

exports.processBatch = processBatch
