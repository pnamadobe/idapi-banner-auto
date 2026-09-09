# Cloud harness

Runs the **same** `scripts/generate_variations.jsx` on the Adobe InDesign API
(Firefly Services) that we run locally — proving the cloud runtime before any
AEM wiring. Single file, **zero npm dependencies**, needs **Node ≥ 18**.

## Modes

```bash
node cloud/run.mjs --dry-run      # default — assemble & print the plan, no creds
node cloud/run.mjs --check-auth   # fetch an IMS token and report (needs creds)
node cloud/run.mjs --ping         # GET /v3/scripts reachability probe (reads)
node cloud/run.mjs --register     # register the script as an InDesign capability
node cloud/run.mjs --submit       # full run: auth → upload → execute → poll → download
```

`--dry-run` writes `cloud/_dryrun/{inputs,outputs,job-payload}.json` so you can
inspect exactly what would be sent. It also parses the size names + default hero
straight out of `scripts/brand_lib.jsx`, so the harness can never drift from the
InDesign side.

## Auth — registration requires a Developer Console token

> **Important:** custom-script/capability **registration is privileged** — the
> InDesign API accepts it **only** from a Developer Console **OAuth
> Server-to-Server** token. An IMSS service token works for reads (`--ping`,
> `--check-auth`) but is rejected on the write path with
> `400 "Unable to get the IMS Organization"`. The Developer Console project only
> appears once the IMS org is entitled to the Firefly Services product.

Setup:

1. `cp cloud/.env.example cloud/.env`.
2. From Adobe Developer Console → an **InDesign API – Firefly Services** project →
   **OAuth Server-to-Server** credential, set `FFS_CLIENT_ID` / `FFS_CLIENT_SECRET`.
   Leave `FFS_AUTH_CODE` **empty** so the harness uses `client_credentials`.
3. Set `FFS_ORG_ID` (the `…@AdobeOrg` id) — sent as the required `x-gw-ims-org-id`
   header — and point `INDESIGN_API_BASE` / `IMS_ENDPOINT` at the matching env
   (stage token → stage host, prod → prod).
4. `node cloud/run.mjs --check-auth` → prints a token, validating creds in isolation.

## Register, then submit

```bash
node cloud/run.mjs --register
#   → POST /v3/capability with the bundled script; returns an execution `url`.
#   Paste it into cloud/.env:  INDESIGN_EXECUTE_URL=<that url>

node cloud/run.mjs --submit
#   → uploads inputs, POSTs the job to the execution url, polls, downloads outputs
```

`--register` builds the bundle in-memory — a zero-dependency `STORE` zip of
`manifest.json` + `generate_variations.jsx` + `brand_lib.jsx` at the root (the
layout the InDesign API requires) — and posts it as multipart field `file`.

## Verified API mechanics

Confirmed live against the InDesign API:

- **Register:** `POST /v3/capability`, `multipart/form-data`, field `file` = the
  bundle zip. Returns `{ url, capability }` where `url` is the execution endpoint.
- **Execute:** `POST <execution url>`, `application/json`, body `{ assets, params,
  outputs? }`. `assets[].source` accepts `{ "url": "<presigned/public URL>" }`;
  `assets[].destination` is the working-dir path. Returns `{ statusUrls }`.
- **Poll:** `GET /v3/status/<jobId>` → not-started / running / completed / failed.
- **Headers:** `Authorization: Bearer …`, `x-api-key: <client_id>`,
  `x-gw-ims-org-id: <org>` (required).

## Folder / working-dir contract

Inputs are mirrored into the job's working directory preserving the local layout
(`template/`, `assets/shots/`, `assets/brand/`, `scripts/`, `input/`, `output/`).
`computeRoot()` in `brand_lib.jsx` resolves the root from the running script's
own location, so the identical `.jsx` works locally and in the cloud with no edits.

Inputs collected automatically: the template, the lockup, the CSV, both scripts,
the default hero, every hero referenced by the CSV, and any font files under
`template/Document Fonts/` or `assets/fonts/`.

## Fonts

InDesign auto-activates fonts placed in a **`Document Fonts`** folder next to the
document — so drop the font files in `template/Document Fonts/` and they travel
with the job. Source Sans 3 is OFL (safe to bundle); a brand's licensed typeface
is a separate licensing decision.

## Storage (the one piece to finalize)

The InDesign API downloads inputs from URLs and writes outputs to URLs. Where
those live is a deployment decision (Adobe temporary storage vs your own
S3/Azure vs AEM delivery/presigned URLs). Adobe temporary storage is
**outputs-only** — omit `outputs` and the API returns 24h presigned result URLs;
inputs must be real cloud-storage URLs. Until wired, `uploadInput()` and
`makeOutputTarget()` in `run.mjs` are deliberate stubs that stop `--submit` with
a clear message rather than guessing. Wire them for the chosen `STORAGE_MODE`.
