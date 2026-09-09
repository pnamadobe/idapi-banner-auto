# Build your own banner automation — a worked example

This folder is a complete, brand-neutral example you can copy and adapt. It shows
the three inputs you author — a **template**, a **variations CSV**, and a
**pagemap CSV** — and the kind of output they produce.

![Showcase](showcase-hero.jpg)

*One template + one spreadsheet → every placement, every variation. Above: six
placements across destinations, English and Spanish headlines, and two campaign
versions — all rendered from a single InDesign template.*

## What's in this folder

| File | Role |
|------|------|
| [`sample-variations.csv`](sample-variations.csv) | 30 variations — 10 destinations × EN/ES × 2 headline versions |
| [`sample-pagemap.csv`](sample-pagemap.csv) | Maps the template's 10 pages to placement names/sizes |
| `showcase-hero.jpg`, `showcase-collage.jpg` | Rendered output (a collage of de-branded results) |

You supply one more thing the repo doesn't ship: **your own `.indd` template**
(and hero imagery). The steps below explain how to build it.

---

## How the pieces fit

```
  template.indd            variations.csv            pagemap.csv
  (1 page per size,        (1 row per variation:     (page number → placement
   frames labeled          hero, city, header)        name, e.g. 3 → SOCIAL_FEED)
   header / city / hero)
        │                        │                         │
        └────────────────────────┴─────────────┬───────────┘
                                                ▼
                             generate_variations.jsx
                                                ▼
                     <PLACEMENT>_<outputFileName>.jpg   (+ optional .indd)
                     for every row × every page
```

Nothing about a specific campaign lives in the script. **The template defines the
design, the CSVs define the content**, and the exporter just combines them.

---

## Step 1 — Build your template (`*template*.indd`)

Create one InDesign document with **one page per placement size**. On each page:

1. **Size the page** to the placement's exact pixel dimensions (e.g. a page that
   is `1000 × 320` px for a leaderboard). Different pages can be different sizes.
2. **Add a hero image frame** and give it the **script label** `hero`
   (select the frame → *Window ▸ Utilities ▸ Script Label* → type `hero`). The
   exporter places each row's image here and fits it *fill-proportionally, centered*.
3. **Add text frames** for your copy and label them `header` and `city` the same
   way. The exporter flows each row's text into the matching label.
4. **Put your brand in the template** — logo, colors, fonts, grid. This is what
   guarantees every output is on-brand; the script never adds branding.
5. *(Optional, for precise typography)* create a **paragraph style group named
   exactly like the placement** (e.g. `SOCIAL_FEED_1080x1080`) containing
   paragraph styles named `header` and `city`. When present, the exporter applies
   them, so each size can have its own type treatment.

> **Tip:** the labels (`hero`, `header`, `city`) are the contract. Any frame with
> those labels gets filled; anything else on the page is left untouched. Add
> logos, legal lines, backgrounds, etc. freely.

This repo can also **generate** a template from a spec — see
[`scripts/build_template.jsx`](../scripts/build_template.jsx), which builds all
pages, frames, and labels from the `PAGES` definition in
[`scripts/brand_lib.jsx`](../scripts/brand_lib.jsx).

## Step 2 — Write the variations CSV

One row per variation. Columns:

| Column | Meaning |
|--------|---------|
| `outputFileName` | The stem for this variation's files, e.g. `SANT-EN-01` |
| `hero` | Image filename to place (looked up in `assets/shots/`, then `assets/shots/square/`) |
| `city` | Text for the frame labeled `city` |
| `header` | Text for the frame labeled `header` — use `\n` for line breaks |

From [`sample-variations.csv`](sample-variations.csv):

```csv
outputFileName,hero,city,header
FAIR-EN-01,aurora-borealis-sq.jpg,"Fairbanks, Alaska",SAY YES\nTO ANYWHERE.
HONO-ES-01,koolau-mountains-hawaii-sq.jpg,"Honolulú, Hawái",DI QUE SÍ\nA DONDE SEA.
ZERM-EN-02,matterhorn-switzerland-sq.jpg,"Zermatt, Switzerland",PACK LIGHT.\nDREAM BIG.\nGO FAR.
```

Notes:
- **Line breaks:** `\n` becomes a forced line break in the headline.
- **Commas:** wrap a field in `"…"` if it contains a comma (like `city`).
- **Localization & versions** are just more rows — swap the `header`/`city` text
  and reuse the same heroes, as the EN/ES/`-02` rows above show.
- A column you omit keeps the template's default for that frame.

## Step 3 — Write the pagemap CSV

This maps each **page number** in your template to a **placement name**. The name
becomes the prefix of the output files and (optionally) the paragraph-style-group
name. From [`sample-pagemap.csv`](sample-pagemap.csv):

```csv
pagenumber,pagename
1,WEB_LEADERBOARD_1000x320
2,WEB_HP_SLIDER_1440x500
3,WEB_BRAND_PAGE_BANNER_2880x900
...
10,SOCIAL_STORY_1080x1920
```

Page 1 of your `.indd` → `WEB_LEADERBOARD_1000x320`, and so on. Add or remove rows
to match however many sizes your template has — nothing is fixed to ten. Give the
file a name containing `pagemap` so the exporter finds it automatically.

## Step 4 — Add your imagery

Drop the hero images referenced by the CSV into `assets/shots/` (or
`assets/shots/square/`). Filenames must match the `hero` column.

## Step 5 — Render

**Locally** (desktop InDesign) — the exporter reads globals for the template, CSV,
and pagemap, so point them at your files:

```bash
BRAND_TEMPLATE=…/your-template.indd \
BRAND_CSV=…/your-variations.csv \
BRAND_PAGEMAP=…/your-pagemap.csv \
FORMAT=jpg bash run_local.sh
```

**In the cloud** (headless, via the Adobe InDesign API) — see
[`cloud/README.md`](../cloud/README.md).

## Step 6 — Collect the output

For every row × every page you get:

```
<PLACEMENT>_<outputFileName>.<ext>     e.g. SOCIAL_FEED_1080x1080_FAIR-EN-01.jpg
<outputFileName>.indd                  (optional, one editable doc per row)
_run_log.txt                           counts + any warnings
```

The exporter also reports **overset** (text-too-long) per output, so an
over-length headline is flagged rather than silently shipping a broken banner.

---

## See it in action

![Every placement](showcase-collage.jpg)

*The same template rendered across every placement shape — leaderboard, billboard,
half-page, med-rectangle, app card, social feed, and story — in English and
Spanish. Change the template once and all of these regenerate.*
