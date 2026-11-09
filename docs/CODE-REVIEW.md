# Codebase Review & Critique

**Date:** 2026-11-09  
**Scope:** End-to-end review of `scripts/` (ExtendScript), `cloud/` (CLI harnesses), `aem-extension/` (App Builder UI + Runtime actions + Jest test suite), and `docs/`.

---

## 1. Executive Summary & Architectural Strengths

- **Functional core, imperative shell:** Most domain logic in `aem-extension/src/aem-assets-assetsview-1/actions/generate-idapi-banners/` (`preflight.js`, `psd.js`, `html5.js`, `images.js`, `classify.js`, `links.js`, `remap.js`, `relations.js`, `package.js`) is factored into pure, dependency-injected modules covered by **22 Jest test suites (223 unit tests)** that run in under 1 second.
- **Two-stage preflight gate:** Validating CSV structure, output names, pagemap, and image references before creating a job (Stage 1), followed by template-level checks inside InDesign (`generate_variations.jsx`) and Photoshop (`runPsdChecks`) on batch 0 before rendering variations (Stage 2), prevents wasted renders and silent layout bugs.
- **Durable batch orchestration:** Splitting CSV rows into small worker batches under the 600-second OpenWhisk activation cap, backed by deterministic job keys (`keyFor`), distributed state locks (`<stateKey>-lock`), stale-queue auto-waking in `generate-idapi-banners-status.js`, and an in-DAM `_idapi-job.json` manifest makes long renders resilient to browser closes and transient failures.
- **Scoped HMAC writeback for CM360 packaging:** `package.js` and `html5-writeback.js` use a short-lived, constant-time verified (`crypto.timingSafeEqual`) HMAC token bound to a single job, run ID, output folder, and expected 3-file tuple per ad so GitHub Actions never holds an AEM credential.

---

## 2. High-Priority Issues (Security & Correctness)

### [x] 2.1 Unauthenticated Web Actions When `AEM_SC_JSON` Is Configured
- **Locations:**
  - `aem-extension/src/aem-assets-assetsview-1/ext.config.yaml:47, 51, 79, 93`
  - `aem-extension/src/aem-assets-assetsview-1/actions/generate-idapi-banners/index.js:35-186`
  - `aem-extension/src/aem-assets-assetsview-1/actions/generate-idapi-banners/engine.js:185-190`
  - `aem-extension/src/aem-assets-assetsview-1/actions/generate-idapi-banners-status.js:24-78`
  - `aem-extension/src/aem-assets-assetsview-1/actions/generate-idapi-banners-package.js:32-56`
  - `aem-extension/src/aem-assets-assetsview-1/web-src/src/components/ModalIndesignBannersGeneration.js:239-400`
- **Finding:**
  1. **Publicly exposed worker action:** `generate-idapi-banners-worker` is declared with `web: 'yes'` in `ext.config.yaml:51`, exposing an unauthenticated `/api/v1/web/.../generate-idapi-banners-worker` URL. However, the worker is never called from the browser; it is only invoked internally via the authenticated OpenWhisk REST API (`/api/v1/namespaces/.../actions/...` with `Basic __OW_API_KEY` in `index.js:20`, `worker.js:208`, and `status.js:15`).
  2. **Missing caller authentication / authorization on start, preflight, and status:** Because `require-adobe-auth: true` deployed only `__secured_*` without the public route in this namespace (`ext.config.yaml:43-47`), web actions must validate the caller in-action. While `generate-idapi-banners-package.js:32-56` requires a caller bearer token and verifies `HEAD` access to `job.folder` in AEM with that token, `generate-idapi-banners/index.js` (for `preflight=1` and non-HTML5 modes) and `generate-idapi-banners-status.js` do not require a caller token when `AEM_SC_JSON` or `AEM_DEV_TOKEN` is configured—they immediately use the service credential in `aemContext()` (`engine.js:186-188`). Furthermore, `ModalIndesignBannersGeneration.js` only attaches `Authorization: Bearer <token>` on `html5`, `saveSite`, and `package` calls, sending empty `{}` headers on `inspect()`, `status`, and non-HTML5 `generate()` calls.
  3. **Folder path validation:** `params.folder` should be validated as a normalized `/content/dam/...` path without `..` segments before any AEM call.
