#!/usr/bin/env node
/*
 * cloud/run.mjs — Phase 2a harness: run generate_variations.jsx on the Adobe
 * InDesign API (Firefly Services), driving the SAME .jsx we run locally.
 *
 * Modes:
 *   node cloud/run.mjs --dry-run     (default) assemble + print the whole plan; no creds needed
 *   node cloud/run.mjs --check-auth  fetch an IMS access token and report; needs creds
 *   node cloud/run.mjs --submit      full run: auth -> upload -> submit -> poll -> download
 *
 * Requires Node >= 18 (global fetch). Zero npm dependencies.
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
    // Verified against the InDesign APIs / Firefly Services Dev Console onboarding.
    scopes: process.env.FFS_SCOPES || "openid,AdobeID,creative_sdk,ff_apis,indesign_services",
    // Pre-generated bearer token (e.g. IMSS "short-lived service token"). When set,
    // it is used directly and no exchange happens. Ephemeral — testing only.
    accessToken: process.env.FFS_ACCESS_TOKEN || "",
    // IMSS "Permanent Authorization Code" (durable). Exchanged for a fresh
    // access token per run via grant_type=authorization_code. This is the
    // production path for an IMSS service-token client.
    authCode: process.env.FFS_AUTH_CODE || "",
  },
  api: {
    base: process.env.INDESIGN_API_BASE || "https://indesign.adobe.io", // VERIFY
    // Custom-script capability endpoint — VERIFY path/version in current docs.
    scriptPath: process.env.INDESIGN_SCRIPT_PATH || "/v3/capabilities/script",
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
const MODE = args.has("--submit") ? "submit" : args.has("--check-auth") ? "check-auth" : "dry-run";

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
    if (CFG.ims.scopes) body.set("scope", CFG.ims.scopes);
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

async function submitJob(token, payload) {
  const url = CFG.api.base + CFG.api.scriptPath;
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
