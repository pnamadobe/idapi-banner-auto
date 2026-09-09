#!/usr/bin/env node
/*
 * cloud/run.mjs — Phase 2a harness: run generate_variations.jsx on the Adobe
 * InDesign API (Firefly Services), driving the SAME .jsx we run locally.
 *
 * Modes:
 *   node cloud/run.mjs --dry-run     (default) assemble + print the whole plan; no creds needed
 *   node cloud/run.mjs --check-auth  fetch an IMS access token and report; needs creds
 *   node cloud/run.mjs --ping        GET /v3/scripts reachability probe (reads; service token OK)
 *   node cloud/run.mjs --register    register the capability bundle (POST /v3/capability)
 *   node cloud/run.mjs --submit      full run: auth -> upload -> execute -> poll -> download
 *
 * ⚠️ AUTH POLICY (confirmed by the InDesign API team, 2026-09-09):
 *   Custom-script/capability REGISTRATION is privileged — it accepts ONLY a
 *   Developer Console OAuth Server-to-Server token. An IMSS service token is
 *   rejected on the write path with 400 "Unable to get the IMS Organization"
 *   (reads/GET still work with a service token). So --register (and the register
 *   step of --submit) require the client_credentials path below, from a Dev
 *   Console "InDesign API – Firefly Services" project. That project only appears
 *   once the IMS org is entitled to the Firefly Services product.
 *
 * Requires Node >= 18 (global fetch, FormData/Blob). Zero npm dependencies.
 *
 * ⚠️ VERIFY-flagged spots below are the InDesign-API specifics I could not
 * re-confirm against live docs in this session (endpoint paths, asset JSON
 * schema, storage mechanism). The orchestration, folder contract, CSV parsing,
 * output-name computation and IMS auth are solid and testable today via
 * --dry-run / --check-auth.
 */

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");           // project root (mirrors local layout)

// ----------------------------------------------------------------------------
// tiny .env loader (no dependency)
// ----------------------------------------------------------------------------
(function loadDotEnv() {
  const envPath = path.join(__dirname, ".env");
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
    if (m && process.env[m[1]] === undefined) {
      process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
  }
})();

const CFG = {
  ims: {
    endpoint: process.env.IMS_ENDPOINT || "https://ims-na1.adobelogin.com/ims/token/v3",
    clientId: process.env.FFS_CLIENT_ID || "",
    clientSecret: process.env.FFS_CLIENT_SECRET || "",
    // Scopes for the OAuth Server-to-Server (client_credentials) path — the Dev
    // Console token used for registration. Current InDesign guidance is to
    // request `firefly_api`; `indesign_services` stays for backward-compat.
    // (The IMSS service-token/auth-code path overrides this with FFS_SCOPES=system.)
    scopes: process.env.FFS_SCOPES || "openid,AdobeID,firefly_api,ff_apis,indesign_services",
    // Pre-generated bearer token (e.g. IMSS "short-lived service token"). When set,
    // it is used directly and no exchange happens. Ephemeral — testing only.
    accessToken: process.env.FFS_ACCESS_TOKEN || "",
    // IMSS "Permanent Authorization Code" (durable). Exchanged for a fresh
    // access token per run via grant_type=authorization_code. This is the
    // production path for an IMSS service-token client.
    authCode: process.env.FFS_AUTH_CODE || "",
    // IMS Organization ID (…@AdobeOrg). Firefly Services requires this as the
    // x-gw-ims-org-id header; the API can't resolve org from a service token alone.
    orgId: process.env.FFS_ORG_ID || process.env.IMS_ORG_ID || "",
  },
  api: {
    base: process.env.INDESIGN_API_BASE || "https://indesign.adobe.io",
    // Register a custom-script capability. VERIFIED endpoint: POST /v3/capability
    // (multipart field `file` = the bundle zip). Returns { url, capability } where
    // `url` is the execution endpoint. Requires a Dev Console OAuth S2S token.
    registerPath: process.env.INDESIGN_REGISTER_PATH || "/v3/capability",
    // Execution endpoint returned by registration (POST it with the job JSON).
    // Capture it from --register output into INDESIGN_EXECUTE_URL for --submit.
    executeUrl: process.env.INDESIGN_EXECUTE_URL || "",
    pollIntervalMs: Number(process.env.POLL_INTERVAL_MS || 4000),
    pollTimeoutMs: Number(process.env.POLL_TIMEOUT_MS || 600000),
  },
  storageMode: process.env.STORAGE_MODE || "unset", // unset | adobe | s3 | azure  (see README)
  files: {
    template: "template/brand-template.indd",
    lockup: "assets/brand/brand-lockup.png",
    csv: "input/brand-variations.csv",
    scriptEntry: "scripts/generate_variations.jsx",
    scriptLib: "scripts/brand_lib.jsx",
    shotsDir: "assets/shots",
    docFontsDir: "template/Document Fonts", // InDesign auto-activates fonts placed here
    extraFontsDir: "assets/fonts",
    outputDir: "output",
  },
};

