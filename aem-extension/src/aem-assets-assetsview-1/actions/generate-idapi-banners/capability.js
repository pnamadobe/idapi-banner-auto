/*
 * Self-bootstrapping InDesign API capability registration (/v3/capability).
 *
 * When a customer installs the app from Adobe Exchange and configures their
 * Firefly Services credentials (FFS_CLIENT_ID / FFS_CLIENT_SECRET / FFS_ORG_ID)
 * without a pre-registered INDESIGN_EXECUTE_URL, this module packages
 *manifest.json + generate_variations.jsx + brand_lib.jsx into a deterministic
 * STORE zip in memory, registers the capability against POST /v3/capability,
 * and caches the resulting execution URL in @adobe/aio-lib-state.
 */

const crypto = require('crypto')
const fs = require('fs')
const path = require('path')

const CAPABILITY_TTL = 365 * 24 * 3600
const DEFAULT_INDESIGN_BASE = 'https://indesign.adobe.io'

const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1)
    t[n] = c >>> 0
  }
  return t
})()

function crc32 (buf) {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

// Deterministic STORE (uncompressed) ZIP writer.
function zipStore (files) {
  const parts = []
  const central = []
  let offset = 0
  for (const f of files) {
    const name = Buffer.from(f.name, 'utf8')
    const data = Buffer.isBuffer(f.data) ? f.data : Buffer.from(String(f.data), 'utf8')
    const crc = crc32(data)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0, 6)
    local.writeUInt16LE(0, 8)
    local.writeUInt16LE(0, 10)
    local.writeUInt16LE(0x21, 12)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(data.length, 18)
    local.writeUInt32LE(data.length, 22)
    local.writeUInt16LE(name.length, 26)
    local.writeUInt16LE(0, 28)
    parts.push(local, name, data)

    const cen = Buffer.alloc(46)
    cen.writeUInt32LE(0x02014b50, 0)
    cen.writeUInt16LE(20, 4)
    cen.writeUInt16LE(20, 6)
    cen.writeUInt16LE(0, 8)
    cen.writeUInt16LE(0, 10)
    cen.writeUInt16LE(0, 12)
    cen.writeUInt16LE(0x21, 14)
    cen.writeUInt32LE(crc, 16)
    cen.writeUInt32LE(data.length, 20)
    cen.writeUInt32LE(data.length, 24)
    cen.writeUInt16LE(name.length, 28)
    cen.writeUInt16LE(0, 30)
    cen.writeUInt16LE(0, 32)
    cen.writeUInt16LE(0, 34)
    cen.writeUInt16LE(0, 36)
    cen.writeUInt32LE(0, 38)
    cen.writeUInt32LE(offset, 42)
    central.push(cen, name)
    offset += local.length + name.length + data.length
  }
  const centralBuf = Buffer.concat(central)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(files.length, 8)
  end.writeUInt16LE(files.length, 10)
  end.writeUInt32LE(centralBuf.length, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...parts, centralBuf, end])
}

function buildManifest ({ name = 'idapi-banner-exporter', version = '1.0.0', entry = 'generate_variations.jsx' } = {}) {
  return {
    manifestVersion: '1.0.0',
    name,
    host: { app: 'indesign', minVersion: '16.0.1', maxVersion: '99.9.9' },
    version,
    apiEntryPoints: [
      { type: 'capability', path: entry, language: 'extendscript' }
    ]
  }
}

function loadScripts () {
  for (const dir of [path.join(__dirname, 'scripts'), path.resolve(__dirname, '../../../../../scripts')]) {
    try {
      return {
        entry: fs.readFileSync(path.join(dir, 'generate_variations.jsx')),
        lib: fs.readFileSync(path.join(dir, 'brand_lib.jsx'))
      }
    } catch (e) { /* try next */ }
  }
  // Fallback for bundled Webpack actions where scripts/*.jsx are embedded via asset/source
  const entry = require('./scripts/generate_variations.jsx')
  const lib = require('./scripts/brand_lib.jsx')
  return {
    entry: Buffer.isBuffer(entry) ? entry : Buffer.from(String(entry), 'utf8'),
    lib: Buffer.isBuffer(lib) ? lib : Buffer.from(String(lib), 'utf8')
  }
}

