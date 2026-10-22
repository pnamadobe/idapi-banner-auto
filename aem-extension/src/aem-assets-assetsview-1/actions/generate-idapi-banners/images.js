/*
 * Swapped-image references in the variations CSV, resolved against the job folder.
 *
 * A CSV cell may name an image in three ways:
 *   hero.jpg                    - a file in the job folder (original behaviour)
 *   /hero-images/hero.jpg       - a path from the job folder ("/" = the job folder itself)
 *   hero-images/hero.jpg        - the same ("./" prefixes are ignored too)
 * A bare name that is not in the job folder is also looked for, by name, in its subfolders
 * (an error if two different files share that name).
 *
 * References never leave the job folder (".." is rejected). Resolved images are staged
 * under one flat file name each (the render scripts look images up by name), and the CSV
 * cells are rewritten to those staged names. This module is pure: directory listing is
 * injected so the logic is unit-testable.
 */

const { IMAGE_RE } = require('./links')
const { splitRecord } = require('./psd')

// Folders inside a job folder that never hold swappable images.
const SKIP_FOLDERS = new Set(['output', 'fonts'])
const MAX_DEPTH = 3
const MAX_DIRS = 60

// A CSV cell -> { raw, dir: [segments], name } or { raw, invalid } ; null when it is not an image file name.
function parseRef (cell) {
  const raw = String(cell || '').trim()
  if (!raw || /[\r\n]/.test(raw) || !IMAGE_RE.test(raw)) return null
  if (/[\\\x00-\x1f]/.test(raw)) return { raw, invalid: 'contains a backslash or control character' } // eslint-disable-line no-control-regex
  const segments = raw.split('/').filter((s) => s && s !== '.')
  if (segments.includes('..')) return { raw, invalid: 'may not contain ".." (images must be inside the job folder)' }
  const name = segments.pop()
  return name ? { raw, dir: segments, name } : null
}

// Distinct image references in the CSV records (header excluded), as written in the cells.
function csvImageCells (records) {
  const out = new Set()
  for (const rec of records.slice(1)) {
    for (const cell of splitRecord(rec)) {
      const p = parseRef(cell)
      if (p) out.add(p.raw)
    }
  }
  return out
}

// Unique flat staged names. A name is kept as-is unless two different files want it
// (including the root images, which are staged under their own names); then the folder
// path is folded into the name. `taken` is name -> damPath of names already in use.
function stagedNames (items, taken, folder) {
  const used = new Map(taken)
  const out = new Map()
  const safe = (s) => s.replace(/[^A-Za-z0-9._-]+/g, '_')
  for (const { ref, name, damPath } of items) {
    let staged = name
    if (used.has(staged) && used.get(staged) !== damPath) {
      const rel = damPath.slice(folder.length + 1).split('/')
      staged = safe(rel.join('__'))
      let n = 2
      while (used.has(staged) && used.get(staged) !== damPath) staged = safe(rel.join('__')).replace(/(\.[^.]+)$/, `_${n++}$1`)
    }
    used.set(staged, damPath)
    out.set(ref, staged)
  }
  return out
}

// Resolve every referenced image against the job folder.
//   list(dir) -> [{ name, isFolder }]   (injected; failures should resolve to [])
// Returns { resolved: [{ ref, name, damPath, staged }], unresolved: [ref], ambiguous: [{ ref, paths }], invalid: [{ ref, why }] }
// `unresolved` holds both missing paths and missing bare names; bare ones may still be satisfied
// elsewhere (an InDesign template's Asset Links), so each carries `bare`.
async function resolveImageRefs ({ folder, rootImages, cells, list }) {
  const rootNames = new Set(rootImages.map((i) => i.name))
  const dirs = new Map()
  const listDir = async (dir) => { if (!dirs.has(dir)) dirs.set(dir, await list(dir)); return dirs.get(dir) }
  let tree = null
  const search = async () => {
    if (tree) return tree
    tree = new Map()
    let queue = [{ dir: folder, depth: 0 }]
    let visited = 0
    while (queue.length && visited < MAX_DIRS) {
      const next = []
      for (const { dir, depth } of queue) {
        if (visited++ >= MAX_DIRS) break
        for (const e of await listDir(dir)) {
          if (e.isFolder) {
            if (depth < MAX_DEPTH && !(dir === folder && SKIP_FOLDERS.has(e.name))) next.push({ dir: `${dir}/${e.name}`, depth: depth + 1 })
          } else if (dir !== folder && IMAGE_RE.test(e.name)) {
            if (!tree.has(e.name)) tree.set(e.name, [])
            tree.get(e.name).push(`${dir}/${e.name}`)
          }
        }
      }
      queue = next
    }
    return tree
  }

  const resolved = []
  const unresolved = []
  const ambiguous = []
  const invalid = []
  for (const cell of cells) {
    const p = parseRef(cell)
    if (!p) continue
    if (p.invalid) { invalid.push({ ref: cell, why: p.invalid }); continue }
    if (p.dir.length) {
      const dir = `${folder}/${p.dir.join('/')}`
      const found = (await listDir(dir)).some((e) => !e.isFolder && e.name === p.name)
      if (found) resolved.push({ ref: cell, name: p.name, damPath: `${dir}/${p.name}` })
      else unresolved.push({ ref: cell, bare: false })
    } else if (rootNames.has(p.name)) {
      resolved.push({ ref: cell, name: p.name, damPath: `${folder}/${p.name}`, root: true })
    } else {
      const hits = (await search()).get(p.name) || []
      if (hits.length === 1) resolved.push({ ref: cell, name: p.name, damPath: hits[0] })
      else if (hits.length > 1) ambiguous.push({ ref: cell, paths: hits })
      else unresolved.push({ ref: cell, bare: true })
    }
  }

  const taken = new Map(rootImages.map((i) => [i.name, `${folder}/${i.name}`]))
  const names = stagedNames(resolved.map((r) => ({ ref: r.ref, name: r.name, damPath: r.damPath })), taken, folder)
  resolved.forEach((r) => { r.staged = names.get(r.ref) })
  return { resolved, unresolved, ambiguous, invalid }
}

// Human-readable reasons a job cannot start, or '' when every reference resolved (ignoring
// bare names the caller may still satisfy another way).
function problems (plan, folder, { allowBareUnresolved = false } = {}) {
  const out = []
  plan.invalid.forEach((i) => out.push(`image "${i.ref}" ${i.why}`))
  plan.ambiguous.forEach((a) => out.push(`image "${a.ref}" matches several files (${a.paths.map((p) => p.slice(folder.length)).join(', ')}); use a path such as /subfolder/${a.ref}`))
  plan.unresolved.filter((u) => !(allowBareUnresolved && u.bare)).forEach((u) => out.push(`image "${u.ref}" was not found in ${folder}${u.bare ? ' or its subfolders' : ''}`))
  return out
}

const csvCell = (v) => (/[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v)

// Replace cells equal (after trimming) to a key of `map` with the mapped value. Records without a
// replaced cell are returned byte-for-byte; the header record is never touched.
function rewriteRecords (records, map) {
  if (!map.size) return records
  return records.map((rec, i) => {
    if (i === 0) return rec
    const cells = splitRecord(rec)
    let changed = false
    const next = cells.map((c) => {
      const to = map.get(c.trim())
      if (to !== undefined && to !== c.trim()) { changed = true; return to }
      return c
    })
    return changed ? next.map(csvCell).join(',') : rec
  })
}

module.exports = { parseRef, csvImageCells, stagedNames, resolveImageRefs, problems, rewriteRecords, SKIP_FOLDERS }
