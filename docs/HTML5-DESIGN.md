# HTML5 banners on Edge Delivery Services, from an InDesign template — design

**Status:** implemented (InDesign). This is the original design; where the build differs, the notes below say so, and
[HTML5-HOW-IT-WORKS.md](HTML5-HOW-IT-WORKS.md) describes the current behaviour. **Date:** 2026-11-03. **Scope:** InDesign first; Photoshop follows (§13).

**Decisions so far**

| topic | decision |
|---|---|
| Where ads live | AEM Edge Delivery Services (EDS) pages, authored in **Document Authoring** (da.live) |
| Variation rows | a **DA sheet** (the variations CSV, imported); Content Fragments are not used |
| Layers and images | swapped images: the **AEM DAM**, by Dynamic Media OpenAPI delivery URLs. Generated slices: stored in **DA** beside each page (see §5.1) |
| Layout source of truth | the **INDD**; re-running Generate rewrites geometry, and authors own copy and motion |
| Packaging | a headless browser in GitHub Actions; zips and visual renditions written back to the DAM |
| Packaging trigger | its own **"Package for CM360"** button, separate from Publish; publishing never packages, and packaging needs no publish |
| Fidelity failures | flag the ad, never block: the job and every other ad carry on |
| Fonts | out of scope for now: the starter repo's web fonts are used as they are, with no licensing check or raster fallback |
| Customer setup | we ship a **starter repo** (block, DA app, packaging workflow) |
| DA org and site | named per campaign folder in **`html5.json`** (`DA_ORG`, `DA_SITE`); there is no deployment default, so a folder without one can't run HTML5 |

**Goal:** turn the INDD template that already drives "Generate Banners" into **animated HTML5 ads that are
EDS pages**. Each ad can be previewed live on `aem.page`, its copy is edited in a DA sheet, and it is packaged
as a CM360-ready zip in the DAM. Every zip carries **visual renditions**: a backup image as its thumbnail, an
animated preview, a storyboard and a fidelity score.

Why EDS:

* **HTML is AEM's native medium.** The ad is a page, previewed and published with the same machinery as the
  rest of a site, and versioned in DA.
* **No AEM code deploy.** The code is a block (JS + CSS) in GitHub, shipped by the EDS code bus. The customer's
  AEM needs configuration only.
* **Visuals come built in.** Every size × row has a live URL that *is* the banner, animation included, in a real
  browser. Review, the gallery and packaging all use that one rendering.
* **One ad, more than one channel.** The same ad can be embedded on the customer's EDS pages and packaged for
  CM360.

---

## 1. Principles

1. **The template is the guide.** Sizes, positions, z-order, static artwork and type come from the INDD.
2. **One rendering, used everywhere.** The `ad` block renders the banner on `aem.page`, in the gallery and in the
   packaged zip. What a reviewer approves is what ships.
3. **The final frame equals the design.** Motion always animates *into* the designed layout, and the final frame
   is checked against the InDesign render of the same page and row (§8).
4. **Visuals are first-class.** No reviewer should need to download a zip to see an ad.
5. **Reuse the pipeline:** the same folder-as-key job, InDesign capability, batching, preflight, DAM upload,
   relations and renditions code.

---

## 2. Architecture

```
Assets View modal  "Generate HTML5 banners" button (under "Generate banners")
        │
        ▼
Runtime worker (engine.js)
  1 render ── InDesign API: JPG backups (existing) + layer export (new, §4)
  2 import
     ├─ AEM DAM   output/html5/assets/<size>/…   slices                (approved on upload)
     ├─ DA        /ads/<template>/<campaign>/variations     sheet  (from the variations CSV)
     │            /ads/<template>/<campaign>/<size>         one layout page per size, `ad` block (§5)
     └─ EDS admin preview → aem.page
        │
        ▼
Review: gallery of live ads (modal and DA app) ─ edit copy in the sheet, motion in the page
        │                                   │
        │  "Package for CM360" (button)     │  DA "Publish" (separate) ─► aem.live
        ▼                                   ▼  owned-channel embeds only (§12)
GitHub Actions (starter repo)  package.yml ─ Playwright on aem.page
  zip · weight budget · animated GIF · storyboard · fidelity score
        │
        ▼
Runtime writeback action ─► DAM output/html5/  zip (thumbnail = backup) + GIF + storyboard,
                                               metadata, relations
```