- **Remediation:**
  - Set `web: 'no'` on `generate-idapi-banners-worker` in `ext.config.yaml` and explicitly document `require-adobe-auth: false` on the remaining browser-facing web actions.
  - Share `userBearer(params)` in `actions/utils.js` (reading `Authorization: Bearer ...` or fallback `params.userToken`) and require caller authentication + AEM folder access verification across `generate-idapi-banners`, `generate-idapi-banners-status`, and `generate-idapi-banners-package`.
  - Update `ModalIndesignBannersGeneration.js` to include the signed-in user's token on all action invocations (`inspect`, `generate` in all modes, and `status`).
  - Update `e2e/generate-idapi-banners.e2e.test.js` and unit tests to cover the in-action 401/403 checks.

### [x] 2.2 Missing URL Encoding on `completeUpload` in `engine.js`
- **Locations:**
  - `aem-extension/src/aem-assets-assetsview-1/actions/generate-idapi-banners/engine.js:141`
  - `cloud/aem-render.mjs:160, 174`
- **Finding:** In `engine.js:121`, `initiateUpload` URL-encodes each path segment of `folderDamPath` (`folderDamPath.split('/').map(encodeURIComponent).join('/')`), but `completeUpload` at line 141 interpolates raw `${author}${folderDamPath}.completeUpload.json`. If a campaign folder path contains spaces or special characters, `initiateUpload` and the binary `PUT`s succeed, and `completeUpload` fails.
- **Remediation:** Use segment-encoded paths consistently for both `initiateUpload` and `completeUpload` (matching `html5-writeback.js:57`).

### [x] 2.3 `setField()` in `generate_variations.jsx` Calls `setText()` on Graphic Frames When an Image Is Missing
- **Location:** `scripts/generate_variations.jsx:249-261`
- **Finding:** `setField()` checks `var image = U.shot(value); if (image.exists) { setImage(...); return; } setText(...);`. When running on desktop (where `preflightGate` is off) or in the cloud with `preflightOverride=1`, if a CSV cell for an image frame names a missing file, `setField()` falls through to `setText()` on a `Rectangle` / graphic frame, where `tf.texts[0]` throws and aborts the entire script run.
- **Remediation:** Check whether the target frame is a graphic frame (`resolveImageTarget(frame).graphic` or `frame.constructor.name !== "TextFrame"`) before falling back to `setText()`, and log a missing-image warning instead of crashing.

---

## 3. Medium-Priority Issues (Dead Code, Drift, & Performance)

### [ ] 3.1 Superseded / Unreachable HTML5 Slice Delivery Approval Pipeline
- **Locations:**
  - `aem-extension/src/aem-assets-assetsview-1/actions/generate-idapi-banners/da.js:88-143, 269, 272-320`
  - `aem-extension/src/aem-assets-assetsview-1/actions/generate-idapi-banners-worker.js:40, 91-99, 147-202`
  - `aem-extension/src/aem-assets-assetsview-1/actions/generate-idapi-banners-status.js:64-76`
  - `aem-extension/src/aem-assets-assetsview-1/web-src/src/components/ModalIndesignBannersGeneration.js:99-105, 347-364`
- **Finding:** `publishHtml5()` (`da.js:230-269`) writes static PNG slices directly into Document Authoring (`.<page>/static-N.png`) rather than AEM DAM, and returns `delivery: []`. Because `delivery` is always empty, the follow-up worker mode (`params.deliver = 1`, `deliverHtml5`, `approveWhenProcessed`, `waitDelivered`, `<stateKey>-delivery`, status polling, and UI status messages) is never triggered in production.
- **Remediation:** Remove the dead `<stateKey>-delivery` state machine and helpers (or repurpose it if auto-approving unapproved swapped DAM images is desired).

### [ ] 3.2 Drift & Duplication Across `scripts/`, `cloud/`, and `aem-extension/`
- **Locations:**
  - `cloud/run.mjs:117-194, 333-347`
  - `cloud/aem-render.mjs:79-192`
  - `aem-extension/src/aem-assets-assetsview-1/actions/generate-idapi-banners/engine.js:347-363`
- **Finding:**
  1. `cloud/run.mjs` still carries the drift listed in `HANDOFF.md` §7 Task A: `parseLib()` scrapes `var PAGES` from `brand_lib.jsx` instead of using the pagemap CSV, `computeOutputs()` hardcodes `.png` instead of `.jpg`/`.indd`/`.pdf`, `collectInputs()` misses `pagemap.csv` and `overlay_*.png`, and `buildJobPayload()` uses an outdated payload shape.
  2. `cloud/aem-render.mjs` is an early snapshot of `engine.js` with a naive `truncateCsv()` (`split("\n")`) that breaks on multi-line quoted CSV fields.
  3. `engine.js:347` (`truncateCsv`) re-implements a quote-aware character loop instead of reusing `csvRecords()` from `./csv.js`.
