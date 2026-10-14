/*
 * Build the remap-links `dataSource` for one saved INDD: each swapped image's
 * link (a local path on the render box) -> the AEM URL of the DAM asset it was
 * staged from. Links with no known AEM source are left alone.
 */

// Local links to staged inputs, read from the INDD's own XMP link references
// (stRef:filePath). e.g. file:///C:/CXP/<job>/assets/shots/pharma-06.png
const STAGED_LINK_RE = /file:\/\/\/?([A-Za-z]:\/[^<"\s]*?\/assets\/(?:shots|brand)\/[^<"\s/]+)/g

function linksFromIndd (buf) {
  const out = []
  const seen = new Set()
  for (const m of buf.toString('latin1').matchAll(STAGED_LINK_RE)) {
    let path
    try { path = decodeURIComponent(m[1]) } catch (e) { continue }
    if (seen.has(path)) continue
    seen.add(path)
    out.push({ name: path.split('/').pop(), path })
  }
  return out
}

// The service's expected sourceURI spelling isn't documented, so offer the common
// forms of each path; unmatched entries only produce warnings.
function pathVariants (p) {
  return [p, `file:///${p}`, p.replace(/\//g, '\\')]
}

function remapSources (links, aemSourceByName, author) {
  const out = []
  const seen = new Set()
  for (const l of links || []) {
    const damPath = aemSourceByName.get(l.name)
    if (!damPath || !l.path) continue
    const destinationURI = `${author}${damPath.split('/').map(encodeURIComponent).join('/')}`
    for (const sourceURI of pathVariants(l.path)) {
      if (seen.has(sourceURI)) continue
      seen.add(sourceURI)
      out.push({ sourceURI, destinationURI })
    }
  }
  return out
}

module.exports = { remapSources, linksFromIndd, pathVariants }