const args = new Set(process.argv.slice(2));
const MODE = args.has("--submit") ? "submit"
  : args.has("--register") ? "register"
  : args.has("--ping") ? "ping"
  : args.has("--check-auth") ? "check-auth"
  : "dry-run";

// ----------------------------------------------------------------------------
// helpers
// ----------------------------------------------------------------------------
const abs = (rel) => path.join(ROOT, rel);
const exists = (rel) => fs.existsSync(abs(rel));
const log = (...a) => console.log(...a);
const die = (msg) => { console.error("✗ " + msg); process.exit(1); };

// Parse the 10 size names + default hero straight out of brand_lib.jsx so the
// harness never drifts from the InDesign side.
function parseLib() {
  const src = fs.readFileSync(abs(CFG.files.scriptLib), "utf8");
  const pagesBlock = src.slice(src.indexOf("var PAGES"), src.indexOf("var FONTS"));
  const sizes = [...pagesBlock.matchAll(/name:\s*"([^"]+)"/g)].map((m) => m[1]);
  const heroM = src.match(/hero:\s*"([^"]+\.(?:jpg|jpeg|png))"/i);
  return { sizes, defaultHero: heroM ? heroM[1] : null };
}

// CSV parser matching the .jsx semantics (quoted fields, "" escapes, embedded
// commas + newlines). Returns array of row objects.
function parseCSV(text) {
  const rows = [];
  let row = [], field = "", inQ = false, i = 0;
  const pushF = () => { row.push(field); field = ""; };
  const pushR = () => { pushF(); rows.push(row); row = []; };
  while (i < text.length) {
    const c = text[i];
    if (inQ) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i += 2; continue; } inQ = false; i++; continue; }
      field += c; i++; continue;
    } else {
      if (c === '"') { inQ = true; i++; continue; }
      if (c === ",") { pushF(); i++; continue; }
      if (c === "\r") { if (text[i + 1] === "\n") i++; pushR(); i++; continue; }
      if (c === "\n") { pushR(); i++; continue; }
      field += c; i++; continue;
    }
  }
  if (field !== "" || row.length) pushR();
  const header = (rows.shift() || []).map((h) => h.trim());
  return rows
    .filter((r) => !(r.length === 1 && r[0] === ""))
    .map((r) => Object.fromEntries(header.map((h, k) => [h, r[k] ?? ""])));
}

function listFiles(rel) {
  const dir = abs(rel);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => !f.startsWith(".")).map((f) => path.join(rel, f));
}

// Assemble the input asset list (local path + destination path in the job dir).
function collectInputs(rows, lib) {
  const dests = new Set();
  const inputs = [];
  const add = (rel, { required = true } = {}) => {
    if (dests.has(rel)) return;
    if (!exists(rel)) { if (required) die(`missing input: ${rel}`); else return; }
    dests.add(rel);
    inputs.push({ local: abs(rel), dest: rel });
  };

  add(CFG.files.template);
  add(CFG.files.lockup);
  add(CFG.files.csv);
  add(CFG.files.scriptEntry);
  add(CFG.files.scriptLib);
  const resolveShot = (name) => {
    const p1 = `${CFG.files.shotsDir}/${name}`;
    const p2 = `${CFG.files.shotsDir}/square/${name}`;
    return exists(p1) ? p1 : (exists(p2) ? p2 : p1); // mirror the .jsx square/ fallback
  };
  if (lib.defaultHero) add(resolveShot(lib.defaultHero));
  for (const r of rows) if (r.hero) add(resolveShot(r.hero));
  // fonts (optional): auto-activated from Document Fonts, plus any extras
  for (const f of listFiles(CFG.files.docFontsDir)) add(f, { required: false });
  for (const f of listFiles(CFG.files.extraFontsDir)) add(f, { required: false });
  return inputs;
}