function buildCapabilityBundle (opts = {}) {
  const { entry, lib } = opts.scripts || loadScripts()
  const scriptHash = crypto.createHash('sha1').update(entry).update(lib).digest('hex').slice(0, 8)
  const version = opts.version || `1.0.${parseInt(scriptHash.slice(0, 4), 16) % 1000}`
  const name = opts.name || `idapi-banner-exporter-${scriptHash.slice(0, 6)}`
  const manifest = buildManifest({ name, version, entry: 'generate_variations.jsx' })
  const zip = zipStore([
    { name: 'manifest.json', data: Buffer.from(JSON.stringify(manifest, null, 2), 'utf8') },
    { name: 'generate_variations.jsx', data: entry },
    { name: 'brand_lib.jsx', data: lib }
  ])
  return { zip, manifest, scriptHash }
}

// Construct a standards-compliant multipart/form-data body without external dependencies.
function multipartZipBody (zipBuf, boundary = `----idapiCapability${crypto.randomBytes(8).toString('hex')}`) {
  const head = Buffer.from(
    `--${boundary}\r\n` +
    'Content-Disposition: form-data; name="file"; filename="capability.zip"\r\n' +
    'Content-Type: application/zip\r\n\r\n',
    'utf8'
  )
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8')
  return {
    contentType: `multipart/form-data; boundary=${boundary}`,
    body: Buffer.concat([head, zipBuf, tail])
  }
}

function capabilityCacheKey (clientId, scriptHash) {
  const h = crypto.createHash('sha1').update(`${clientId || ''}|${scriptHash || ''}`).digest('hex').slice(0, 32)
  return `idapi-cap-${h}`
}

async function registerCapability (params, tok, opts = {}) {
  const base = String(params.INDESIGN_API_BASE || DEFAULT_INDESIGN_BASE).replace(/\/+$/, '')
  const { zip, manifest, scriptHash } = buildCapabilityBundle(opts)
  const { contentType, body } = multipartZipBody(zip)
  const headers = {
    Authorization: `Bearer ${tok}`,
    'x-api-key': params.FFS_CLIENT_ID,
    ...(params.FFS_ORG_ID ? { 'x-gw-ims-org-id': params.FFS_ORG_ID } : {}),
    'Content-Type': contentType
  }
  const res = await fetch(`${base}/v3/capability`, { method: 'POST', headers, body })
  const text = await res.text()
  if (!res.ok) {
    throw new Error(`InDesign capability registration failed (${res.status}): ${text.slice(0, 400)}`)
  }
  let parsed
  try { parsed = JSON.parse(text) } catch (e) { parsed = null }
  const url = parsed && (parsed.url || parsed.executeUrl)
  if (!url || !/^https:\/\//i.test(url)) {
    throw new Error(`InDesign capability registration returned no execution URL: ${text.slice(0, 300)}`)
  }
  return { url, manifest, scriptHash }
}

async function resolveExecuteUrl (params, tok, state, logger, opts = {}) {
  const explicit = String(params.INDESIGN_EXECUTE_URL || '').trim()
  if (explicit && !opts.forceRegister) return explicit
  const { scriptHash } = buildCapabilityBundle(opts)
  const key = capabilityCacheKey(params.FFS_CLIENT_ID, scriptHash)
  if (state && !opts.forceRegister && typeof state.get === 'function') {
    try {
      const cached = await state.get(key)
      const url = cached && String(cached.value || '').trim()
      if (/^https:\/\//i.test(url)) return url
    } catch (e) { /* state miss */ }
  }
  if (logger && typeof logger.info === 'function') {
    logger.info(`auto-registering InDesign capability (hash ${scriptHash})`)
  }
  const { url } = await registerCapability(params, tok, opts)
  if (state && typeof state.put === 'function') {
    try { await state.put(key, url, { ttl: CAPABILITY_TTL }) } catch (e) { /* non-fatal */ }
  }
  return url
}

module.exports = {
  zipStore,
  buildManifest,
  buildCapabilityBundle,
  multipartZipBody,
  capabilityCacheKey,
  registerCapability,
  resolveExecuteUrl
}