The user sees three steps:

1. **Generate.** The modal's **"Generate HTML5 banners"** button, directly under "Generate banners", starts the
   job. InDesign renders the JPGs as today and also exports each HTML5 page as layers. The worker
   puts the layers in the DAM, writes the sheet and one layout page per size into DA, and previews them.
2. **Review.** A gallery of live banners, one per size × row, opens in the Assets View modal when the job
   finishes, and also as an app inside DA (§8). Marketers fix copy in the sheet and adjust motion in the page;
   the gallery updates on the next preview.
3. **Package.** A separate **"Package for CM360"** button, in the gallery (modal and DA app), runs the
   packaging workflow (§7), which writes zips and their visuals back to the DAM. The marketer picks all ads or
   a selection of sizes × rows, and can package again at any time.

**Package and Publish are separate actions.** Publish is DA's own button: it puts the pages on `aem.live` for
embedding on the customer's site (§12). Package makes CM360 zips. Neither triggers the other, so an ad can be
packaged for CM360 without ever being published to the site, and republishing a page never makes new zips.

---

## 3. Template contract (InDesign additions)

Nothing changes for templates that don't want HTML5.

### 3.1 Pagemap columns

All HTML5 settings live in the pagemap. A third CSV in the job folder would be misread as the variations file by
`classify.js`.

| column | example | meaning |
|---|---|---|
| `html5` | `yes` | make an HTML5 ad for this page. Pages without it get none (social story, app card…). |
| `motion` | `hero:kenburns; headline:fadeUp@0.4; cta:pulse@1.6` | initial motion per element (§6) |
| `duration` | `8` | timeline length in seconds (default 6, capped at 30) |
| `loops` | `1` | plays (default 1, capped at 3); always stops on the final frame |
| `budgetKB` | `150` | zip weight budget (default 150) |

The banner size is the **InDesign page size**. Non-IAB sizes are allowed; whether a placement takes them is a
media-plan question.

### 3.2 Script Labels decide what is live

* A **labelled** item is an **element**: its own layer in the ad, bound to the sheet column of the same name,
  and animatable.
* **Unlabelled** items are **static artwork**. Consecutive unlabelled items in stacking order merge into one
  static slice (`static-0`, `static-1`, …), which keeps the z-order exact.

A label with no matching column is allowed, for example a fixed logo labelled only so it can animate.

### 3.3 Text is live

Labelled **text** frames become **live HTML text**: editable in the sheet, translatable, accessible and light.
The capability exports each frame's box and type styles (font, weight, size, leading, tracking, colour,
alignment, case). The fidelity check (§8) catches reflow differences.

**Fonts are out of scope for now.** The block uses whatever web fonts the starter repo's styles load, and the
zip carries those font files as they are. There is no licensing check, no subsetting and no raster fallback in
v1; see "Deferred" in §16.

### 3.4 Variations

The variations CSV is imported as the DA sheet `/ads/<template>/<campaign>/variations`, which EDS publishes as JSON. One
row is `{ outputFileName, <label>: value…, clickthrough }`. `clickthrough` is a reserved column, never a Script
Label: it becomes the zip's default `clickTag`. Image columns hold DAM file names as today and are resolved to
delivery URLs on import.

The click-through column fills no frame or layer, so the engine drops it (`dropClickthroughColumns`) from the CSV it
stages for the InDesign or Photoshop render, and preflight checks the same dropped CSV. Without that, the InDesign
script's column gate (`INDD_LABEL_UNMATCHED`) fails the job, and the registered capability would have to be
re-registered to exempt it. Only the DA sheet keeps the column.

The CSV may spell the click-through column several ways; on import it is always renamed to `clickthrough`, which
is the name the `ad` block reads. Names are compared ignoring case, spaces and punctuation, and match when they are:

* `clickthrough`, `clickthru`, `clicktag` or `landingpage`, alone or followed by `url`, `link` or `href`; or
* `click`, `cta`, `landing`, `destination` or `exit` followed by `url`, `link` or `href`.

