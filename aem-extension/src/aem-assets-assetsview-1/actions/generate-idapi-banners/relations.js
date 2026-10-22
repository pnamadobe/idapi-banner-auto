/*
 * AEM asset relations for generated INDDs (AEM Assets Author API, /adobe/assets).
 * Assets View shows only explicit relations (not the automatic Asset Link
 * "references"), so we create them:
 *   - template  --derived-->  each output INDD   (INDD shows the template as its source)
 *   - INDD  <--other-->  each source image it links (two-way: one call per side)
 *   - INDD  --derived-->  its multi-page PDF (shown in the INDD's relations)
 * Verified on AEM CS: POST /adobe/assets/{id}/relations {items:[{assetId, relationType}]};
 * a repeated pair returns 400 "already has relation", so existing pairs are skipped.
 */

const assetUrn = (uuid) => `urn:aaid:aem:${uuid}`
const damUrl = (author, damPath) => `${author}${damPath.split('/').map(encodeURIComponent).join('/')}`

// Group the wanted relations by the asset they are POSTed on.
// inddRecords: [{ inddId, imageIds: [] }]
function planRelations (templateId, inddRecords) {
  const byAsset = new Map()
  const add = (onId, assetId, relationType) => {
    if (!byAsset.has(onId)) byAsset.set(onId, new Map())
    byAsset.get(onId).set(assetId, relationType)
  }
  for (const r of inddRecords) {
    if (templateId) add(templateId, r.inddId, 'derived')
    for (const derivedId of r.derivedIds || []) add(r.inddId, derivedId, 'derived')
    for (const imageId of new Set(r.imageIds)) {
      add(r.inddId, imageId, 'other')
      add(imageId, r.inddId, 'other')
    }
  }
  return Array.from(byAsset, ([onId, items]) => ({ onId, items: Array.from(items, ([assetId, relationType]) => ({ assetId, relationType })) }))
}

// Drop items whose asset the target is already related to (any relation type).
const newItems = (existing, wanted) => {
  const have = new Set((existing || []).map((e) => e.assetId))
  return wanted.filter((w) => !have.has(w.assetId))
}

async function assetId (author, token, damPath) {
  const res = await fetch(`${damUrl(author, damPath)}.1.json`, { headers: { Authorization: `Bearer ${token}` } })
  if (!res.ok) throw new Error(`asset lookup ${damPath} -> ${res.status}`)
  const uuid = (await res.json())['jcr:uuid']
  if (!uuid) throw new Error(`asset ${damPath} has no jcr:uuid`)
  return assetUrn(uuid)
}

async function applyPlan (author, token, plan) {
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }
  const warnings = []
  let created = 0
  for (const { onId, items } of plan) {
    try {
      const url = `${author}/adobe/assets/${onId}/relations`
      const cur = await fetch(url, { headers })
      if (!cur.ok) throw new Error(`get relations -> ${cur.status}`)
      const todo = newItems((await cur.json()).items, items)
      if (!todo.length) continue
      // AEM answers 5xx ("Error saving ...") when the same asset is being written at the same time; one retry clears it.
      let res = await fetch(url, { method: 'POST', headers, body: JSON.stringify({ items: todo }) })
      for (let attempt = 1; res.status >= 500 && attempt <= 2; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 1500 * attempt))
        res = await fetch(url, { method: 'POST', headers, body: JSON.stringify({ items: todo }) })
      }
      if (!res.ok) throw new Error(`create relations -> ${res.status} ${(await res.text()).slice(0, 160)}`)
      created += todo.length
    } catch (e) {
      warnings.push(`${onId}: ${e.message}`)
    }
  }
  return { created, warnings }
}

module.exports = { planRelations, newItems, assetId, applyPlan }
