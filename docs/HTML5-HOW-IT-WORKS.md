# HTML5 banners: how it works

This page explains how **Generate Banners → HTML5** and **Package for CM360** turn an InDesign template into
animated HTML5 ads and CM360-ready zips. It covers what you need before you start, how to author the template,
and what happens at each step:

1. how the InDesign API reads and changes the `.indd`;
2. how the AEM extension builds the Edge Delivery Services (EDS) pages in Document Authoring (DA);
3. how variations (CSV rows) map onto those pages;
4. how packaging builds the zips.

For the one-time site setup, see [HTML5-SETUP.md](HTML5-SETUP.md). For the original design and its reasoning,
see [HTML5-DESIGN.md](HTML5-DESIGN.md). For the InDesign API, AEM and extension setup, see
[SETUP.md](../SETUP.md).

---

## Overview

```
 AEM Assets View: campaign folder
   template.indd · variations.csv · pagemap.csv · images · html5.json
        │
        │  Generate Banners → HTML5
        ▼
 App Builder action (generate-idapi-banners)
   stages inputs ─────────────────► InDesign API (capability: generate_variations.jsx)
                                        • reads the template's live layers (Script Labels)
                                        • bakes everything else into transparent PNG slices
                                        • writes a layout manifest (result.json "html5")
   ◄──────────── slices + manifest ─┘
        │
        │  publishHtml5 (as the signed-in user)
        ▼
 Document Authoring (da.live)  <org>/<site>/<template>/<style>/
   variations.json        (the CSV as a DA sheet, image cells = Dynamic Media delivery URLs)
   <page>                 (one page per html5 size, holding an `ad` block)
   <page>-static-N.png    (the slices, alongside the pages — no per-size subfolders)
        │  EDS preview
        ▼
 https://main--<site>--<org>.aem.page/<template>/<style>/<page>?v=<row>
        │
        │  Package for CM360 (repository_dispatch → GitHub Actions in your site repo)
        ▼
 banner-ads/.github/workflows/package.yml → tools/package/run.mjs (Playwright)
   per size × row: export page → inline + shrink assets → zip → offline render
   → GIF preview + storyboard → fidelity check → CM360 checks
        │  html5-writeback action (signed, short-lived token; no AEM token in GitHub)
        ▼
 AEM: <job output>/html5/cm360/<page>_<row>.zip, _preview.gif, _storyboard.jpg (+ metadata)
```

The INDD stays the source of truth for the layout. The DA sheet holds the copy, which authors may edit. The
`ad` block in your site repo runs the animation.

---

## Requirements