So `clickthru`, `Click-Through URL`, `clickTag`, `cta-url`, `CTA Link` and `destination_url` all match, while `cta`
alone (the button text), `click`, `url` and `link` do not. When a row has more than one such column, the first
non-empty one wins. The lists live in `html5.js` (`CLICKTHROUGH_*`); the user-facing list is in
[`examples/README.md`](../examples/README.md#click-through-column). Keep the three in step.

After the first import, **the sheet is the source of copy for the HTML5 ads**. Re-running Generate does not
overwrite a sheet that marketers have edited (it reports the difference instead), so copy edits are never lost.

---

## 4. InDesign capability changes

A `writeHtml5` parameter on `generate_variations.jsx` (same capability, re-registered). For each page with
`html5=yes`:

* **Static slices.** Walk items back to front (parent-page items, then layers bottom-up, then items). For each
  unlabelled run, hide everything else, export the **whole page** as a transparent PNG at 2× (144 ppi), and
  restore. Exporting the whole page means the page edge clips exactly as in the JPG and effects are included.
  The Runtime trims the transparent margin and records the box. Static slices don't depend on the row, so they
  are exported **once per page**.
* **Image elements** (`hero`, `logo`, …): record the frame box, the clipping and the crop. The image itself is
  the DAM asset named in the row. The browser fits it with `object-fit: cover`, with the focal point mapped from
  the InDesign crop.
* **Text elements:** the frame box and type styles (§3.3).
* **Backup:** the existing page JPG per row, unchanged. It is the reference for the fidelity check.
* **Animation panel (optional):** where a labelled item has InDesign `animationSettings`, read the preset,
  duration and delay as its initial motion (spike S2).

`result.json` gains an `html5` block per page: `{ width, height, slices[], elements[{label, kind, box, style,
crop, anim}] }`.

---

## 5. DA content

### 5.1 Images by DAM delivery URL

> **As built:** generated slices are written to DA at `<page dir>/.<page>/static-N.png` and served by EDS,
> not uploaded to the DAM. Swapped images still use DAM delivery URLs, and an unapproved one is a warning
> (`HTML5_ASSET_NOT_DELIVERABLE`), not a job stop.

Every layer image is a DAM asset referenced by its Dynamic Media OpenAPI delivery URL (built from the asset
ID). The DAM keeps one asset of record, with rights metadata and relations.

* **Generated slices** go to `output/html5/assets/<size>/` and are set approved as they are uploaded. They are
  machine output from an INDD already in use, so review can start straight away.
* **Swapped images** (`hero`, …) are referenced where they sit in the job folder. They must already be
  approved for delivery; if one isn't, preflight stops the job before rendering (`HTML5_ASSET_NOT_DELIVERABLE`).

This needs **Dynamic Media with OpenAPI** on the customer's AEM program (enabled on the demo program; spike S4
checks latency and parameters).

### 5.2 One layout page per size

`/ads/<template>/<campaign>/<pagename>`, for example `/ads/<template>/fairbanks/web_med_rectangle_300x250`. The worker writes it
through DA's source API as HTML in which the `ad` block is a table with one row per layer:

| ad | | | | |
|---|---|---|---|---|
| size | 300x250 | duration 6 | loops 1 | rows `/ads/<template>/fairbanks/variations.json` |
| static-0 | image | *(delivery URL)* | 0,0,300,250 | none |
| hero | image | `{hero}` | 0,0,300,250 | kenburns |
| static-1 | image | *(delivery URL)* | 0,140,300,110 | none |
| headline | text | `{headline}` | 16,150,268,48 | fadeUp@0.4 · Sans Bold 22/24 #fff |
| cta | text | `{cta}` | 16,206,120,28 | pulse@1.6 · button |

* `{label}` binds a layer to the sheet column of the same name. A layer can also hold fixed text or a fixed DAM
  image.
* Geometry is in banner pixels. Authors may nudge a value or change a motion preset, with the live preview
  beside the table. Layout as a whole belongs to the INDD: re-running Generate rewrites the geometry and static
  layers, and keeps the motion cells that authors changed.

### 5.3 Rows by query, not by page

A layout page renders any row with `?v=<outputFileName>`: the block fetches the sheet JSON and fills the bound
layers. That is one page per size, not sizes × rows, so a layout fix applies to every row.
`aem.page/ads/<template>/fairbanks/web_med_rectangle_300x250?v=FAIR-EN-01` is the live, shareable preview of that ad.

---

## 6. The `ad` block (starter repo)

