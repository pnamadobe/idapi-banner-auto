# PSD templates — design notes

The "Generate Banners" button works with a `.psd` template as well as an `.indd`. Same
folder-as-key contract (template + pagemap CSV + variations CSV + images + fonts), same
job/batch/output machinery; only the render step differs: **Adobe Photoshop API v2**
(`photoshop-api.adobe.io`) instead of the InDesign API. The template's file extension, as
selected in Assets View, picks the path.

## Template contract

One PSD with **one artboard per output size**, each named like the `pagename` column of the pagemap
CSV. Every artboard has identically named layers; **layer name = CSV column** (the PSD analogue of an
InDesign Script Label):

| layer name (example) | kind | filled with |
|---|---|---|
| `headline`, `highlight`, `tagline`, `cta`, `url`, `legal`, `cardname` | text layer | CSV column of the same name |
| `hero`, `card`, `qr` | smart object | image file named in that CSV column |
| `bgfill`, `rule`, `band`, `highlight-button` | group / shape | static, untouched |

Layer names repeat on every artboard, so edits address layers by **id** from the manifest. Hidden layers
stay hidden (visibility is never toggled). A line break in a CSV cell becomes `\r` (paragraph break).
Only artboards listed in the pagemap are rendered; a pagemap name with no artboard fails the job.

## Render pipeline

Same OAuth Server-to-Server credential as the InDesign API (scope
`openid,AdobeID,read_organizations,firefly_api,ff_apis`), with the **Photoshop API (v2)** added to the
Developer Console project. (v1 endpoints answer `403 retired`; a credential without the API answers
`403 Api Key is invalid`.)

1. `POST /v2/generate-manifest` with `extractSmartObjectData: true` → layer tree; per artboard
   `{layerName → {id, type, frame}}`, the artboard rect, and the top of a `band` layer if present.
2. Per CSV row, **one** `POST /v2/create-composite`: `edits.layers[]` (text: `operation:edit` +
   `text.content`; smart objects: `smartObject.smartObjectFile.source.url`) and `outputs[]` — one
   `image/jpeg` per pagemap artboard (`layers:[{id: artboardId}]`, `cropMode: layer_bounds`, hosted
   destination), plus a final unfiltered `image/vnd.adobe.photoshop` output for the editable PSD.
   `fontOptions.additionalFonts` supplies the fonts; `missingFontStrategy: fail` makes a missing font fail
   the job instead of silently substituting.
3. Poll `GET /v2/status/{jobId}`; download hosted outputs (auth header required) and upload to AEM as
   `<artboard>_<outputFileName>.jpg` and `<outputFileName>.psd`. Transient failures (the service failing to
   fetch a staged URL, gateway errors) are retried.

Inputs are staged in Adobe I/O Files as presigned URLs, exactly as for InDesign. Code:
`actions/generate-idapi-banners/psd.js` (pure, unit-tested) and `renderPsdBatch` in `engine.js`. The worker
runs with 2048 MB: a ~60-90 MB template plus editable-PSD outputs overflow 512 MB.

## Hero framing — matching InDesign

The hero smart object is cover-fitted like the InDesign photo frame: a frame of aspect
`PSD_HERO_FRAME_ASPECT` (width/height of the photo frame in the matching InDesign template) that covers
the visible area (the artboard, cut at the `band` layer where there is one), **left-aligned** and vertically
centred; the photo scales to cover that frame, centred in it. A wide frame overhangs the page on the right,
so the left of the photo stays prominent — as in the InDesign template.

Settings that make this work, each learned by comparing against InDesign renders of the same photos:

- `smartObject.autoResize: false` — the default **crops the photo to the placeholder canvas's aspect** first,
  losing the sides of wider photos.
- `pixelMask.isLinked: false` — otherwise the layer's mask scales with it and the photo bleeds past the
  visible area (over the headline on tall layouts). The mask stays where the template put it.
- `transformMode: custom` with `transform.dimension` / `transform.offset` (top-left, document coordinates).
- Only "full-bleed" smart objects (frame spans the artboard width) get this; card and QR layers keep the
  API's default fit.
- `transformMode: fill` is not usable: it fills the whole document canvas, not one artboard.

Result: band layouts match the InDesign renders closely (RMSE ≈ 0.01–0.04 on the photo band).

## Editable PSD output and AEM references

"Generate banners + editable file" also writes `<outputFileName>.psd` per row (all artboards). Smart objects
stay **embedded** copies: a PSD placed from AEM as a copy carries no AEM reference (empty external-link
record, no path in the embedded file), and the Photoshop API has no equivalent of InDesign's `remap-links`.
The reference is therefore managed **in AEM only**, with the same relations as for INDDs: template → PSD
(`derived`) and PSD ↔ each replaced image (`other`).

## Limits to document for template authors

- No text auto-fit or overset detection: the text layer's content is replaced as-is.
- A shape behind text (such as a highlight bar behind a word) is a plain shape and does **not** resize to
  the new copy; size it for the longest value.
- Fonts must be available (shared `/content/dam/fonts` or the job's `fonts/` folder); otherwise the job fails.
- Photos with a very different shape from the template's photo frame are cropped (as in InDesign).
- Several templates may share a folder; the one selected in Assets View runs, each with its own job.
