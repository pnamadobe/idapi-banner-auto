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
const { isDeliverable } = require('../job-utils')
const { remapSources, linksFromIndd } = require('./remap')
const { damLinksFromTemplate, csvImageRefs, resolveSwappedImages } = require('./links')
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
  await verifyAemAsset(author, token, `${folderDamPath}/${name}`)
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
// Swapped images may live in the job folder OR be AEM-linked (Asset Link) in the
// template; fetch whatever the CSV rows reference. Throws if any can't be found.
async function resolveImages (author, folder, c, templateBuf, csvText) {
  const { host } = new URL(author)
  const { fromLinks, unresolved } = resolveSwappedImages(
    csvImageRefs(csvRecords(csvText)), c.images.map((i) => i.name), damLinksFromTemplate(templateBuf), host)
  if (unresolved.length) throw new Error(`image(s) referenced by the CSV were not found in ${folder} or the template's AEM links: ${unresolved.join(', ')}`)
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
  const c = classify(entries)
  const missing = ['template', 'variations', 'pagemap'].filter((k) => !c[k])
  if (missing.length) throw new Error(`folder is missing required input(s): ${missing.join(', ')}`)
  const templateBuf = await aemDownload(author, aemToken, `${params.folder}/${c.template.name}`)
  const variationsText = (await aemDownload(author, aemToken, `${params.folder}/${c.variations.name}`)).toString('utf8')
  const pagemapText = (await aemDownload(author, aemToken, `${params.folder}/${c.pagemap.name}`)).toString('utf8')
  await resolveImages(author, params.folder, c, templateBuf, variationsText)
  const variationRows = Math.max(0, csvRecords(variationsText).length - 1)
  const pageCount = Math.max(0, csvRecords(pagemapText).length - 1)
  return { variationRows, pageCount, template: c.template.name, variations: c.variations.name, pagemap: c.pagemap.name }
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
const jobManifestName = '_idapi-job.json'
async function writeJobManifest (author, token, folder, manifest) {
  await aemUpload(author, token, folder + '/output', jobManifestName, Buffer.from(JSON.stringify(manifest, null, 2) + '\n'), 'application/json')
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
    const c = classify(entries)
    const missing = ['template', 'variations', 'pagemap'].filter((k) => !c[k])
    if (missing.length) return errorResponse(400, `folder is missing required input(s): ${missing.join(', ')}`, logger)

    // 2. pull inputs → buffers, mapped to render destinations
    const staged = []
    const templateBuf = await aemDownload(author, aemToken, folder + '/' + c.template.name)
    staged.push({ dest: destFor('template'), buf: templateBuf })
    let varText = (await aemDownload(author, aemToken, folder + '/' + c.variations.name)).toString('utf8')
    if (maxRows > 0) varText = truncateCsv(varText, maxRows, rowOffset)
    staged.push({ dest: destFor('variations'), buf: Buffer.from(varText, 'utf8') })
    staged.push({ dest: destFor('pagemap'), buf: await aemDownload(author, aemToken, folder + '/' + c.pagemap.name) })
    // swapped images: job-folder images plus those AEM-linked in the template that the CSV references
    const { fromLinks } = await resolveImages(author, folder, c, templateBuf, varText)
    const aemSource = new Map(c.images.map((im) => [im.name, `${folder}/${im.name}`]))
    fromLinks.forEach((l) => aemSource.set(l.name, l.damPath))
    for (const im of c.images) staged.push({ dest: destFor('image', im.name), buf: await aemDownload(author, aemToken, folder + '/' + im.name) })
    for (const l of fromLinks) staged.push({ dest: destFor('image', l.name), buf: await aemDownload(author, aemToken, l.damPath) })
    logger.info(`swapped images: ${c.images.length} from folder, ${fromLinks.length} from template Asset Links`)

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
    const remapWarnings = []
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
        batchRows: varText.trim() ? Math.max(0, varText.trim().split(/\r?\n/).length - 1) : 0,
        remapWarnings,
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
exports.aemContext = aemContext
exports.aemDownload = aemDownload
exports.writeJobManifest = writeJobManifest
exports.jobManifestName = jobManifestName