`blocks/ad/ad.js` + `ad.css`, a few hundred lines, no dependencies:

* builds a fixed-size stage (`position: relative; overflow: hidden`) with absolutely positioned layers in
  z-order, live text with the exported styles, and images from the delivery URLs;
* applies motion as **CSS keyframes** from a preset library. Every preset ends at the designed state:

| preset | does |
|---|---|
| `none` | visible from t=0 (static slices) |
| `fade` | opacity 0→1 |
| `fadeUp` / `fadeDown` | opacity + 12 px rise/fall |
| `slideLeft` / `slideRight` | enters from the side, clipped by the stage |
| `wipe` | `clip-path` reveal |
| `zoomIn` | scale 0.9→1 + fade |
| `kenburns` | scale 1.08→1 over the timeline (full-bleed image layers only) |
| `pulse` | after entry, scale 1→1.05→1 (CTA) |

  The syntax is `preset[@delay][/duration]`. With nothing set, the background is visible at t=0, `hero` gets
  kenburns, text gets `fadeUp` in reading order 0.3 s apart, and `cta` comes last with `pulse`;
* has two modes: `?v=` for preview, and `?export=cm360` for packaging. Export mode adds `ad.size` and `clickTag`,
  wraps the stage in the click-through anchor, and loads no page chrome, RUM or other external scripts;
* exposes `window.adTimeline` (`{duration, seek(t)}`) so packaging can step through the animation frame by frame.

Out of scope for v1: multi-frame storytelling. Numbered labels (`headline.1`, `headline.2`) could add it later.

---

## 7. Packaging (GitHub Actions + Playwright)

The starter repo carries `package.yml`. Only the "Package for CM360" button starts it: the button calls the
worker, which sends a `repository_dispatch` event carrying the job, the selected sizes and rows, and the DAM output
folder. Publishing does not start it. A real browser renders the ads, so the zip and the visuals come from
exactly what reviewers saw.

For each size × row:

1. Open `aem.page/…/<size>?v=<row>&export=cm360` in headless Chromium: the preview reviewers approved, so
   no publish is needed.
2. **Zip:** serialise the decorated DOM to `index.html`, inline the CSS, keep only the keyframes used, download
   each image and font file into the zip and rewrite its path. Drop the EDS page scaffolding (`aem.js`,
   `scripts.js`, header and footer) and the EDS Content-Security-Policy meta: its nonce-based `script-src` blocks
   the `javascript:window.open(clickTag)` click-through, so in export mode on `aem.page` the click does nothing
   until the zip is built. The request log must show nothing but the zip's own files.
3. **Weight budget:** images are fetched from the delivery URLs with width, quality and format parameters,
   stepping down quality, then 2× → 1.5× → 1× size, until the zip fits `budgetKB`. The steps taken are recorded.
   Still over at the lowest step: preflight error.
4. **Visuals:** `adTimeline.seek(t)` plus screenshots produce the **animated preview** (GIF, 12 fps), the
   **storyboard** (6 keyframes with timestamps) and the **final frame**.
5. **Fidelity:** compare the final frame with the InDesign backup JPG for that page and row (RMSE; ≤ 0.02 pass,
   ≤ 0.05 warn, above that failed). A failure **flags that ad only**: its zip and visuals are still written,
   marked failed in metadata and in the gallery, and every other ad in the job packages as normal.
6. **Write back** through a small `html5-writeback` Runtime action that reuses the existing upload, renditions
   and relations code, so GitHub never holds AEM credentials.

The CM360 essentials checked in each zip: `index.html` at the root, `<meta name="ad.size">`, a `var clickTag`
opened with `window.open(clickTag)`, relative paths only, a backup image, and duration × loops ≤ 30 s. Confirm
these against the current CM360 HTML5 spec in spike S5.

---

## 8. Visual renditions and review

