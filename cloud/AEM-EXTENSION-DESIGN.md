# AEM Assets View — Banner Automation Extension (Design)

**Status:** design / plan (no code yet). **Date:** 2026-09-08.
**Goal:** a one-click "Generate Banners" action in the **AEM Assets View** browse
Action Bar. User selects one asset in a folder → the extension renders every
banner size for that folder's creative rows (the existing `generate_variations.jsx`,
run on the **InDesign API / Firefly Services**) → writes JPGs + `output.indd` back
into the folder's `output/` subfolder.

This is the target end state for Phase 2b (supersedes the "AEM custom workflow step"
idea in HANDOFF §7). It also **resolves storage decision #3: storage is AEM itself.**

---

## 1. Folder-as-key convention (the contract)

The user selects **one asset**; the extension uses that asset's **parent folder**
as the job key. Everything is discovered by convention from that folder:

| Role | Discovery rule |
|---|---|
| InDesign template | the `.indd` whose filename contains **`template`** (case-insensitive) |
| Variations CSV | a `.csv` **without** `pagemap` in the name (no other filename check) |
| Page-map CSV | the `.csv` whose filename contains **`pagemap`** |
| Images | **all** image files directly at the folder level (not in subfolders) |
| Output target | the child **`output/`** folder — JPGs + `output.indd` land here |