function computeOutputs(rows, sizes) {
  const out = [];
  rows.forEach((r, idx) => {
    const stem = (r.outputFileName || `row${idx + 1}`).trim();
    for (const size of sizes) out.push({ dest: `${CFG.files.outputDir}/${size}_${stem}.png` });
  });
  return out;
}

// ----------------------------------------------------------------------------
// Minimal STORE (no compression) ZIP writer — zero deps, deterministic. The
// capability bundle is a few small text files, so no compression is needed.
// Files land at the zip root (no parent folder), as the InDesign API requires.
// ----------------------------------------------------------------------------
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function zipStore(files) {
  // files: [{ name, data: Buffer }]
  const parts = [];
  const central = [];
  let offset = 0;
  for (const f of files) {
    const name = Buffer.from(f.name, "utf8");
    const data = Buffer.isBuffer(f.data) ? f.data : Buffer.from(f.data);
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);   // local file header signature
    local.writeUInt16LE(20, 4);           // version needed to extract
    local.writeUInt16LE(0, 6);            // general purpose flags
    local.writeUInt16LE(0, 8);            // compression method: 0 = store
    local.writeUInt16LE(0, 10);           // mod time (fixed → deterministic)
    local.writeUInt16LE(0x21, 12);        // mod date (1980-01-01)
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18); // compressed size
    local.writeUInt32LE(data.length, 22); // uncompressed size
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);           // extra field length
    parts.push(local, name, data);

    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(0x02014b50, 0);     // central dir header signature
    cen.writeUInt16LE(20, 4);             // version made by
    cen.writeUInt16LE(20, 6);             // version needed
    cen.writeUInt16LE(0, 8);
    cen.writeUInt16LE(0, 10);
    cen.writeUInt16LE(0, 12);
    cen.writeUInt16LE(0x21, 14);
    cen.writeUInt32LE(crc, 16);
    cen.writeUInt32LE(data.length, 20);
    cen.writeUInt32LE(data.length, 24);
    cen.writeUInt16LE(name.length, 28);
    cen.writeUInt16LE(0, 30);             // extra len
    cen.writeUInt16LE(0, 32);             // comment len
    cen.writeUInt16LE(0, 34);             // disk number
    cen.writeUInt16LE(0, 36);             // internal attrs
    cen.writeUInt32LE(0, 38);             // external attrs
    cen.writeUInt32LE(offset, 42);        // local header offset
    central.push(cen, name);
    offset += local.length + name.length + data.length;
  }
  const centralBuf = Buffer.concat(central);
  const centralOffset = offset;
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);       // end of central dir signature
  end.writeUInt16LE(files.length, 8);     // entries on this disk
  end.writeUInt16LE(files.length, 10);    // total entries
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(centralOffset, 16);
  return Buffer.concat([...parts, centralBuf, end]);
}

// ----------------------------------------------------------------------------
// IMS auth (stable, fully implemented)
// ----------------------------------------------------------------------------
async function getAccessToken() {
  // 1) Pre-supplied token wins — ephemeral, for a quick manual test only.
  if (CFG.ims.accessToken) {
    return { access_token: CFG.ims.accessToken, token_type: "bearer", expires_in: "preset (FFS_ACCESS_TOKEN)" };
  }
  // 2) IMSS permanent authorization code → exchange for a fresh access token (durable).
  if (CFG.ims.authCode) {
    if (!CFG.ims.clientId || !CFG.ims.clientSecret) die("FFS_AUTH_CODE needs FFS_CLIENT_ID + FFS_CLIENT_SECRET too");
    const body = new URLSearchParams({
      grant_type: "authorization_code",
      client_id: CFG.ims.clientId,
      client_secret: CFG.ims.clientSecret,
      code: CFG.ims.authCode,
    });
    // Service-token exchange scope is the constant `system` (verified). The API
    // scopes ride from the IMSS client config; requesting them here → invalid_scope.
    // This is independent of CFG.ims.scopes (which is for the OAuth S2S path).
    body.set("scope", process.env.FFS_AUTH_CODE_SCOPE || "system");
    const res = await fetch(CFG.ims.endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });
    if (!res.ok) die(`IMS auth-code exchange failed: ${res.status} ${await res.text()}`);
    return res.json(); // { access_token, token_type, expires_in }
  }
  // 3) OAuth Server-to-Server (client_credentials) — standard FFS path once entitled.
  if (!CFG.ims.clientId || !CFG.ims.clientSecret) {
    die("Set one auth path in cloud/.env: FFS_ACCESS_TOKEN, or FFS_AUTH_CODE (+ client id/secret), or FFS_CLIENT_ID/FFS_CLIENT_SECRET. See cloud/.env.example");
  }
  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: CFG.ims.clientId,
    client_secret: CFG.ims.clientSecret,
    scope: CFG.ims.scopes,
  });
  const res = await fetch(CFG.ims.endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!res.ok) die(`IMS token failed: ${res.status} ${await res.text()}`);
  return res.json(); // { access_token, token_type, expires_in }
}