| visual | where | made by |
|---|---|---|
| **Live ad** | `aem.page` / `aem.live`; preview pane beside the DA page | the `ad` block in a browser |
| **Gallery** | Assets View modal after Generate, and a **DA app** ("Ad gallery") next to the sheet: iframes for every size × row, a replay button, weight and fidelity under each, a fidelity-failed filter, and the **"Package for CM360"** button (all or selected) | the same URLs |
| **Backup / final frame** | renditions of the `.zip` (`cq5dam.thumbnail.*`, `cq5dam.web.1280.1280.jpeg`, via `renditions.js` `attachPreview`), so the zip has a real thumbnail in the grid | InDesign backup JPG |
| **Animated preview** | `<page>_<row>_preview.gif`, related to the zip | Playwright frames |
| **Storyboard** | `<page>_<row>_storyboard.jpg`, related to the zip | Playwright keyframes |
| **Fidelity** | metadata on the zip (sortable); a preflight finding when it fails | final frame vs backup |

Reviewers watch the ads live before packaging. After packaging, the DAM asset shows a thumbnail, an animation
and a storyboard. Nobody unzips anything. In the DA app, a marketer can edit a row in the sheet and watch every
size update after preview.

---

## 9. AEM output, metadata, relations, preflight

```
<job folder>/output/
  WEB_MED_RECTANGLE_300x250_FAIR-EN-01.jpg            existing (= backup)
  html5/cm360/
    WEB_MED_RECTANGLE_300x250_FAIR-EN-01.zip          thumbnail = backup
    WEB_MED_RECTANGLE_300x250_FAIR-EN-01_preview.gif
    WEB_MED_RECTANGLE_300x250_FAIR-EN-01_storyboard.jpg
```

> **As built:** packaging outputs go to `output/html5/cm360/`; slices live in DA, not `output/html5/assets/`.
> Going over budget is a warning, not an error.

* **Metadata on the zip:** size, bytes, budget steps, clickthrough, duration and loops, fidelity score, DA page
  URL, row id, source template.
* **Relations** (`relations.js`): template → zip `derived`; zip ↔ backup, preview, storyboard and swapped images
  `other`.
* **Preflight additions** (same gate and format):

| code | severity | when |
|---|---|---|
| `HTML5_NO_PAGES` | error | HTML5 requested, no `html5=yes` page |
| `HTML5_MOTION_UNKNOWN` | error | unknown preset, or a role not labelled on that page |
| `HTML5_TOO_LONG` | error | duration × loops > 30 s |
| `HTML5_NO_SITE` | error | the campaign folder has no usable `html5.json` naming its DA org and site (§11.1) |
| `HTML5_NO_EDS_SITE` | error | the named site has no EDS project behind it (§11) |
| `HTML5_DA_NO_ACCESS` | error | the user cannot write to the resolved DA org and site (§11.1) |
| `HTML5_ASSET_NOT_DELIVERABLE` | error | a swapped image is not approved for delivery |
| `HTML5_NO_CLICKTHROUGH` | warn | no row has a click-through URL (no accepted column, §3.4, or all its cells empty) |
| `HTML5_SHEET_EDITED` | warn | the DA sheet differs from the CSV; the sheet is kept |
| `HTML5_OVER_BUDGET` | error, after packaging | over budget at the lowest step |
| `HTML5_FIDELITY` | warn, after packaging | fidelity above the warn threshold; flags that ad only, never blocks the job |

---

## 10. Content model notes

* **Copy lives in the DA sheet**, with DA's version history. DA's translation tooling works on sheets and pages,
  so a language is one more sheet (or one more column set) and needs no new code.
* **Content Fragments are not used.** If a customer insists, a later adapter can fill the sheet from AEM's
  fragment delivery API; the block stays the same.
* The JPG/INDD path could later read rows from the same sheet, so one row source would drive static and HTML5
  banners alike.

---

## 11. Customer setup: the starter repo

We ship `banner-ads`, an EDS starter repo the customer (or a teammate running the demo) forks into their GitHub
organisation:

* `blocks/ad/` — the block, motion presets and tests;
* `tools/ad-gallery/` — the DA app;
* `.github/workflows/package.yml` — packaging, plus a secret holding the writeback action's key;
* EDS and DA config pointing at the customer's AEM, with their DA org and site.

### 11.1 Which DA org and site (per campaign folder)

Each campaign folder names its own EDS / DA site in an **`html5.json`** file in the AEM folder, next to the
template and the variations CSV. Nothing else decides it: there is no deployment default and no fallback to the
demo site, so one user's HTML5 run can never write into another user's DA org or EDS site.

```json
{ "DA_ORG": "pnamadobe", "DA_SITE": "banner-ads" }
```