- **Remediation:** Refactor `engine.js:truncateCsv` to reuse `csvRecords()`, and align `cloud/run.mjs` and `cloud/aem-render.mjs` with the current contract.

### [ ] 3.3 Sequential Network I/O in `engine.js`
- **Locations:** `engine.js:378-389` (`stageInputs`), `engine.js:544-556`, `engine.js:709-727`, `engine.js:772-810`
- **Finding:** Within a single worker batch (600s Runtime limit), all DAM input downloads (`aemDownload`), all Adobe I/O Files writes and presigned URL generations (`stageInputs`), and all output uploads (`aemUpload` + `verifyAemAsset`) execute sequentially in `for...of` loops.
- **Remediation:** Introduce bounded concurrency (e.g., 4–6 concurrent operations, matching `probeImages` at `engine.js:232`) for input downloads and `stageInputs`.

### [ ] 3.4 ExtendScript `parameters` Escaped-Quote Parsing & `computeRoot()` Order
- **Locations:**
  - `scripts/brand_lib.jsx:112-127`
  - `scripts/generate_variations.jsx:168-179, 281-291`
- **Finding:**
  1. `paramFlag()` in `generate_variations.jsx:287` handles escaped quotes (`\\?"`) in `app.scriptArgs.get("parameters")`, whereas `writeIndd` (line 170), `writePdf` (line 178), and `workingFolder` (`brand_lib.jsx:115`) use unescaped quote regexes.
  2. `computeRoot()` in `brand_lib.jsx:120` checks the hardcoded fallback `CONFIG.projectRoot` (`/Users/pnam/Sandbox/ids-banner-auto-local`) *before* deriving the root from `$.fileName`, causing local runs in `idapi-banner-auto` to read/write the sibling repo unless `BRAND_PROJECT_ROOT` is set.
- **Remediation:** Use `paramFlag("writeIndd")` and `paramFlag("writePdf")` in `generate_variations.jsx`, allow optional escaped quotes on `workingFolder` in `brand_lib.jsx`, and check `$.fileName` before `CONFIG.projectRoot` in `computeRoot()`.

---

## 4. Low-Priority / Polish & Hygiene

### [ ] 4.1 ESLint Errors & Outdated E2E Test
- **Locations:**
  - `aem-extension/src/aem-assets-assetsview-1/actions/generate-idapi-banners/da.js:151:49` (`no-empty` on `catch (e) {}`)
  - `aem-extension/src/aem-assets-assetsview-1/e2e/generate-idapi-banners.e2e.test.js:12:7` (`no-unused-vars` on `packagejson`, plus outdated comment/assertion about `require-adobe-auth`)
- **Remediation:** Fix both ESLint errors so `npm run lint` exits 0, and align the E2E test with in-action auth.

### [ ] 4.2 Verbose Selection Logging & Dead Debug Fields in UI
- **Locations:**
  - `aem-extension/src/aem-assets-assetsview-1/web-src/src/components/ExtensionRegistration.js:58, 60`
  - `aem-extension/src/aem-assets-assetsview-1/web-src/src/components/ModalIndesignBannersGeneration.js:432-434`
- **Finding:** `ExtensionRegistration.js` logs `JSON.stringify(context)` and `JSON.stringify(resourceSelection)` on every selection change in Assets View, and `ModalIndesignBannersGeneration.js` references `job.count`, `job.rawSelection`, and `job.rawContext` which `readJob()` never populates.
- **Remediation:** Remove noisy `console.log` calls in `getActions` and clean up the dead debug fields in the modal.

### [ ] 4.3 HTML5 CM360 Zip Packaging Latency (Noted During Live Testing)
- **Locations:**
  - `banner-ads` `.github/workflows/package.yml` & `tools/package/run.mjs`
  - `aem-extension/src/aem-assets-assetsview-1/actions/html5-writeback.js`
- **Finding:** End-to-end CM360 zip generation takes a long time across size × row combinations (GitHub Actions runner startup + Playwright Chromium install + per-ad page load, budget-step image downloads, offline zip verification, GIF/storyboard frame capture, and writeback uploads).
- **Remediation (TODO):** Profile and optimize `tools/package/run.mjs` and `package.yml` (e.g., cache Playwright browsers in GitHub Actions, cache static slice buffers per size across rows, increase `PACKAGE_CONCURRENCY` or shard across workflow matrix jobs, and parallelize writeback uploads).