// ----------------------------------------------------------------------------
// storage seams — depend on decision #3 (Adobe temp storage vs S3/Azure vs AEM
// delivery URLs). Left as explicit, honest stubs so --submit never silently
// does the wrong thing. Wire these once the storage choice + API asset schema
// are confirmed.
// ----------------------------------------------------------------------------
async function uploadInput(_input) {
  die(`storage upload not wired (STORAGE_MODE=${CFG.storageMode}). See cloud/README.md → "Storage".`);
}
async function makeOutputTarget(_dest) {
  die(`storage output target not wired (STORAGE_MODE=${CFG.storageMode}). See cloud/README.md → "Storage".`);
}

// Build the custom-script job payload. Shape is illustrative — VERIFY field
// names/paths against the current InDesign API reference.
function buildJobPayload(inputAssets, outputAssets) {
  return {
    // each asset: where the service downloads it from + where it lands in the job dir
    assets: inputAssets.map((a) => ({ source: a.source, destination: a.dest })),
    script: {
      // the entry script; it #includes scripts/brand_lib.jsx (relative)
      source: inputAssets.find((a) => a.dest === CFG.files.scriptEntry)?.source,
      destination: CFG.files.scriptEntry,
    },
    // computeRoot() in brand_lib resolves the working dir from the script
    // location, so no params are strictly required. Passed for clarity/override.
    params: { projectRoot: "." },
    outputs: outputAssets.map((o) => ({ destination: o.dest, source: o.target })),
  };
}

// Manifest for the capability bundle. Shape verified against the InDesign API
// docs: host is an object, apiEntryPoints[].path names the entry file in the
// zip, language = "extendscript".
function buildManifest() {
  return {
    manifestVersion: "1.0.0",
    name: process.env.CAPABILITY_NAME || "idapi-banner-exporter",
    host: { app: "indesign", minVersion: "16.0.1", maxVersion: "99.9.9" },
    version: "1.0.0",
    apiEntryPoints: [
      { type: "capability", path: path.basename(CFG.files.scriptEntry), language: "extendscript" },
    ],
  };
}

// Register the capability: POST /v3/capability, multipart field `file` = a zip of
// manifest.json + entry .jsx (+ helper lib) at the root. REQUIRES a Dev Console
// OAuth S2S token (service tokens are rejected here — see AUTH POLICY up top).
async function registerCapability(token) {
  const entry = path.basename(CFG.files.scriptEntry);   // generate_variations.jsx
  const files = [
    { name: "manifest.json", data: Buffer.from(JSON.stringify(buildManifest(), null, 2)) },
    { name: entry, data: fs.readFileSync(abs(CFG.files.scriptEntry)) },
  ];
  if (exists(CFG.files.scriptLib)) {
    files.push({ name: path.basename(CFG.files.scriptLib), data: fs.readFileSync(abs(CFG.files.scriptLib)) });
  }
  const zip = zipStore(files);

  const fd = new FormData();
  fd.append("file", new Blob([zip], { type: "application/zip" }), "capability.zip");

  const url = CFG.api.base + CFG.api.registerPath;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token.access_token}`,
      "x-api-key": CFG.ims.clientId,
      ...(CFG.ims.orgId ? { "x-gw-ims-org-id": CFG.ims.orgId } : {}),
    },
    body: fd,
  });
  const text = await res.text();
  log(`register POST ${url}`);
  log(`  bundle   : ${files.map((f) => f.name).join(", ")} (${zip.length} bytes)`);
  log(`  x-api-key: ${CFG.ims.clientId || "(none — set FFS_CLIENT_ID)"}`);
  log(`  status   : ${res.status} ${res.statusText}`);
  log(`  body     : ${text.slice(0, 600)}`);
  if (res.ok) {
    let j; try { j = JSON.parse(text); } catch {}
    if (j?.url) {
      log(`\n✓ registered. execution url:\n    ${j.url}`);
      log(`  → add to cloud/.env:  INDESIGN_EXECUTE_URL=${j.url}`);
    } else {
      log(`\n✓ registered (inspect the body above for the execution url).`);
    }
    return j;
  }
  if (/Unable to get the IMS Organization/i.test(text)) {
    log(`\n❌ 400 org error → this token cannot register. Registration accepts ONLY a`);
    log(`   Developer Console OAuth Server-to-Server token, not an IMSS service token.`);
    log(`   (Set FFS_CLIENT_ID/FFS_CLIENT_SECRET from a Dev Console "InDesign API –`);
    log(`   Firefly Services" project, clear FFS_AUTH_CODE, and use client_credentials.)`);
  } else if (/40320\d|not allowed to call this service/i.test(text)) {
    log(`\n❌ 403 client not allowlisted → ask the InDesign API team to allowlist this`);
    log(`   client id (${CFG.ims.clientId}) for the register endpoint on this env.`);
  }
  process.exit(1);
}