| key | required | default | meaning |
|---|---|---|---|
| `DA_ORG` | yes | — | DA org; also the GitHub owner of the site's repo |
| `DA_SITE` | yes | — | DA site; also the repo name |
| `DA_ADS_ROOT` | no | `/ads` | where campaign folders go inside the site |
| `EDS_REF` | no | `main` | branch used in preview URLs: `https://<ref>--<site>--<org>.aem.page/ads/…` |
| `GITHUB_REPO` | no | `<DA_ORG>/<DA_SITE>` | only set when the repo name differs from the DA org and site |
| `EYEBROW_RATIO` | no | `0.35` | HTML5 text sizing: a text layer directly above the page's largest text, in its column, is raised to at least this share of its size; its box grows upward into free space only. `0` = off |
| `TEXT_SCALE` | no | none | `{ "<layer label>": factor }` (0.25 to 4) sizes named text layers in the HTML5 pages; overrides the eyebrow rule for them |

Names are validated (no path tricks, `GITHUB_REPO` must be `owner/repo`). The file is read with the app's AEM
credentials whenever the site is needed: preflight, job start, the worker's DA step and Package for CM360.

* **No `html5.json`** (or one that is empty, not JSON, or missing `DA_ORG` / `DA_SITE`): the modal shows "No EDS
  site is set for this folder yet" (or why the file found can't be used) and asks for the **DA org** and **DA
  site**, plus which folder to save it on (the campaign folder or one above it; folders below inherit it). Generate
  HTML5 stays disabled until a site is saved; the start action refuses with 422 `HTML5_NO_SITE` before anything
  renders. The other Generate modes are not affected.
