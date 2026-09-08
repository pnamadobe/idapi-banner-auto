# Cloud harness (Phase 2a)

Runs the **same** `scripts/generate_variations.jsx` on the Adobe InDesign API
(Firefly Services) that we run locally — proving the cloud runtime before any
AEM wiring. Zero npm dependencies; needs **Node ≥ 18**.

## Modes

```bash
node cloud/run.mjs --dry-run      # default — assemble & print the plan, no creds
node cloud/run.mjs --check-auth   # fetch an IMS token and report (needs creds)
node cloud/run.mjs --submit       # full run: auth → upload → submit → poll → download
```

`--dry-run` writes `cloud/_dryrun/{inputs,outputs,job-payload}.json` so you can
inspect exactly what would be sent. It also parses the 10 size names + default
hero straight out of `scripts/united_lib.jsx`, so the harness can never drift
from the InDesign side.

## Setup

1. `cp cloud/.env.example cloud/.env` and fill in `FFS_CLIENT_ID` / `FFS_CLIENT_SECRET`
   from your Developer Console **OAuth Server-to-Server** credential (InDesign API added).
2. Confirm the scope string (`FFS_SCOPES`) shown on that credential.
3. `node cloud/run.mjs --check-auth` → should print a token. This validates creds
   in isolation before anything else.

## Folder / working-dir contract

Inputs are mirrored into the job's working directory preserving the local layout
(`template/`, `assets/shots/`, `assets/brand/`, `scripts/`, `input/`, `output/`).
`computeRoot()` in `united_lib.jsx` resolves the root from the running script's
own location (`…/scripts/<file>` → parent-of-parent), so the identical `.jsx`
works locally and in the cloud with no edits.

Inputs collected automatically: the template, the lockup, the CSV, both scripts,
the default hero, every hero referenced by the CSV, and any font files under
`template/Document Fonts/` or `assets/fonts/`.

## Fonts

InDesign auto-activates fonts placed in a **`Document Fonts`** folder next to the
document — so drop the Source Sans 3 files in `template/Document Fonts/` and they
travel with the job. Source Sans 3 is OFL (safe to bundle). United's licensed
brand face is a separate licensing decision.

## Storage (the one piece to finalize)

The InDesign API downloads inputs from URLs and writes outputs to URLs. Where
those live is **decision #3** (Adobe temporary storage vs your own S3/Azure vs
referencing AEM DAM delivery URLs directly). Until chosen, `uploadInput()` and
`makeOutputTarget()` in `run.mjs` are deliberate stubs that stop `--submit` with
a clear message rather than guessing. Wire them for the chosen `STORAGE_MODE`.

## ⚠️ VERIFY against current InDesign API docs

Marked inline in `run.mjs`. The parts I could not re-confirm live this session:

- `INDESIGN_API_BASE` + `INDESIGN_SCRIPT_PATH` (custom-script capability endpoint)
- the job **asset JSON schema** (`assets[].source`/`destination`, `script`, `outputs[]`)
- the submit response shape (where the **status URL** lives) — `pollJob()` reads
  a few common fields; adjust to the real one
- the exact **scope** string

Everything else — IMS auth, CSV parsing, input gathering, output-name
computation, polling loop, download — is final.
