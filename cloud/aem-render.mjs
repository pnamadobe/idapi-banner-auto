#!/usr/bin/env node
/*
 * cloud/aem-render.mjs — the AEM-folder-driven render engine (the body of the
 * future App Builder Runtime action). Folder-as-key:
 *
 *   1. read an AEM DAM folder, classify its assets
 *   2. stage inputs → Adobe I/O Files presigned URLs the InDesign API can fetch
 *   3. execute the registered capability → headless render
 *   4. write outputs back into the folder's output/ subfolder (unpublished)
 *
 * Modes:
 *   node cloud/aem-render.mjs --folder <damPath> --read   # list + classify (+ download to tmp)
 *   node cloud/aem-render.mjs --folder <damPath> --run    # full pipeline (added next)
 *
 * Node >= 18. Reads cloud/.env (AEM_AUTHOR_URL, AEM_DEV_TOKEN, FFS_*,
 * INDESIGN_*). Input staging uses Adobe I/O Files, provisioned with the
 * App Builder Runtime namespace.
 */
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { init: initFiles } = require("@adobe/aio-lib-files");

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// --- tiny .env loader ---
(function () {
  const p = path.join(__dirname, ".env");
  if (!fs.existsSync(p)) return;
  for (const line of fs.readFileSync(p, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
})();

const AEM = { author: process.env.AEM_AUTHOR_URL, token: process.env.AEM_DEV_TOKEN };

// --- args ---
const argv = process.argv.slice(2);
const getArg = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
const MODE = argv.includes("--run") ? "run" : "read";
const FOLDER = getArg("--folder"); // e.g. /content/dam/<program>/<job-folder>
const log = (...a) => console.log(...a);
const die = (m) => { console.error("✗ " + m); process.exit(1); };

// ---------------------------------------------------------------------------
// AEM Assets helpers
// ---------------------------------------------------------------------------
function apiPath(damPath) {
  // /content/dam/foo/bar  ->  /api/assets/foo/bar.json
  const rel = damPath.replace(/^\/content\/dam/, "").replace(/^\//, "");
  return `${AEM.author}/api/assets/${rel}.json`;
}
async function aemList(damPath) {
  const res = await fetch(apiPath(damPath), { headers: { Authorization: `Bearer ${AEM.token}` } });
  if (!res.ok) die(`AEM list ${damPath} -> ${res.status} ${await res.text().catch(() => "")}`);
  const j = await res.json();
  return (j.entities || []).map((e) => ({
    name: e.properties && e.properties.name,
    isFolder: (e.class || []).join(",").includes("folder"),
    size: e.properties && e.properties["asset:size"],
  }));
}
async function aemDownload(damPath) {
  // GET the asset's original binary (authenticated). AEM streams it (200).
  const url = `${AEM.author}${damPath.split("/").map(encodeURIComponent).join("/")}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${AEM.token}` } });
  if (!res.ok) die(`AEM download ${damPath} -> ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

// ---------------------------------------------------------------------------
// classify a job folder into the render inputs (folder-as-key contract)
// ---------------------------------------------------------------------------
function classify(entries) {
  const assets = entries.filter((e) => !e.isFolder);
  const isCsv = (n) => /\.csv$/i.test(n);
  const isImg = (n) => /\.(jpe?g|png)$/i.test(n);
  const template = assets.find((e) => /template/i.test(e.name) && /\.indd$/i.test(e.name));
  const pagemap = assets.find((e) => /pagemap/i.test(e.name) && isCsv(e.name));
  const variations = assets.find((e) => isCsv(e.name) && e !== pagemap && !/pagemap/i.test(e.name));
  const images = assets.filter((e) => isImg(e.name));
  const hasOutput = entries.some((e) => e.isFolder && e.name === "output");
  return { template, variations, pagemap, images, hasOutput };
}

// destination path (under the job workingFolder) each input maps to, matching
// what generate_variations.jsx expects.
function destFor(kind, name) {
  if (kind === "template") return "template/brand-template.indd";
  if (kind === "variations") return "input/brand-variations.csv";
  if (kind === "pagemap") return "input/pagemap.csv";
  if (kind === "image") return "assets/shots/" + name;
  return name;
}

// ---------------------------------------------------------------------------
// IMS + Adobe I/O Files + InDesign API + AEM write-back helpers
// ---------------------------------------------------------------------------
async function imsToken() {
  const b = new URLSearchParams({ grant_type: "client_credentials", client_id: process.env.FFS_CLIENT_ID, client_secret: process.env.FFS_CLIENT_SECRET, scope: process.env.FFS_SCOPES || "openid,AdobeID,firefly_api,ff_apis,indesign_services" });
  const r = await fetch(process.env.IMS_ENDPOINT, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: b });
  if (!r.ok) die(`IMS token ${r.status} ${await r.text()}`);
  return (await r.json()).access_token;
}

async function stageInputs(staged) {
  let files;
  try {
    files = await initFiles();
  } catch (e) {
    die(`Adobe I/O Files initialization failed (run this as an App Builder Runtime action with __OW_NAMESPACE/__OW_API_KEY): ${e.message}`);
  }

  const runPrefix = `aem-render/${Date.now()}-${randomUUID()}`;
  const assets = [];
  for (const s of staged) {
    const storagePath = `${runPrefix}/${s.dest}`;
    await files.write(storagePath, s.buf);
    const url = await files.generatePresignURL(storagePath, { expiryInSeconds: 3600 });
    assets.push({ source: { url }, destination: s.dest });
  }
  return { assets, files, runPrefix };
}

const idH = (tok) => ({ Authorization: `Bearer ${tok}`, "x-api-key": process.env.FFS_CLIENT_ID, "x-gw-ims-org-id": process.env.FFS_ORG_ID });
async function indesignExecute(tok, assets) {
  const r = await fetch(process.env.INDESIGN_EXECUTE_URL, { method: "POST", headers: { ...idH(tok), "Content-Type": "application/json" }, body: JSON.stringify({ assets, params: {} }) });
  const t = await r.text();
  if (r.status !== 202) die(`execute ${r.status} ${t}`);
  const j = JSON.parse(t);
  return j.statusUrl || j.statusUrls;
}
async function indesignPoll(tok, statusUrl) {
  for (let n = 0; n < 200; n++) {
    await new Promise((r) => setTimeout(r, 4000));
    const s = await (await fetch(statusUrl, { headers: idH(tok) })).json();
    const st = (s.status || "").toLowerCase();
    if (["succeeded", "completed", "success", "done"].includes(st)) {
      let page = s, out = [];
      for (;;) {
        for (const o of (page.outputs || [])) { const u = o.destination && o.destination.url; if (u) out.push({ src: o.source, url: u }); }
        const next = page.paging && page.paging.nextUrl; if (!next) break;
        page = await (await fetch(next, { headers: idH(tok) })).json();
      }
      return out;
    }
    if (["failed", "error", "cancelled"].includes(st)) die(`render ${st}: ${JSON.stringify(s.errors || s)}`);
  }
  die("render poll timeout");
}

// AEM as a Cloud Service direct-binary upload (initiate → PUT → complete).
async function aemUpload(folderDamPath, name, buf, mime) {
  const initBody = new URLSearchParams({ fileName: name, fileSize: String(buf.length) });
  const ir = await fetch(`${AEM.author}${folderDamPath}.initiateUpload.json`, {
    method: "POST", headers: { Authorization: `Bearer ${AEM.token}`, "Content-Type": "application/x-www-form-urlencoded" }, body: initBody,
  });
  if (!ir.ok) die(`initiateUpload ${name} -> ${ir.status} ${await ir.text()}`);
  const ij = JSON.parse((await ir.text()).replace(/^\)\]\}'?/, "")); // strip any XSSI prefix
  const f = (ij.files || [])[0];
  if (!f || !f.uploadURIs || !f.uploadURIs.length) die(`initiateUpload ${name}: no upload URI`);
  // Upload each block: a bare PUT of the byte range to its presigned block URI.
  const uris = f.uploadURIs, partSize = Math.ceil(buf.length / uris.length);
  for (let i = 0; i < uris.length; i++) {
    const part = buf.subarray(i * partSize, Math.min((i + 1) * partSize, buf.length));
    const pr = await fetch(uris[i], { method: "PUT", body: part });
    if (!(pr.status === 201 || pr.ok)) die(`upload PUT ${name} part ${i} -> ${pr.status} ${await pr.text()}`);
  }
  const completeURI = `${AEM.author}${folderDamPath}.completeUpload.json`;
  const cb = new URLSearchParams({ fileName: name, mimeType: mime || f.mimeType || "application/octet-stream", uploadToken: f.uploadToken, fileSize: String(buf.length) });
  const cr = await fetch(completeURI, { method: "POST", headers: { Authorization: `Bearer ${AEM.token}`, "Content-Type": "application/x-www-form-urlencoded" }, body: cb });
  if (!cr.ok) die(`completeUpload ${name} -> ${cr.status} ${await cr.text()}`);
}

function mimeOf(name) {
  if (/\.jpe?g$/i.test(name)) return "image/jpeg";
  if (/\.png$/i.test(name)) return "image/png";
  if (/\.indd$/i.test(name)) return "application/x-indesign";
  if (/\.json$/i.test(name)) return "application/json";
  if (/\.txt$/i.test(name)) return "text/plain";
  return "application/octet-stream";
}
// keep header + first N data lines (rows here are single-line)
function truncateCsv(text, n) {
  const lines = text.replace(/\r\n?/g, "\n").split("\n").filter((l) => l.length);
  return [lines[0]].concat(lines.slice(1, 1 + n)).join("\n") + "\n";
}

// ---------------------------------------------------------------------------
async function main() {
  if (typeof fetch === "undefined") die("Node >= 18 required");
  if (!AEM.author || !AEM.token) die("set AEM_AUTHOR_URL and AEM_DEV_TOKEN in cloud/.env");
  if (!FOLDER) die("pass --folder /content/dam/<...>");

  log(`AEM render engine [${MODE}]`);
  log(`folder: ${FOLDER}`);
  const entries = await aemList(FOLDER);
  const c = classify(entries);

  log(`\nclassified:`);
  log(`  template  : ${c.template ? c.template.name : "❌ MISSING (needs *template*.indd)"}`);
  log(`  variations: ${c.variations ? c.variations.name : "❌ MISSING (a .csv, not *pagemap*)"}`);
  log(`  pagemap   : ${c.pagemap ? c.pagemap.name : "❌ MISSING (needs *pagemap*.csv)"}`);
  log(`  images    : ${c.images.length} (${c.images.map((i) => i.name).join(", ")})`);
  log(`  output/   : ${c.hasOutput ? "present ✓" : "will be created"}`);
  if (!c.template || !c.variations || !c.pagemap || !c.images.length) die("folder is missing required inputs");

  if (MODE === "read") {
    // prove the AEM read by downloading each input to a tmp dir
    const tmp = path.join(process.env.TMPDIR || "/tmp", "aem-read-" + Date.now());
    fs.mkdirSync(tmp, { recursive: true });
    const pull = async (kind, e) => {
      const buf = await aemDownload(FOLDER + "/" + e.name);
      const dest = destFor(kind, e.name);
      const fp = path.join(tmp, dest);
      fs.mkdirSync(path.dirname(fp), { recursive: true });
      fs.writeFileSync(fp, buf);
      log(`  ↓ ${e.name}  (${buf.length} bytes)  ->  ${dest}`);
    };
    log(`\ndownloading inputs to ${tmp}:`);
    await pull("template", c.template);
    await pull("variations", c.variations);
    await pull("pagemap", c.pagemap);
    for (const im of c.images) await pull("image", im);
    log(`\n✓ read OK — ${3 + c.images.length} inputs downloaded and mapped to render destinations.`);
    return;
  }

  // ---- MODE === run : full pipeline ----
  const maxRowsArg = getArg("--max-rows");
  const maxRows = maxRowsArg === undefined ? 0 : Number(maxRowsArg);
  if (!Number.isInteger(maxRows) || maxRows < 0) die("--max-rows must be a non-negative integer");
  log(`\nauthenticating (InDesign API)…`);
  const tok = await imsToken();

  // 1. pull inputs from AEM into buffers, mapped to render destinations
  log(`pulling inputs from AEM…`);
  const staged = [];
  staged.push({ dest: destFor("template"), buf: await aemDownload(FOLDER + "/" + c.template.name) });
  let varText = (await aemDownload(FOLDER + "/" + c.variations.name)).toString("utf8");
  if (maxRows > 0) {
    varText = truncateCsv(varText, maxRows);
    log(`  (variations truncated to ${maxRows} row(s) for this run)`);
  } else {
    log(`  (variations using full CSV: ${c.variations.name})`);
  }
  staged.push({ dest: destFor("variations"), buf: Buffer.from(varText, "utf8") });
  staged.push({ dest: destFor("pagemap"), buf: await aemDownload(FOLDER + "/" + c.pagemap.name) });
  for (const im of c.images) staged.push({ dest: destFor("image", im.name), buf: await aemDownload(FOLDER + "/" + im.name) });

  // bundle fonts (deterministic type) from cloud/fonts
  const fontsDir = process.env.FONTS_DIR || path.join(__dirname, "fonts");
  if (fs.existsSync(fontsDir)) for (const fn of fs.readdirSync(fontsDir).filter((f) => /\.(otf|ttf)$/i.test(f))) {
    staged.push({ dest: "template/Document Fonts/" + fn, buf: fs.readFileSync(path.join(fontsDir, fn)) });
  }

  // 2. stage to Adobe I/O Files → external presigned source URLs
  log(`staging ${staged.length} inputs to Adobe I/O Files…`);
  const stagedFiles = await stageInputs(staged);
  const { assets } = stagedFiles;

  // 3. execute + poll
  log(`executing capability on the InDesign API…`);
  const statusUrl = await indesignExecute(tok, assets);
  const outputs = await indesignPoll(tok, statusUrl);
  log(`render complete — ${outputs.length} outputs`);

  // 4. write outputs back to AEM <folder>/output (unpublished → review)
  const outFolder = FOLDER + "/output";
  log(`writing outputs back to ${outFolder} (unpublished)…`);
  let up = 0;
  for (const o of outputs) {
    const name = String(o.src || o.url).split(/[\\/]/).pop().split("?")[0];
    if (name === "result.json") continue; // internal response-data file, not a deliverable
    const buf = Buffer.from(await (await fetch(o.url)).arrayBuffer());
    await aemUpload(outFolder, name, buf, mimeOf(name));
    up++;
    if (up % 10 === 0 || up <= 3) log(`  ↑ ${name}`);
  }
  log(`\n✓ done — ${up} outputs written to AEM ${outFolder} (unpublished, ready for your review).`);
  await stagedFiles.files.delete(stagedFiles.runPrefix + "/");
  log(`✓ cleaned up staged inputs`);
}

main().catch((e) => die(e?.stack || String(e)));
