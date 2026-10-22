/*
 * AEM renditions for generated files that AEM cannot thumbnail itself.
 *
 * AEM builds an .indd's thumbnail/preview renditions from the page preview InDesign embeds when it saves.
 * The InDesign API (a headless InDesign Server) saves no preview, so a generated .indd stays a generic icon.
 * Instead we attach the page image we already rendered as the asset's standard renditions through the
 * Assets Author API (POST /adobe/assets/{id}/renditions/{name} + completeUpload), which is what Assets View
 * shows in the grid and preview panel.
 */

// Same names AEM gives renditions it generates itself (see an uploaded .indd's /renditions list).
const RENDITION_NAMES = [
  'cq5dam.thumbnail.48.48.jpeg',
  'cq5dam.thumbnail.140.100.jpeg',
  'cq5dam.thumbnail.319.319.jpeg',
  'cq5dam.web.1280.1280.jpeg',
  'cq5dam.zoom.2048.2048.jpeg'
]

// Upload one rendition: initiate -> bare PUT of each part -> complete.
async function uploadRendition (author, token, assetId, name, buf) {
  const base = `${author}/adobe/assets/${assetId}/renditions/${encodeURIComponent(name)}`
  // The rendition-upload endpoints are still gated as experimental on AEM CS: without this header they 404.
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'X-Adobe-Accept-Experimental': '1' }
  const init = await fetch(base, { method: 'POST', headers, body: JSON.stringify({ fileSize: buf.length }) })
  if (!init.ok) throw new Error(`initiate rendition ${name} -> ${init.status} ${(await init.text()).slice(0, 120)}`)
  const { uploadURIs, uploadToken } = await init.json()
  if (!uploadURIs || !uploadURIs.length) throw new Error(`rendition ${name}: no upload URI`)
  const partSize = Math.ceil(buf.length / uploadURIs.length)
  for (let i = 0; i < uploadURIs.length; i++) {
    const part = buf.subarray(i * partSize, Math.min((i + 1) * partSize, buf.length))
    const put = await fetch(uploadURIs[i], { method: 'PUT', body: part })
    if (!put.ok) throw new Error(`rendition ${name} part ${i} -> ${put.status}`)
  }
  const done = await fetch(`${base}/completeUpload`, { method: 'POST', headers, body: JSON.stringify({ uploadToken }) })
  if (!done.ok) throw new Error(`complete rendition ${name} -> ${done.status} ${(await done.text()).slice(0, 120)}`)
}

// Attach the preview image under every standard rendition name. Returns { created, warnings }.
async function attachPreview (author, token, assetId, buf, names = RENDITION_NAMES) {
  let created = 0
  const warnings = []
  for (const name of names) {
    try { await uploadRendition(author, token, assetId, name, buf); created++ } catch (e) { warnings.push(e.message) }
  }
  return { created, warnings }
}

// Which rendered JPG stands in for the .indd: the first pagemap page of the same variation.
// Pure; JPGs are named <page>_<variation>.jpg and the .indd <variation>.indd.
const previewKey = (jpgName, firstPage) => {
  if (!firstPage || !jpgName.startsWith(`${firstPage}_`) || !/\.jpe?g$/i.test(jpgName)) return null
  return jpgName.slice(firstPage.length + 1).replace(/\.jpe?g$/i, '')
}

module.exports = { RENDITION_NAMES, uploadRendition, attachPreview, previewKey }