| What | Why | Where it is set up |
|---|---|---|
| **InDesign API** (Firefly Services entitlement) and an OAuth Server-to-Server credential | runs the render script in the cloud | [SETUP.md](../SETUP.md) Parts 1–2 |
| **The registered capability** (`scripts/generate_variations.jsx`) | the render and the HTML5 export | [SETUP.md](../SETUP.md) Part 6 |
| **AEM as a Cloud Service, Assets View**, with the App Builder extension deployed | the button, the job, writing outputs back | [SETUP.md](../SETUP.md) Parts 4 and 8 |
| **Dynamic Media with OpenAPI** on the AEM program | swapped images in the HTML5 ads are delivery URLs | AEM program configuration |
| Swapped images **approved for delivery** | only approved assets get a delivery URL | AEM: set the asset status to Approved |
| **An EDS site** made from [`banner-ads`](https://github.com/pnamadobe/banner-ads), with AEM Code Sync and a DA site | the `ad` block, the motion presets and the packaging workflow | [HTML5-SETUP.md](HTML5-SETUP.md) Steps 1–3 |
| **Write access to the DA site** for the user who runs Generate | pages are written and previewed as that user | [HTML5-SETUP.md](HTML5-SETUP.md) Step 4 |
| **`html5.json`** on the campaign folder (or a folder above it) | names the DA org and site; there is no default | [HTML5-SETUP.md](HTML5-SETUP.md) Step 5 |
| **GitHub Actions** enabled on the site repo | runs `package.yml` | the repo's Actions settings |

### Deployment settings (packaging)

These are set in the extension's deployment environment (`.env`, never committed). Only the names are listed
here.

| Name | Used by | What it is |
|---|---|---|
| `GITHUB_DISPATCH_TOKEN` | Package for CM360 | fine-grained GitHub token with **Actions: read and write** and **Contents: read** on each site repo |
| `HTML5_WRITEBACK_SECRET` | package + writeback actions | random secret that signs the short-lived writeback token |
| `HTML5_WRITEBACK_URL` | package action (optional) | public URL of the `html5-writeback` web action; defaults to the Runtime namespace URL |
| `ASSETS_VIEW_TENANT` | status + package actions (optional) | Assets View tenant name, used to build the "Open in Assets View" links |
| `DA_TOKEN`, `EDS_ADMIN_TOKEN` | publish (optional) | service tokens for DA and the EDS admin API. Without them, the signed-in user's token is used, which is the normal setup |

The GitHub workflow itself needs **no secrets**. Its payload carries only the ad list and the signed writeback
token, which is valid for 2 hours for that one run.

---

## Authoring the template

HTML5 reuses the same template, variations CSV and page map as the JPG banners. A few rules decide what becomes
a live, animatable layer and what is baked into a picture.

### Page map columns

The page map is any `*.csv` in the folder with `pagemap` in its name. It has `pagenumber` and `pagename` columns
(without a page map, pages are named by number). HTML5 adds these optional columns:

| Column | Default | Meaning |
|---|---|---|
| `html5` | every page | `y`, `yes`, `true`, `1` or `x` makes this page an HTML5 ad. Without the column, every page is |
| `motion` | none | `;`-separated `label:preset[@delay][/duration]`, e.g. `hero:kenburns; headline:fadeUp@0.4/0.6` (seconds) |
| `duration` | `6` | length of one loop, in seconds |
| `loops` | `1` | how many times it plays (at most 3; `duration × loops` must be 30 s or less) |
| `budgetKB` | `150` | target zip size. Going over is a warning, not an error |

Motion presets: `none`, `fade`, `fadeUp`, `fadeDown`, `slideLeft`, `slideRight`, `wipe`, `zoomIn`, `kenburns`,
`pulse`. Authors can change motion later in the DA page; a re-run keeps their changes.

### Whole-banner animation styles

On the **HTML5 banners** confirmation screen (after the DA org and site are confirmed), the **Animation style**
dropdown chooses a choreography for every layer that has no explicit pagemap or DA-authored motion, and
publishes into `/<template>/<style>`:

| Style (`id`) | Dropdown label | Choreography |
|---|---|---|
| `editorial` *(default)* | Subtle / Editorial (Airlines, financial services, healthcare, B2B) | `hero`: `kenburns` (or `fade`); body in reading order (`0.3 s` step): `fadeUp` (text) / `fade` (images); `cta`: `pulse` |
| `luxury` | Luxury / Cinematic (Hospitality, fashion, luxury retail, automotive) | `hero`: `kenburns` (or `zoomIn`); body (`0.45 s` step, `0.9 s` entry): `fadeDown` on lead text, `fade` on rest; `cta`: `fade` |
| `kinetic` | Bold / Kinetic (Sports, entertainment, tech launches, events) | `hero`: fast `zoomIn`; body (`0.18 s` step, `0.35 s` entry): alternating `slideLeft` / `slideRight`; `cta`: fast `pulse` |
| `retail` | Retail / Promo (Sales, QSR, e-commerce, loyalty offers) | `hero`: `zoomIn`; body (`0.25 s` step, `0.45 s` entry): `zoomIn` on lead/images, `fadeDown` on rest; `cta`: `pulse` |
| `wipe` | Clean Wipe / Split (Modern SaaS, telecom, travel destinations) | `hero`, body (`0.25 s` step, `0.5 s` entry), and `cta`: geometric `wipe` reveals |
| `minimal` | Minimal / Compliance-Safe (Pharma, regulated finance, strict brand guidelines) | `hero`, body (`0.35 s` step, `0.4 s` entry), and `cta`: pure opacity `fade` (no translation or scale) |

### Script Labels decide what is live

* A frame is **live** when its Script Label matches a column name in the variations CSV. Live text stays real
  HTML text; live images become `<img>` layers bound to the sheet.
* Everything else (backgrounds, logos, decoration, unlabelled text) is **baked** into transparent PNG slices.
* A labelled frame whose label is **not** a CSV column is baked too.
* **Groups are baked whole.** A labelled frame inside a group is baked, with the warning "baked into a static
  slice". Ungroup live frames.
* Hidden items, and items on hidden or non-printing layers, are skipped.
* Master page items land in the back-most slice only.
* For live text, the export reads the font family and weight, italic, size, leading, colour, alignment, caps,
  tracking, vertical alignment, the frame's fill (as a background) and corner radius. A labelled text frame
  whose label starts with `cta` and that has a fill becomes a **button**.
* For live images, it reads the box and the focal point of the crop, so the swapped image is cropped the same
  way in HTML.
* Rotated frames keep their angle.

### Paragraph styles per page

For the JPG render, text gets a paragraph style named after its column, taken from a paragraph style group named
after the page (for example the group `WEB_MED_RECTANGLE_300x250` holding a `headline` style). This lets one
column be styled differently per size.

---

## 1. How the InDesign API reads and changes the INDD

The App Builder action stages the template, the CSVs and any images to presigned storage, then calls the
InDesign API with the `generate_variations.jsx` capability. The script runs headless in InDesign Server.

**HTML5 export (once per run, before any rows).** When the HTML5 output is requested, the script works on the
template's own design, not on a CSV row:

1. It reads the page map and picks the `html5=yes` pages.
2. It lists each page's items from back to front, keeping only top-level items and skipping hidden ones.
3. It splits them into **live** items (label matches a CSV column) and **non-live** items.
4. Each run of consecutive non-live items becomes one slice: the script hides every other item and exports a
   transparent PNG at 144 dpi (`<page>--static-N.png`). The master page is detached after the first slice, so
   master items are in slice 0 only.
5. It writes a manifest for each page: the size, the slices (file, z order, box) and the live elements (label,
   kind, z order, box in page pixels, rotation, and the text style or image crop described above).

The manifest goes into `result.json` under `html5`, and a diagnostic block goes into `_run_log.txt`.

**JPG/PNG render (per CSV row).** For each row, page and column, the script finds the frame by its Script Label:

* If the cell names an image file, it relinks or places it, fits it proportionally, centres it, and keeps the
  label.
* Otherwise it sets the frame's text and applies the paragraph style for that page and column. Overset text is
  reported as a warning.

It then exports `<pagename>_<outputFileName>.jpg` (or `.png`), plus an `.indd` per row or a PDF if those outputs
are requested.

An HTML5-only run needs no JPG render. In that case the script gets a header-only CSV and only does the export.
The HTML5 export runs in the first batch only. It needs all rows later, so the full CSV is kept for the sheet.

---

## 2. How the AEM extension builds the EDS pages

After the render, the action publishes to the DA org and site named by the nearest `html5.json`. Every write
runs as the user who clicked Generate, unless the deployment sets service tokens.

Content goes under `/<template>/<style>` (or `<DA_ADS_ROOT>/<template>/<style>` when `DA_ADS_ROOT` is set in
`html5.json`; `<template>` is the slugged name of the template file and `<style>` is the animation style chosen in
the Generate HTML5 banners modal: `editorial`, `luxury`, `kinetic`, `retail`, `wipe` or `minimal`):

1. **The variations sheet** (`variations.json`). The full CSV is written as a DA sheet. Cells that name an image
   are replaced with that asset's **Dynamic Media delivery URL**. An image that is not approved gets the warning
   `HTML5_ASSET_NOT_DELIVERABLE`.
   * If an author has edited the sheet in DA since the last run, the sheet is **kept** and you get
     `HTML5_SHEET_EDITED`. To reset it, delete the sheet in DA and run again.
2. **The slices** go right inside `/<template>/<style>/` as `<page>-static-N.png` (no per-size subfolders) and
   are served by EDS.
3. **One page per html5 size** (`<page>`, the slugged page name). Each holds an `ad` block. If the page already
   exists, its motion cells are read first, so author edits to motion are kept. Layout (boxes, z order, styles)
   always comes from the INDD.
4. Text sizes may be adjusted for the web: a small line right above the largest text ("eyebrow") is raised to
   `EYEBROW_RATIO` of its size, and `TEXT_SCALE` scales named layers. Both are set in `html5.json` and only
   affect the HTML5 ads.
5. Everything is previewed on EDS. The modal lists the preview links.

The `ad` block on the page is a table:

```
| ad                                                                                    |
| size     | 300x250 | duration 6       | loops 1      | rows /ads/<tmpl>/<campaign>/variations.json |
| static-0 | image   | <slice URL>      | 0,0,300,250  | none        |                  |
| hero     | image   | {hero}           | 0,0,300,250  | kenburns    |                  |
| headline | text    | {headline}       | 20,30,260,60 | fadeUp@0.4  | <font, size, colour…> |
```

Each layer row is: name | kind | source | `x,y,w,h` | motion | style. `{label}` binds the layer to that sheet
column; slices are referenced by their URL in the site. Authors can edit the motion cell in DA.

In the browser, the block ([`banner-ads/blocks/ad/ad.js`](https://github.com/pnamadobe/banner-ads/blob/main/blocks/ad/ad.js)):

* loads the sheet and picks the row whose `outputFileName` matches `?v=`;
* fills `{label}` text and images from that row, scales delivery images to the needed width, and only allows
  `http(s)` links;
* plays the motion presets on a timeline exposed as `window.adTimeline` (`seek`, `play`, `restart`), which
  packaging uses to take frames;
* with `?export=cm360`, adds the `ad.size` meta tag, a `var clickTag` and a click handler that calls
  `window.open(window.clickTag)`.

---

## 3. How variations work

* **One CSV row = one variation.** The `outputFileName` column names it, and the same name is used for the JPG,
  for `?v=` on the preview page and for the zip.
* **One page per size, not per row.** A campaign with 4 HTML5 sizes and 50 rows has 4 DA pages and 1 sheet.
  `?v=<row>` picks the row at view time, so 200 ads need no extra pages.
* **Text columns** whose label is live become live text. **Image columns** become delivery URLs.
* **Click-through.** One column gives the landing URL. Its name is matched loosely: `clickthrough`, `clickthru`,
  `clickTag` or `landingpage`, or a name starting with `click`, `cta`, `landing`, `destination` or `exit` and
  ending in `url`, `link` or `href` (for example `cta-url`, `landing_page_url`). The first non-empty one wins. If
  there is none, you get `HTML5_NO_CLICKTHROUGH` and the ads do not click through. Click-through columns are
  left out of the JPG render.
* **Editing copy.** Edit the row in the DA sheet and preview it. Re-running Generate keeps an edited sheet (see
  above). Edit the CSV and delete the sheet when you want the CSV to win again.

---

## 4. How packaging to zips works

**Package for CM360** in the modal is separate from publishing. It packages what is on the preview pages now.

**In AEM (the package action):**

1. It builds the ad list: every html5 size × every variation row, up to 200 ads. Each ad is named
   `<page>_<row>` and is paired with its JPG as the backup image, if that JPG was rendered.
2. It records a package run in App Builder State (kept for 7 days) and signs a writeback token for it (valid
   2 hours, for this job, run and output folder only).
3. It sends a `repository_dispatch` (`event_type: package`) to the site repo with the ad list and the token.

**In GitHub Actions ([`package.yml`](https://github.com/pnamadobe/banner-ads/blob/main/.github/workflows/package.yml) → `tools/package/run.mjs`):**

The workflow runs with read-only repo permissions, installs Node and Playwright Chromium (with npm and browser caching), writes the payload to a
file (it is never printed), and processes 4 ads at a time (`PACKAGE_CONCURRENCY`). For each ad:

1. **Export.** It opens `<page>?v=<row>&export=cm360` and waits for the ad to be ready (60 s timeout).
2. **Collect.** It reads the block's HTML, the clickTag, the size, the timeline and every image the ad uses.
3. **Fit the budget.** It downloads each image at a size and quality from this ladder, stopping at the first
   step whose zip fits `budgetKB`:

   | step | pixel density | quality |
   |---|---|---|
   | 1 | 2× | 85 |
   | 2 | 2× | 70 |
   | 3 | 2× | 55 |
   | 4 | 1.5× | 55 |
   | 5 | 1× | 55 |

   The back-most layer may ship as a JPEG. If even step 5 is over budget, the ad still ships and is flagged
   `HTML5_OVER_BUDGET` (a warning).
4. **Build.** It writes a self-contained `index.html` (block CSS and JS inlined, local image files) and zips it
   with fixed timestamps.
5. **Render offline.** It opens the zip with all network access blocked, and records any request that tried
   to leave the zip.
6. **Visuals.** It steps `window.adTimeline` to make an animated GIF preview (long side at most 800 px;
   10 fps up to 10 s, else 5 fps) and a 6-frame storyboard.
7. **Fidelity.** It compares the end frame with the backup JPG (RMSE). Up to 0.02 passes, up to 0.05 warns,
   above that fails with `HTML5_FIDELITY`. This flags that ad only and never stops the run.
8. **CM360 checks** (below).
9. **Write back.** It sends the zip, GIF and storyboard to the `html5-writeback` action, which uploads them to
   AEM and sets the metadata. GitHub never holds an AEM token, and the action only accepts the three expected
   files for that ad.

### CM360 checks

| Code | Rule |
|---|---|
| `CM360_NO_INDEX` | `index.html` must be at the root of the zip |
| `CM360_NO_AD_SIZE` / `CM360_AD_SIZE` | the `ad.size` meta tag must exist and match the ad's size |
| `CM360_NO_CLICKTAG` | `var clickTag` must be declared |
| `CM360_NO_CLICKTHROUGH` | the click-through must call `window.open(clickTag)` |
| `CM360_ABSOLUTE_URL` | no absolute URLs to assets |
| `CM360_MISSING_FILE` | every referenced file is in the zip |
| `CM360_EXTERNAL_REQUEST` | the offline render made no network requests |
| `CM360_TOO_MANY_FILES` | at most 100 files |
| `CM360_ZIP_TOO_LARGE` | the zip is 10 MB or less |
| `CM360_TOO_LONG` | `duration × loops` is 30 s or less |

Other packaging codes: `HTML5_LAYER_MISSING` (a layer image could not be fetched), `HTML5_NO_BACKUP` (no JPG to
compare with), `HTML5_EXPORT_ERROR` (the page did not load or never became ready).

### Outputs

```
<job output folder>/
  <page>_<row>.jpg                    backup image (from the JPG render)
  html5/cm360/
    <page>_<row>.zip                  the CM360 upload
    <page>_<row>_preview.gif          animated preview
    <page>_<row>_storyboard.jpg       6 frames across the timeline
```

Metadata on each zip: `html5:bytes`, `budgetKB`, `budgetStep`, `overBudget`, `clickthrough`, `duration`,
`loops`, `fidelityScore`, `fidelityVerdict`, `previewUrl`, `page`, `row` and `sourceTemplate`.

The modal shows progress per ad and links to the `cm360` folder in Assets View. A run that reports nothing for
15 minutes (for example, a cancelled workflow) shows as stalled and can be packaged again.

---

## Troubleshooting

| Code or symptom | Meaning | Fix |
|---|---|---|
| `HTML5_NO_PAGES` | no page has `html5=yes` | add the `html5` column to the page map |
| `HTML5_MOTION_UNKNOWN` | unknown preset, or a label not live on that page | check the preset name and that the label is a CSV column |
| `HTML5_TOO_LONG` | `duration × loops` over 30 s | shorten or loop less |
| `HTML5_NO_SITE`, `HTML5_DA_NO_ACCESS` | no `html5.json`, or no write access | [HTML5-SETUP.md](HTML5-SETUP.md) |
| "baked into a static slice" | a labelled frame is inside a group | ungroup it in the template |
| A layer shows the template copy, not the row's | its label is not a CSV column, so it was baked | rename the label or the column so they match |
| `HTML5_ASSET_NOT_DELIVERABLE` | a swapped image isn't approved | approve it in AEM and run again |
| `HTML5_SHEET_EDITED` | the DA sheet was edited, so it was kept | intended. Delete the sheet to take the CSV again |
| `HTML5_NO_CLICKTHROUGH` | no click-through column, or it is empty | add e.g. a `clickthrough` column |
| `HTML5_OVER_BUDGET` | still over `budgetKB` at the smallest step | fewer or smaller images, or a higher `budgetKB` |
| `HTML5_FIDELITY` | the HTML end frame differs from the JPG | compare the storyboard with the JPG. Usually a web font or text-scale difference |
| Package for CM360: dispatch 403/404 | the dispatch token can't reach the repo | [HTML5-SETUP.md](HTML5-SETUP.md) Step 6 |
| Package run shows "stalled" | the workflow was cancelled or crashed | check the repo's Actions log, then package again |