async function submitJob(token, payload) {
  const url = CFG.api.executeUrl;
  if (!url) die("no execute URL — run --register first, then set INDESIGN_EXECUTE_URL in cloud/.env");
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token.access_token}`,
      "x-api-key": CFG.ims.clientId,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });
  if (!res.ok) die(`submit failed: ${res.status} ${await res.text()}`);
  return res.json(); // expect a job/status URL or id — VERIFY
}

async function pollJob(token, job) {
  const statusUrl = job.statusUrl || job.self || job.links?.status; // VERIFY
  if (!statusUrl) die("no status URL in submit response — inspect job JSON and adjust pollJob()");
  const started = Date.now();
  for (;;) {
    const res = await fetch(statusUrl, {
      headers: { Authorization: `Bearer ${token.access_token}`, "x-api-key": CFG.ims.clientId },
    });
    if (!res.ok) die(`poll failed: ${res.status} ${await res.text()}`);
    const s = await res.json();
    const state = (s.status || s.state || "").toLowerCase();
    log(`  … ${state || "?"}`);
    if (["succeeded", "success", "done", "completed"].includes(state)) return s;
    if (["failed", "error", "cancelled"].includes(state)) die(`job ${state}: ${JSON.stringify(s)}`);
    if (Date.now() - started > CFG.api.pollTimeoutMs) die("poll timeout");
    await new Promise((r) => setTimeout(r, CFG.api.pollIntervalMs));
  }
}

async function downloadOutputs(outputAssets) {
  const dir = abs("output_cloud");
  fs.mkdirSync(dir, { recursive: true });
  let n = 0;
  for (const o of outputAssets) {
    if (!o.downloadUrl) continue; // set by makeOutputTarget once wired
    const res = await fetch(o.downloadUrl);
    if (!res.ok) { console.error(`  ! download failed ${o.dest}: ${res.status}`); continue; }
    const buf = Buffer.from(await res.arrayBuffer());
    fs.writeFileSync(path.join(dir, path.basename(o.dest)), buf);
    n++;
  }
  log(`downloaded ${n} file(s) -> output_cloud/`);
}

// ----------------------------------------------------------------------------
// main
// ----------------------------------------------------------------------------
async function main() {
  if (typeof fetch === "undefined") die("Node >= 18 required (global fetch missing)");

  // Auth is independent of the job inputs — check it before touching the CSV/assets
  // (which are supplied out-of-band and may not be present locally).
  if (MODE === "check-auth") {
    const tok = await getAccessToken();
    log(`✓ IMS token acquired (${tok.token_type}, expires_in=${tok.expires_in}s, len=${(tok.access_token||"").length})`);
    return;
  }

  // Minimal reachability test: is the token + host + entitlement accepted by the
  // InDesign API? GET /v3/scripts (list custom scripts) is a lightweight probe.
  if (MODE === "ping") {
    const tok = await getAccessToken();
    const url = CFG.api.base + (process.env.INDESIGN_PING_PATH || "/v3/scripts");
    let res, bodyText = "";
    try {
      res = await fetch(url, {
        headers: {
          Authorization: `Bearer ${tok.access_token}`,
          "x-api-key": CFG.ims.clientId,
          ...(CFG.ims.orgId ? { "x-gw-ims-org-id": CFG.ims.orgId } : {}),
        },
      });
      bodyText = await res.text();
    } catch (e) {
      die(`ping request failed (network/host): ${e?.message || e}`);
    }
    log(`ping ${url}`);
    log(`  x-api-key: ${CFG.ims.clientId ? CFG.ims.clientId.slice(0, 6) + "…" : "(none — set FFS_CLIENT_ID)"}`);
    log(`  status   : ${res.status} ${res.statusText}`);
    log(`  body     : ${bodyText.slice(0, 400)}`);
    if (res.ok) log("  → OK: token + host + entitlement accepted. 🎉");
    else if (res.status === 401) log("  → 401: token not accepted (stage token vs prod host? wrong x-api-key?).");
    else if (res.status === 403) log("  → 403: authenticated but not entitled for this API on this env.");
    else if (res.status === 404) log("  → 404: host reachable but path off; try INDESIGN_PING_PATH.");
    return;
  }

  // Register the capability bundle. Needs a Dev Console OAuth S2S token.
  if (MODE === "register") {
    const tok = await getAccessToken();
    await registerCapability(tok);
    return;
  }

  const lib = parseLib();
  const rows = parseCSV(fs.readFileSync(abs(CFG.files.csv), "utf8"));
  const inputs = collectInputs(rows, lib);
  const outputs = computeOutputs(rows, lib.sizes);

  log(`Brand InDesign banner automation — cloud harness [${MODE}]`);
  log(`project root : ${ROOT}`);
  log(`sizes (${lib.sizes.length}) : ${lib.sizes.join(", ")}`);
  log(`csv rows     : ${rows.length}  (stems: ${rows.map((r) => r.outputFileName).join(", ")})`);
  log(`inputs       : ${inputs.length} files`);
  log(`outputs      : ${outputs.length} files  (rows × sizes)`);

  if (MODE === "dry-run") {
    const dbg = path.join(__dirname, "_dryrun");
    fs.mkdirSync(dbg, { recursive: true });
    fs.writeFileSync(path.join(dbg, "inputs.json"), JSON.stringify(inputs, null, 2));
    fs.writeFileSync(path.join(dbg, "outputs.json"), JSON.stringify(outputs, null, 2));
    // illustrative payload with placeholder URLs
    const inAssets = inputs.map((a) => ({ ...a, source: { url: `PLACEHOLDER_UPLOAD/${a.dest}` } }));
    const outAssets = outputs.map((o) => ({ ...o, target: { url: `PLACEHOLDER_OUTPUT/${o.dest}` } }));
    fs.writeFileSync(path.join(dbg, "job-payload.json"), JSON.stringify(buildJobPayload(inAssets, outAssets), null, 2));
    const fontCount = [...listFiles(CFG.files.docFontsDir), ...listFiles(CFG.files.extraFontsDir)].length;
    log(`fonts bundled: ${fontCount} ${fontCount ? "" : "(⚠ none found — add Source Sans 3 to template/Document Fonts/ for cloud)"}`);
    log(`\n✓ dry-run wrote cloud/_dryrun/{inputs,outputs,job-payload}.json`);
    log(`  auth creds present: ${CFG.ims.clientId ? "yes" : "no"}  |  storage mode: ${CFG.storageMode}`);
    return;
  }

  // MODE === submit
  log(`\nauthenticating…`);
  const tok = await getAccessToken();
  log(`uploading ${inputs.length} inputs (STORAGE_MODE=${CFG.storageMode})…`);
  const inAssets = [];
  for (const a of inputs) inAssets.push({ ...a, source: await uploadInput(a) });
  const outAssets = [];
  for (const o of outputs) outAssets.push({ ...o, ...(await makeOutputTarget(o.dest)) });
  log(`submitting job…`);
  const job = await submitJob(tok, buildJobPayload(inAssets, outAssets));
  log(`polling…`);
  await pollJob(tok, job);
  await downloadOutputs(outAssets);
  log(`✓ done`);
}

main().catch((e) => die(e?.stack || String(e)));
