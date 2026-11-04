/*
 * Save the EDS / DA site a campaign folder publishes HTML5 banners to, picked in the Generate Banners
 * dialog. It checks that the signed-in user can open the DA site and that the site serves the `ad` block,
 * then writes html5.json into the chosen AEM folder as that user (so AEM folder permissions apply).
 * Folders below it inherit the choice; a folder's own html5.json overrides it.
 *
 * Only the user's own token is used for DA, AEM writes and the html5.json read-back. It is never stored
 * or logged. Nothing here creates a site: that stays in docs/HTML5-SETUP.md.
 */

const html5 = require('./html5')
const { html5JsonFolders, aemDownload, aemUpload } = require('./engine')

const DA_ADMIN = 'https://admin.da.live'

function fail (status, message) {
  const e = new Error(message)
  e.status = status
  return e
}

// The folder html5.json goes in must be the campaign folder or a folder above it (below /content/dam).
function pickTarget (folder, target) {
  const allowed = html5JsonFolders(folder)
  if (!allowed.length) throw fail(400, 'the folder must be under /content/dam')
  const t = String(target || '').replace(/\/+$/, '')
  if (!t) return allowed[0]
  if (!allowed.includes(t)) throw fail(400, 'save the site on the campaign folder or a folder above it')
  return t
}

// DA_ORG / DA_SITE checked with the same rules as html5.json, with messages for the dialog.
function siteNames (org, site) {
  const o = String(org || '').trim()
  const s = String(site || '').trim()
  if (!o || !s) throw fail(400, 'enter both the DA org and the DA site')
  try {
    return html5.daConfig({ DA_ORG: o, DA_SITE: s })
  } catch (e) {
    throw fail(400, e.message.replace(/^html5\.json: /, '').replace(/DA_ORG/, 'DA org').replace(/DA_SITE/, 'DA site') + ' (letters, digits and - only)')
  }
}

// Can the signed-in user open the site in DA? DA reports what the caller may do in x-da-actions /
// x-da-child-actions (for example "/acme/banner-ads/+**=read,write") when the org has permissions set.
async function checkDa (cfg, userToken) {
  const name = `${cfg.org}/${cfg.site}`
  let res
  try {
    res = await fetch(`${DA_ADMIN}/list/${cfg.org}/${cfg.site}`, { headers: { Authorization: `Bearer ${userToken}` } })
  } catch (e) {
    throw fail(502, `could not reach Document Authoring: ${e.message}`)
  }
  if (res.status === 401 || res.status === 403) throw fail(403, `your Adobe ID can't open ${name} in Document Authoring. Ask a DA org admin for write access (setup guide step 4)`)
  if (res.status === 404) throw fail(404, `${name} was not found in Document Authoring. Check the names (setup guide step 3)`)
  if (!res.ok) throw fail(502, `Document Authoring returned ${res.status} for ${name}`)
  const get = (h) => (res.headers && typeof res.headers.get === 'function' ? res.headers.get(h) : null)
  const actions = [get('x-da-actions'), get('x-da-child-actions')].filter(Boolean).join(',')
  if (actions && !/\bwrite\b/i.test(actions)) throw fail(403, `your Adobe ID can read ${name} in Document Authoring but not write to it. Ask a DA org admin for write access (setup guide step 4)`)
}

// Does the site's EDS code serve the ad block? A site that needs sign-in (401/403) or an unreachable
// EDS is not held against it; a 404 means the repo, Code Sync or the ad block is missing.
async function checkEds (cfg) {
  let res
  try {
    res = await fetch(`${cfg.previewOrigin}/blocks/ad/ad.js`, { method: 'HEAD' })
  } catch (e) {
    return
  }
  if (res.status === 404) throw fail(404, `${cfg.previewOrigin} has no ad block (blocks/ad/ad.js). Create the site repo from banner-ads and install AEM Code Sync (setup guide steps 1 and 2)`)
}

// Keep any other keys (DA_ADS_ROOT, EDS_REF, GITHUB_REPO) of an html5.json already in the folder.
async function existingKeys (author, token, target) {
  try {
    const v = JSON.parse((await aemDownload(author, token, `${target}/html5.json`)).toString('utf8'))
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {}
  } catch (e) {
    return {}
  }
}

async function saveSite ({ author, userToken, folder, target, org, site }) {
  if (!userToken) throw fail(401, 'sign in again: the site is checked and saved as you')
  const where = pickTarget(folder, target)
  const cfg = siteNames(org, site)
  await checkDa(cfg, userToken)
  await checkEds(cfg)
  const next = { ...(await existingKeys(author, userToken, where)), DA_ORG: cfg.org, DA_SITE: cfg.site }
  // Validate the merged file the way a run will read it, so a bad leftover key fails here, not later.
  try {
    html5.daConfig(next)
  } catch (e) {
    throw fail(400, `the html5.json already in ${where} has ${e.message.replace(/^html5\.json: /, '')}. Fix or delete it in AEM`)
  }
  try {
    await aemUpload(author, userToken, where, 'html5.json', Buffer.from(JSON.stringify(next, null, 2) + '\n'), 'application/json')
  } catch (e) {
    if (/-> 40[13]$/.test(e.message)) throw fail(403, `you can't add files to ${where} in AEM. Pick a folder you can edit`)
    throw fail(502, `could not save html5.json in ${where}: ${e.message}`)
  }
  return { site: `${cfg.org}/${cfg.site}`, savedAt: where }
}

module.exports = { saveSite, pickTarget, siteNames }
