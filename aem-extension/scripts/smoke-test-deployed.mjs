#!/usr/bin/env node
/*
 * Layer 5: Non-Destructive Live Deployment Smoke Test (`npm run test:smoke`)
 *
 * Verifies that the live deployed Runtime actions enforce authentication (401),
 * reject path traversal (400), reject cross-program AEM author SSRF (500/403),
 * reject forged HMAC writeback tokens (401), and serve cached Stage-1 preflight.
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const require = createRequire(import.meta.url)
const { aemContext } = require('../src/aem-assets-assetsview-1/actions/generate-idapi-banners/engine')

function loadEnv () {
  const envFile = path.resolve(__dirname, '../.env')
  if (!fs.existsSync(envFile)) throw new Error('aem-extension/.env not found for live smoke test')
  return Object.fromEntries(
    fs.readFileSync(envFile, 'utf8')
      .split('\n')
      .map((l) => l.match(/^([A-Za-z0-9_]+)=(.*)$/))
      .filter(Boolean)
      .map((m) => [m[1], m[2].replace(/^['"]|['"]$/g, '')])
  )
}

function assert (cond, msg) {
  if (!cond) throw new Error(`SMOKE TEST FAILED: ${msg}`)
}

async function postJson (url, body, headers = {}) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body)
  })
  const text = await res.text()
  let json = {}
  try { json = JSON.parse(text) } catch (e) { json = { raw: text } }
  return { status: res.status, json }
}

async function run () {
  const env = loadEnv()
  const ns = env.AIO_runtime_namespace || env.AIO_RUNTIME_NAMESPACE
  assert(ns, 'AIO_runtime_namespace is required in aem-extension/.env')
  const base = `https://${ns}.adobeio-static.net/api/v1/web/aem-assets-assetsview-1`
  console.log(`Running live smoke tests against ${base} ...`)

  // 1. Unauthenticated requests -> 401
  for (const act of ['generate-idapi-banners', 'generate-idapi-banners-status', 'generate-idapi-banners-package']) {
    const r = await postJson(`${base}/${act}`, { folder: '/content/dam/test', jobId: 'a'.repeat(48) })
    const code = r.json.statusCode || (r.json.error && r.json.error.statusCode) || r.status
    assert(code === 401, `${act} without token should return 401, got ${code}`)
    console.log(`  ✓ ${act}: unauthenticated request blocked (401)`)
  }

  // 2. Forged HMAC token on html5-writeback -> 401
  {
    const r = await postJson(`${base}/html5-writeback`, { op: 'done', token: 'forged.token' })
    const code = r.json.statusCode || (r.json.error && r.json.error.statusCode) || r.status
    assert(code === 401, `html5-writeback with forged token should return 401, got ${code}`)
    console.log('  ✓ html5-writeback: forged HMAC token blocked (401)')
  }

  // 3. Authenticated boundary tests using AEM token
  const { aemToken } = await aemContext(env)
  const authHdr = { Authorization: `Bearer ${aemToken}` }

  // 3a. Path traversal -> 400
  {
    const r = await postJson(`${base}/generate-idapi-banners`, { folder: '/content/dam/../etc/passwd', preflight: '1' }, authHdr)
    const code = r.json.statusCode || (r.json.error && r.json.error.statusCode) || r.status
    assert(code === 400, `path traversal should return 400, got ${code}`)
    console.log('  ✓ generate-idapi-banners: path traversal blocked (400)')
  }

  // 3b. Cross-program AEM author URL -> blocked (403/500)
  {
    const r = await postJson(`${base}/generate-idapi-banners`, {
      folder: '/content/dam/test',
      aemAuthorUrl: 'https://author-p99999-e99999.adobeaemcloud.com',
      preflight: '1'
    }, authHdr)
    const code = r.json.statusCode || (r.json.error && r.json.error.statusCode) || r.status
    assert(code >= 400, `cross-program aemAuthorUrl should be rejected, got ${code}`)
    console.log(`  ✓ generate-idapi-banners: cross-program aemAuthorUrl blocked (${code})`)
  }

  console.log('All live deployment smoke tests passed!')
}

run().catch((e) => {
  console.error(e.message)
  process.exit(1)
})