* **Save site** (start action with `saveSite=1`, code in `site.js`) runs entirely as the signed-in user: it lists
  the site in DA (`admin.da.live/list/<org>/<site>`; 401/403/404, or `x-da-actions` without `write`, refuse the
  save), checks the site serves `blocks/ad/ad.js` on `main--<site>--<org>.aem.page` (a 404 refuses; sign-in or
  network errors don't), then writes `html5.json` into the chosen folder with the user's AEM token, keeping any
  other keys already in it. AEM folder permissions therefore decide who can set a folder's site.
* Creating the site (repo, Code Sync, DA site, permissions) is not done in the modal: the
  [setup guide](HTML5-SETUP.md) is written so a user (or Claude pointed at this repo) can follow it end to end.
* Once set, the modal shows "Publishing to **org/site** (set on <folder>) · change", so nobody writes into the
  wrong site by mistake; **change** reopens the picker.

Identity:

* DA writes and the EDS preview run **as the signed-in user** (their IMS token, passed to the worker in the
  invocation only and never stored), so writing into a site the user has no access to fails with
  `HTML5_DA_NO_ACCESS`. Who can write is controlled in DA's own permissions (`da.live/config#/<org>/`) and the
  site's admin access config.
* `DA_TOKEN` / `EDS_ADMIN_TOKEN` on the worker override the user's token. **Don't set them in a multi-user
  deployment**: every user's writes would then go as the operator, into any site an html5.json names.
* `GITHUB_DISPATCH_TOKEN` (deployment secret) starts `package.yml` in the folder's repo. Package for CM360 for
  another site's repo needs a dispatch token that can reach that repo.

For a teammate, follow [HTML5-SETUP.md](HTML5-SETUP.md): repo from `banner-ads`, AEM Code Sync, DA site, write
access, the site saved from the dialog (or `html5.json` uploaded by hand), and dispatch-token access to their repo for
packaging. The packaging workflow needs no repo secret; the writeback token travels in the dispatch payload.

### 11.2 The modal

The modal's button stack becomes:

```
[ Generate banners ]                         existing
[ Generate HTML5 banners ]                   new: HTML5 ads + the JPG backups they need
[ Generate banners + editable file ]         existing
[ Editable INDDs only (no flattened images) ] existing
[ Cancel ]
```

* "Generate HTML5 banners" always renders the JPGs too: each zip needs its backup image, and the fidelity check
  compares against it.
* The site from the folder's `html5.json` is shown under the button; with no `html5.json` the button is disabled
  and says why.
* For Photoshop jobs, the button shows but is disabled, labelled "InDesign templates only for now", until §13
  lands.
* The results screen after an HTML5 job shows the gallery and the **"Package for CM360"** button.

### 11.3 On the AEM side
* **Dynamic Media with OpenAPI** enabled on the program.
* The Runtime worker's inputs gain the GitHub dispatch token; DA writes use the job's IMS token (spike S3).

Compared with today's extension, which adds nothing to AEM, this adds a GitHub repo and an EDS site, but still no
Java deploy.

## 12. Activation

* **CM360, phase 1:** download the zip (and the backup JPG if asked) from the DAM and upload to CM360. The
  clickTag is set at trafficking.
* **CM360, later:** push through the Trafficking API from the writeback action, and store the CM360 creative id on
  the zip.
* **Owned channels:** embed the live ad on any of the customer's EDS pages with the fragment block. Same block,
  same sheet, no zip.

---

## 13. Photoshop (next)

Only the layer export changes. The PSD path already calls `generate-manifest`, which gives each layer's id and
frame per artboard (`docs/PSD-DESIGN.md`). Runs of unnamed layers become static slices via `create-composite`,
named text layers carry their type styles, and named smart-object layers become image elements. Everything from
§5 onwards is shared. Estimate 1–1.5 weeks after InDesign.

---

## 14. Spikes (about 1 week)

| # | question | pass looks like |
|---|---|---|
| S1 | Slice export on InDesign Server: hide/restore incl. parent items, transparent 144 ppi PNG, z-order walk, type-style read-out, time per export | 10-page template exported; static-run merge matches the JPG |
| S2 | Is `animationSettings` readable on InDesign Server? | presets and delays read back |
| S3 | From a Runtime action: write a DA page and sheet via the DA source API, preview via the EDS admin API, IMS auth for both | a layout page live on `aem.page` |
| S4 | Dynamic Media OpenAPI on the program: delivery URLs for freshly approved slices, latency until deliverable, width/quality/format parameters, licensing | slices load in the preview within seconds of upload |
| S5 | Packaging: a Playwright-built zip passes the published CM360 HTML5 rules and Google's HTML5 validator (no CM360 account for the demo); AEM keeps a direct-binary zip as one asset; which animated rendition Assets View plays (GIF vs WebP) | screenshots |
| S6 | Live-text fidelity: exported InDesign type styles vs the browser, using the starter repo's fonts | RMSE within the warn threshold on the sample template |

## 15. Plan and effort (one engineer)

| phase | scope | estimate |
|---|---|---|
| 0 | Spikes S1–S6 | ~1 week |
| 1a | Starter repo: `ad` block, motion presets, `?v=` and `?export=` modes, tests | 1–1.5 weeks |
| 1b | Capability `writeHtml5`; importer (DAM layers, DA sheet and pages, preview) | 1.5 weeks |
| 1c | Packaging workflow (zip, budget, GIF, storyboard, fidelity) and writeback action | 1.5 weeks |
| 1d | Modal "Generate HTML5 banners" button and gallery, DA gallery app, preflight codes, metadata/relations/renditions, e2e tests | 1 week |
| 2 | Photoshop layer export | 1–1.5 weeks |
| 3 | CM360 Trafficking API push (optional) | 1.5–2 weeks |

InDesign to packaged, reviewable HTML5 ads: **about 6–6.5 weeks**, including spikes.

### Tests

* Block unit tests: motion parsing, keyframe generation, layer layout, export-mode markup (`ad.size`, `clickTag`,
  no external URLs).
* Worker unit tests: manifest → DA page HTML, CSV → sheet, sheet-edited detection, budget stepping, fidelity
  scoring.
* E2E: the debranded template with `html5=yes` on the IAB pages, run through generate, preview, packaging and
  writeback; assert zips, renditions, relations and fidelity.
* Manual: CM360 sandbox upload and preview.

## 16. Open questions

1. **Starter repo hosting beyond the demo:** the demo folders name `pnamadobe/banner-ads` in their `html5.json` (§11.1). For customers, a public
   Adobe template repo, or shared privately per customer?

Settled: the DA org and site come only from each campaign folder's `html5.json`, with no deployment default; packaging has its own button, separate
from Publish; a failed fidelity check flags the ad and never blocks the job.

### Deferred

* **Fonts:** licensing for ads served on third-party sites, glyph subsetting to save weight, and a raster
  fallback for text whose font cannot ship. Not in v1.