Notes / edge cases to enforce in the resolver:
- Ignore the `output/` subfolder when gathering images/inputs (don't feed prior outputs back in).
- Exactly one template, one pagemap CSV, one variations CSV expected → validate count, fail with a clear message if 0 or >1.
- Image set = every renderable asset at folder root; the `.jsx` already resolves
  hero names against `assets/shots/` **and** `shots/square/` locally, so the cloud
  resolver must map the flat AEM folder onto whatever paths the CSV `hero` column
  uses (see §6 open item — hero path mapping).

---

## 2. Extension point (VERIFIED against live docs)

- **Surface:** AEM Assets View (the unified Assets experience), Browse View Action Bar.
- **Extension point ID:** `aem/assets/assetsview/1` — the unified point that serves
  both Browse View and Details View. (Older `aem/assets/browse/1` still works for
  existing extensions; use the unified one for a new build.)
- **Method:** `getActions(context, resourceSelection, resources)` — the host calls
  this **every time the selection changes**. It must return fast and **must not make
  backend calls** (the host blocks Action Bar render on it). So: build the button
  synchronously here; do the heavy lifting in the click handler → Runtime action.
- **Namespaces:** an extension must implement **both** `actionBar` **and**
  `quickActions` to be recognized for these customizations.
- **Registration:** SPA registers via `@adobe/uix-guest` `register(...)`, same model
  as the Content Fragment Console action-bar extensions.
- **Entitlement:** Assets View UI extensibility requires **Assets Ultimate** and is
  gated behind an **Adobe Customer Support case** to enable for the org. ✅ Already
  enabled on the target env (owner has stood up Assets View extensions here before).

Docs:
- Enable UI extensibility in AEM Assets View — experienceleague (`.../assets/assets-view/aem-assets-view-ui-extensibility`)
- Browse View / Details View API references — Adobe Developer (developer.adobe.com/uix)

---

## 3. Architecture (three components)

```
┌─────────────────────────────────────────────────────────────────┐
│ AEM Assets View (host, browser)                                  │
│   Browse Action Bar ──[Generate Banners]──┐                      │
└───────────────────────────────────────────┼─────────────────────┘
                                             │ selection + repo/folder ctx
                                 ┌───────────▼───────────┐
                                 │ 1. UI Extension SPA   │  @adobe/uix-guest
                                 │    (Spectrum React,    │  getActions()/onClick()
                                 │     hosted on Adobe I/O)│  optional modal (progress)
                                 └───────────┬───────────┘
                                             │ invoke (IMS user token)
                                 ┌───────────▼───────────┐
                                 │ 2. Adobe I/O Runtime  │  ← this is cloud/run.mjs
                                 │    action: generate-  │    logic, refactored
                                 │    banners            │
                                 └──┬─────────┬──────────┘
                        AEM tech    │         │  InDesign S2S creds
                        acct token  │         │
                        ┌───────────▼──┐   ┌──▼───────────────────┐
                        │ 3a. AEM      │   │ 3b. InDesign API     │
                        │  Assets HTTP │   │  indesign.adobe.io/v3│
                        │  API (list,  │   │  custom-script exec  │
                        │  download,   │   │  runs generate_      │
                        │  upload)     │   │  variations.jsx      │
                        └──────────────┘   └──────────────────────┘
```

1. **UI extension (the button).** Registers the Action Bar button; on click, collects
   the selected asset + AEM repo id + folder path and calls the Runtime action.
   Optionally opens a Spectrum modal showing progress/result. Runs in the user's IMS
   session. No secrets here.
2. **Runtime action (`generate-banners`).** The compute seam — this is essentially the
   current `cloud/run.mjs` refactored into an I/O Runtime action. Keeps the InDesign
   S2S secret and the AEM technical-account creds **server-side** (never in the browser),
   avoids CORS. Resolves the folder, submits the job, polls, writes results back.
3. **AEM Assets I/O + InDesign API.** The two backends the action talks to.

**Why a Runtime action, not browser→InDesign direct:** the InDesign API needs an IMS
**S2S** token (server credential) + `x-api-key`; putting that secret in browser JS
would leak it, and browser→`indesign.adobe.io` would hit CORS anyway. This mirrors
Adobe's own reference pattern (CF bulk-update: modal → Runtime action → HTTP calls).

---

## 4. End-to-end flow

1. User selects the folder's anchor asset in Assets View, clicks **Generate Banners**.
2. UI extension's `onClick` sends `{ repositoryId, aemHost, folderPath, selectedAssetId }`
   to the `generate-banners` Runtime action (+ the user's IMS token for audit).
3. Runtime action authenticates:
   - **AEM**: technical-account service credentials → bearer token (jcr:read on the
     folder, rep:write on `output/`).
   - **InDesign API**: OAuth Server-to-Server (the FFS creds already in `cloud/.env`).
4. Action lists the folder via the **AEM Assets HTTP API** (`GET /api/assets.json{path}`),
   applies the §1 rules → resolves template, both CSVs, image set, `output/`.
5. Action produces a **fetchable URL per input** (see §5) and assembles the InDesign
   custom-script job payload (§7), passing `BRAND_*` values via `params`.
6. Action **submits** to `indesign.adobe.io/v3` custom-script execution, gets a status
   URL, **polls** to completion.
7. InDesign runs the **unchanged** `generate_variations.jsx`; outputs land in the job's
   working dir and are uploaded to the configured output storage (§5).
8. Action **writes outputs back** into the folder's `output/` via AEM direct-binary
   upload (initiate → PUT → complete).
9. Action returns a summary (counts, overset warnings from the run log) → modal shows it.

---

## 5. Storage & auth (decision #3 = AEM) — VERIFIED schema, one nuance

The InDesign custom-script payload takes, per asset, a `source: { storageType, url }`
where `storageType ∈ {AWS S3, Azure, Dropbox, GCP, Box, Frame.io}` and `url` is a
**pre-signed** URL. Outputs (`outputs: [OutputAsset]`) support S3/Azure/Dropbox; if
omitted, outputs go to **Adobe temporary storage** (Azure blob) with a **24-hour**
pre-signed URL.

**Inputs — chosen approach: AEM pre-signed / delivery URLs.** Two viable sources of a
URL InDesign can fetch:
- **Dynamic Media (OpenAPI) delivery URLs** — public https, no auth; requires the
  folder's assets to be approved/delivery-enabled. Cleanest when available.
- **AEM direct-download pre-signed URLs** — AEM CS stores binaries in Azure blob, so a
  pre-signed GET is effectively an **Azure** URL → map to `storageType: azure`.

  ⚠️ **Dependency to verify at build:** confirm AEM hands the Runtime action a
  pre-signed **GET** URL for an original binary (OpenAPI Assets download), and that
  InDesign accepts it. If neither delivery URLs nor pre-signed GETs are available for a
  given folder, fall back to the **relay**: action downloads via the `content` rel link
  (AEM bearer) → uploads to Adobe temp/Azure → passes that pre-signed URL to InDesign.

**Outputs — write back via AEM direct-binary upload (not a raw presigned PUT).** AEM's
upload is a **3-step handshake** (initiate → PUT to cloud storage → complete/notify so
Asset Compute processes it). InDesign writing straight to a presigned PUT would satisfy
the PUT but skip the *complete* step. So: let InDesign write outputs to **Adobe temp
storage** (omit `outputs`, collect the 24h URLs) or an Azure container the action owns,
then the action performs the proper AEM upload into `output/` using the **`aem-upload`**
Node library (`DirectBinaryUpload`). This is the reliable path and keeps outputs correctly
ingested/renditioned in AEM.

**Auth summary**
| Backend | Credential | Where |
|---|---|---|
| InDesign API | OAuth Server-to-Server (FFS_CLIENT_ID/SECRET) | Runtime action env |
| AEM Assets (read+write) | Technical-account service credentials (JSON from AEM Developer Console → Integrations; jcr:read + rep:write on the folder) | Runtime action env |
| Assets View host | User's IMS session | Browser (SPA) |

---

## 6. Reuse of the existing pipeline

The whole point of the local design holds: the **same `generate_variations.jsx` runs
unchanged**. `computeRoot()` resolves the root from the script's own location, and all
options come in via `$.global.BRAND_*`. The Runtime action becomes the orchestrator
that the local `run_local.sh` / `run.mjs` were.

Concretely, the Runtime action is **`cloud/run.mjs` refactored**:
- Replace `collectInputs()` (local FS walk) with **AEM folder listing** + §1 rules.
- Replace `computeOutputs()` naming with the current `pageNameOf()` semantics
  (pagemap → padded fallback) — this is HANDOFF §7 **Task A**, still required, now
  sourced from the AEM pagemap CSV.
- Keep `getAccessToken()` (IMS S2S), the payload assembly, `pollJob()`, download.
- Implement the storage seam per §5 (`uploadInput()` / `makeOutputTarget()` → AEM).
- Pass `BRAND_FORMAT`, `BRAND_WRITE_INDD`, `BRAND_CSV`, `BRAND_PAGEMAP`,
  `BRAND_TEMPLATE` through the InDesign `params` object.

**Open item — hero path mapping.** Locally the CSV `hero` column resolves against
`assets/shots/` and `shots/square/`. In the flat AEM folder, images sit at the folder
root. Decide one of: (a) require the CSV `hero` values to match the AEM filenames
directly, or (b) have the resolver strip/normalize the `shots/…` prefixes when building
the InDesign working-dir `destination` paths so the `.jsx` finds them unchanged. Prefer
(b) so the template/CSV don't have to change between local and cloud.

---

## 7. InDesign API payload (VERIFIED shape)

`POST https://indesign.adobe.io/v3` custom-script execution (script pre-registered → Script ID):

```jsonc
{
  "assets": [
    { "source": { "storageType": "azure", "url": "<presigned GET for template.indd>" },
      "destination": "template/brand-template.indd" },
    { "source": { "storageType": "azure", "url": "<presigned GET for variations.csv>" },
      "destination": "input/brand-variations.csv" },
    { "source": { "storageType": "azure", "url": "<presigned GET for pagemap.csv>" },
      "destination": "input/brand-pagemap.csv" },
    { "source": { "storageType": "azure", "url": "<presigned GET for hero-1.jpg>" },
      "destination": "assets/shots/hero-1.jpg" }
    /* …every image + both .jsx scripts (generate_variations.jsx, brand_lib.jsx)… */
  ],
  "params": {
    "BRAND_FORMAT": "jpg",
    "BRAND_WRITE_INDD": "1",
    "BRAND_CSV": "input/brand-variations.csv",
    "BRAND_PAGEMAP": "input/brand-pagemap.csv",
    "BRAND_TEMPLATE": "template/brand-template.indd"
  },
  "outputs": [ /* omit → Adobe temp (24h presigned); or Azure/S3 target */ ]
}
```

- `destination` is a path in the job working dir; **no `..` or leading `/`**, must be a
  valid filename. Mirroring the local layout (`template/`, `input/`, `assets/shots/`,
  `scripts/`) is what lets `computeRoot()` work unchanged.
- Scripts (`generate_variations.jsx`, `brand_lib.jsx`) are shipped as **input assets**
  too, OR pre-registered as the custom script bundle. Decide at build (registered bundle
  is cleaner + versioned; assets-per-run is simpler to iterate). ⚠️ verify how the
  script bundle vs. `assets[]` scripts interact.
- **Fonts** (HANDOFF Task D): include `template/Document Fonts/` files as input assets so
  InDesign auto-activates them (Source Sans 3, OFL — safe to bundle).

---

## 8. Provisioning / prerequisites checklist

- [x] **Assets Ultimate** entitlement + **Support case** to enable Assets View UI extensibility. *(already enabled on the target env.)*
- [x] InDesign API — provisioned on **stage** (2026-09-08); prod pending.
- [ ] Adobe Developer Console **App Builder** project (can be the same project holding the InDesign S2S credential).
- [ ] AEM **technical account** service credentials with jcr:read + rep:write on the target folder tree.
- [ ] AEM environment has **OpenAPI-based Assets APIs** enabled (per-env modernization) if using pre-signed download/delivery URLs.
- [ ] `aio` CLI installed; Node ≥ 18.

## 9. Build steps (after this design is approved)

1. `aio app init` in a new subproject → template **All Extension Points** → choose the
   **AEM Assets View** UI extension template. ⚠️ confirm exact template package name at
   init (the CF one is `@adobe/aem-cf-admin-ui-ext-tpl`; the Assets View equivalent is
   selected from the same picker).
2. Implement `ExtensionRegistration.js`: `getActions()` returns the **Generate Banners**
   button for `actionBar` (+ a `quickActions` entry); `onClick` opens the modal / invokes
   the action.
3. Implement the `generate-banners` Runtime action (refactor of `cloud/run.mjs` per §6).
4. Wire storage seam per §5; add `aem-upload` dependency for write-back.
5. Local test with `aio app run` against stage AEM + stage InDesign API on the 2-row
   `brand-variations-TEST.csv`.
6. Deploy (`aio app deploy`), submit the extension for org approval, enable via Extension
   Manager for the target environment.

## 10. ⚠️ Verify-at-build items (carried forward)

- Exact Assets View UI-extension **template package** name in the `aio` picker.
- Whether AEM issues a pre-signed **GET** an InDesign `source` will accept, vs. needing
  the relay (§5).
- Script **bundle registration** vs. shipping `.jsx` as per-run assets (§7).
- InDesign **submit response shape** + polling field (already flagged in HANDOFF Task B;
  `run.mjs pollJob()` currently guesses).
- Custom-script capability **endpoint/version** path under `indesign.adobe.io/v3`.

---

## 11. Verified InDesign API mechanics (2026-09-08, live on stage)

Confirmed by hitting the stage API with the IMSS service token:

- **Host:** `https://indesign-stage.adobe.io` (stage). Prod: `https://indesign.adobe.io`.
- **Register a capability (custom script):** `POST /v3/capability`, `multipart/form-data`,
  field name **`file`** = the ZIP bundle. Returns `{ url, capability }` where `url` is the
  execution endpoint, e.g. `https://…/v3/<ID>/<capability-name>`.
- **Bundle:** zip WITHOUT a parent folder, containing `manifest.json` + the entry `.jsx`
  (+ helper `.jsx` files). Real `manifest.json` shape (NOT my first guess):
  ```json
  {
    "manifestVersion": "1.0.0",
    "name": "idapi-banner-exporter",
    "host": { "app": "indesign", "minVersion": "16.0.1", "maxVersion": "99.9.9" },
    "version": "1.0.0",
    "apiEntryPoints": [
      { "type": "capability", "path": "generate_variations.jsx", "language": "extendscript" }
    ]
  }
  ```
- **Execute:** `POST <execution url>`, `application/json`, body `{ assets, params, outputs? }`.
  `assets[].source` accepts a plain `{ "url": "<presigned/public URL>" }` (storageType optional);
  `assets[].destination` = working-dir path. Response: `{ "statusUrls": "https://…/v3/status/<jobId>" }`.
- **Poll:** `GET /v3/status/<jobId>` → states not-started / running / completed / failed.
- **Headers (service token):** `Authorization: Bearer`, `x-api-key: <client_id>`,
  `x-gw-ims-org-id: <org>` (required — GET returns 400 without it, 200 with it).
- **Storage:** inputs MUST be real cloud-storage presigned URLs (S3/Azure/Dropbox/GCS/AEM);
  Adobe temporary storage is **outputs-only** (omit `outputs` → 24h presigned result URLs).
- `run.mjs` defaults to update for the build: register `POST /v3/capability`; the
  current `INDESIGN_SCRIPT_PATH=/v3/capabilities/script` guess is wrong.

## 12. ⛔ Current blocker — writes rejected (org/entitlement)

The stage IMSS service token authenticates and **reads** fine (`--ping` GET = 200), but
every **write** (`POST /v3/capability` register, and by extension execute) returns
**400 `{"message":"Unable to get the IMS Organization …","errorCode":"invalid_parameters"}`** —
tried the org via `x-gw-ims-org-id` header, `?imsOrgId=` query, and an `orgId` form field;
all identical. GET honors the same header (400 without → 200 with), so it is not a header
placement issue.

Root cause (hypothesis): the org (`4A603BC061E191130A495FEF@AdobeOrg`, "Adobe Internal
Peter Nam") is **not entitled to Firefly Services**, so the API allows reads but blocks
writes — the same gap as the Dev Console "License required." A bare `system` service token
can't supply the org entitlement the write path needs.

Ways forward:
1. **Get the org entitled to Firefly Services (FFS SKU)** — Admin Console product assign, or
   request via Slack `#adobeio-developer-console` / DL `idservices@adobe.com`. Then writes work.
2. **Use an already-entitled org** — test the **prod** `pnam-ffs-api` client against prod
   `indesign.adobe.io` (needs prod permanent-auth-code + prod IMS + that org's id). If the
   prod org is FFS-entitled, register/execute should succeed there.
3. Confirm with `idservices@adobe.com` whether a `system` service token is even supported for
   capability writes, or whether an OAuth S2S (Dev Console) credential is required.
