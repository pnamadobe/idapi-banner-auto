# Team Setup Guide — Banner Automation (InDesign API → AEM Assets View)

How to stand this up in **your own** IMS org + AEM environment. Each teammate
provisions their own org; nothing here is shared infrastructure.

**What you'll end up with:** a "Generate Banners" button in AEM Assets View. Select
a folder that holds an InDesign template + a variations CSV + a pagemap CSV +
images, click the button, and a full set of on-brand banners is rendered headless
by the Adobe InDesign API and written back into the folder's `output/` subfolder
(unpublished, for your review).

**Architecture:** AEM Assets View extension (button) → Adobe I/O Runtime action →
[read AEM folder → stage inputs to presigned storage → InDesign API renders →
write outputs back to AEM]. The engine is `cloud/aem-render.mjs`; the same logic
runs inside the Runtime action.

Estimated time once entitlements are in place: ~1–2 hours. The **entitlement**
(Part 1) is the long pole — start it first.

---

## Prerequisites

- Adobe employee, Node ≥ 18, `git`.
- An **IMS org** where you can get the Firefly Services product (Part 1).
- An **AEM as a Cloud Service** environment (dev/stage) you have Developer access to.
- **App Builder** access in that org + the `aio` CLI (`npm i -g @adobe/aio-cli`).
- A cloud storage bucket you can make presigned URLs from (Azure Blob or AWS S3).
- The `magick` CLI (ImageMagick) only if you want to build showcase collages.

---

## Part 1 — Firefly Services entitlement (the gating step) ⏳

The InDesign API is part of **Firefly Services (FFS)**. Your IMS org must have the
FFS product, which lights up the **InDesign API** tile in Adobe Developer Console.

