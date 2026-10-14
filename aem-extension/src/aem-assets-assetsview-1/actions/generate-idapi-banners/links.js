/*
 * Asset Link resolution for swapped images.
 *
 * A template placed via Adobe Asset Link stores each AEM-linked image as an
 * XMP reference (stRef:filePath / lastURL) holding the asset's full author URL,
 * plus an internal aems://<host>/content/dam/... URI. The images the CSV swaps
 * in therefore don't have to be copied into the job folder: we read their DAM
 * paths straight out of the template and fetch them from AEM.
 */

const IMAGE_RE = /\.(jpe?g|png)$/i
// eslint-disable-next-line no-control-regex
const DAM_PATH_RE = /(?:https:\/\/(author-[a-z0-9-]+\.adobeaemcloud\.com)|aems:\/\/[^/\s"'<>]+)(\/content\/dam\/[^\s"'<>\x00-\x1f]+?\.(?:jpe?g|png))(?![A-Za-z0-9])/gi

// basename -> { damPath, host } for every AEM-linked image URL found in the .indd binary.
// First occurrence wins; the https form (which carries the host) is preferred.
function damLinksFromTemplate (buf) {
  const text = buf.toString('latin1')
  const links = new Map()
  for (const m of text.matchAll(DAM_PATH_RE)) {
    let damPath
    try { damPath = decodeURIComponent(m[2]) } catch (e) { continue }
    const name = damPath.split('/').pop()
    const prev = links.get(name)
    if (!prev || (!prev.host && m[1])) links.set(name, { damPath, host: m[1] || null })
  }
  return links
}

// Image filenames a variations CSV asks for (any cell that looks like an image file).
function csvImageRefs (records) {
  const refs = new Set()
  for (const rec of records.slice(1)) {
    for (const cell of rec.match(/"(?:[^"]|"")*"|[^,]*/g) || []) {
      const v = cell.replace(/^"|"$/g, '').replace(/""/g, '"').trim()
      if (v && !/[\r\n]/.test(v) && IMAGE_RE.test(v)) refs.add(v.split('/').pop())
    }
  }
  return refs
}

// Split the CSV's image refs into those already in the job folder, those the
// template's Asset Links can supply, and those found nowhere.
function resolveSwappedImages (refs, folderImageNames, templateLinks, authorHost) {
  const inFolder = new Set(folderImageNames)
  const fromLinks = []
  const unresolved = []
  for (const name of refs) {
    if (inFolder.has(name)) continue
    const link = templateLinks.get(name)
    if (link && (!link.host || link.host === authorHost)) fromLinks.push({ name, damPath: link.damPath })
    else unresolved.push(name)
  }
  return { fromLinks, unresolved }
}

module.exports = { damLinksFromTemplate, csvImageRefs, resolveSwappedImages, IMAGE_RE }