1. Open [Adobe Developer Console](https://developer.adobe.com/console) → create/pick
   a project → **Add API**. If **InDesign API** is greyed **"License required,"**
   your org isn't entitled yet.
2. Getting entitled (internal): Firefly Services is provisioned per org — work with
   your **business/GTM team** to get a demo org set up with Firefly Services, **or**
   use an existing demo/enablement org that already has it. There is also a lighter
   internal sandbox intake path — check your internal Firefly access documentation.
3. **Done when:** the InDesign API tile is selectable (not greyed) in Dev Console.

> This is the same gate as everything else — until the org has FFS, no InDesign
> API credential can be created. Don't burn time on later parts until this clears.

---

## Part 2 — Dev Console OAuth Server-to-Server credential

Custom-script registration on the InDesign API accepts **only** a Developer Console
**OAuth Server-to-Server** token (not an IMS service token).

1. Dev Console → your project → **Add API → InDesign API (Firefly Services)**.
2. Choose credential type **OAuth Server-to-Server**.
3. Record the **Client ID**, **Client Secret**, and the **Scopes** shown.
4. Note the environment: the **production** console (`developer.adobe.com`) →
   prod IMS + `https://indesign.adobe.io`. (A stage console → stage hosts.) The
   token env and the InDesign host must match, or you get `invalid_client` / 401.

---

## Part 3 — Presigned storage for inputs

The InDesign API fetches inputs from **URLs it can reach unauthenticated**. AEM
author can't serve those directly, so we stage inputs in a presigned bucket.

**Azure Blob (simplest — the SAS is both the upload cred and the read URL):**
1. Create a Storage account → a **container** (e.g. `banner-inputs`, private).
2. Container → **Shared access tokens** → permissions **Read, Add, Create, Write,
   List**, HTTPS only, a few days' expiry → **Generate SAS token and URL**.
3. Keep the container blob endpoint + the SAS query string.

(AWS S3 also works — `cloud/run.mjs` has an `s3` seam; you'd generate presigned
GET URLs for inputs.)

---

## Part 4 — AEM environment + developer token

1. **Cloud Manager** → your Program → **Environments** → open the target env's
   **Developer Console**.
2. **Integrations** tab → service **author** → **Get Local Development Token** →
   copy the `accessToken` (valid ~24h). For a durable/App-Builder credential use
   **Service Credentials** instead (technical account).
3. Note the **author URL**: `https://author-p<program>-e<env>.adobeaemcloud.com`.

> The App Builder extension must be created in **the same IMS org that owns this
> AEM environment**, or it won't appear in that AEM's Assets View.

---

## Part 5 — Configure `cloud/.env`

```bash
cp cloud/.env.example cloud/.env
```
Fill in (never commit `.env` — it's gitignored):

```ini
# InDesign API — OAuth S2S (Part 2). Leave FFS_AUTH_CODE empty so client_credentials is used.
FFS_CLIENT_ID=<dev console client id>
FFS_CLIENT_SECRET=<dev console client secret>
FFS_AUTH_CODE=
FFS_ORG_ID=<your IMS org id, ...@AdobeOrg>
IMS_ENDPOINT=https://ims-na1.adobelogin.com/ims/token/v3     # prod
INDESIGN_API_BASE=https://indesign.adobe.io                  # prod (match the token env)
CAPABILITY_VERSION=1.0.0

# Presigned storage (Part 3)
STORAGE_MODE=azure
AZURE_BLOB_BASE=https://<account>.blob.core.windows.net/<container>?<SAS query>

# AEM (Part 4)
AEM_AUTHOR_URL=https://author-p<program>-e<env>.adobeaemcloud.com
AEM_DEV_TOKEN=<local development token>
```

---

## Part 6 — Register the capability

```bash
node cloud/run.mjs --check-auth     # should mint a bearer token
node cloud/run.mjs --register       # 201; prints an execution URL
```
Copy the execution URL into `cloud/.env` as `INDESIGN_EXECUTE_URL=…`.
(Re-registering later needs a NEW `CAPABILITY_VERSION`, else 422 "already exists.")

---

## Part 7 — Build a job folder in AEM and run the engine

In AEM Assets, create a folder (this is the "key") containing:

| Item | Rule |
|------|------|
| InDesign template | filename contains **`template`**, ends `.indd` |
| Variations CSV | a `.csv` (columns: `outputFileName,hero,city,header`) |
| Pagemap CSV | filename contains **`pagemap`** (`pagenumber,pagename`) |
| Hero images | the `.jpg/.png` referenced by the variations CSV |
| `output/` | an empty subfolder for results |

Then render (start with 1 row to smoke-test):

```bash
node cloud/aem-render.mjs --folder /content/dam/<program>/<job-folder> --run --max-rows 1
```

The engine reads + classifies the folder, stages inputs to your bucket, executes
the InDesign API, and writes outputs back to `<folder>/output` **unpublished**.
Confirm they appear in AEM, then drop `--max-rows` for the full set.

**Fonts:** `cloud/fonts/` holds Source Sans 3 (OFL), bundled automatically for
deterministic type. Adobe Fonts are present on the InDesign API servers, but
bundling guarantees exact output and is required for any non-Adobe brand font —
drop your brand's font files in `cloud/fonts/`.

---

## Part 8 — App Builder extension

```bash
aio login                        # pick the enterprise profile for the right org
aio app init aem-extension       # in the repo root
```
- Select the org that owns your AEM env, the project, and a Stage/dev workspace.
- Templates → **All Extension Points** → **`@adobe/aem-assets-assetsview-ext-tpl`**
  (extension point `aem/assets/assetsview/1`).

The Runtime action + the "Generate Banners" button live under `aem-extension/`
(the action ports `cloud/aem-render.mjs`; the FFS/Azure/AEM values become action
inputs/secrets). Then:

```bash
cd aem-extension
aio app deploy
```
Finally, enable the extension in your AEM env's Assets View (Assets View → the
extensions/config entry for your App Builder app), and the **Generate Banners**
button appears on the folder action bar.

---

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| InDesign API greyed **"License required"** | Org lacks FFS — Part 1. |
| Token error **`invalid_client`** | Prod vs stage mismatch — token env must match `IMS_ENDPOINT` + `INDESIGN_API_BASE`. |
| `--register` → **422 already exists** | Bump `CAPABILITY_VERSION`. |
| Job fails **"Script didn't return anything"** | Capability-script contract — no `#target`, return a JSON package with `assetsToBeUploaded` + `dataURL`, avoid desktop-only API calls. |
| AEM write-back **"fetch failed …comundefined"** | Direct-binary upload: bare block `PUT` (no `x-ms-blob-type`); build the complete URL as `<folder>.completeUpload.json` yourself. |
| `aio app init` **"No organizations found"** | `aio logout --force` then `aio login --force`; sign out of Adobe in the browser first and pick the **enterprise** profile. |
| Extension not visible in Assets View | App Builder project must be in the **same org** as the AEM env; deploy + enable the extension for that env. |

---

## Reference

- `cloud/run.mjs` — auth, `--register`, capability bundling.
- `cloud/aem-render.mjs` — the folder-driven engine (read → stage → render → write-back).
- `cloud/AEM-EXTENSION-DESIGN.md` — full design + verified API mechanics (local/internal).
- `examples/` — a brand-neutral worked example (template contract, sample CSVs).
