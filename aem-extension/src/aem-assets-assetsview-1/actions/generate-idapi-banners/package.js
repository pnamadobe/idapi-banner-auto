/*
 * HTML5 "Package for CM360": the ad list sent to the banner-ads packaging workflow, the
 * short-lived writeback token it carries, and the repository_dispatch call.
 *
 * The workflow runs in a public repository, so it never gets an AEM token. It calls the
 * html5-writeback action with a token that is bound to one package run and one output folder,
 * and only lets it write the three files expected for each ad.
 */

const crypto = require('crypto')
const { csvRecords } = require('./csv')
const { rowsFromRecords } = require('./psd')
const h = require('./html5')

const TOKEN_TTL_S = 2 * 3600
const b64url = (s) => Buffer.from(s).toString('base64url')
const sign = (secret, body) => crypto.createHmac('sha256', secret).update(body).digest('base64url')

function requireSecret (secret) {
  if (!secret || String(secret).length < 32) throw new Error('HTML5_WRITEBACK_SECRET is not configured (32+ characters)')
  return String(secret)
}

// claims: { job, run, outFolder, template }
function mintToken (secret, claims, now = Date.now()) {
  const body = b64url(JSON.stringify({ ...claims, exp: Math.floor(now / 1000) + TOKEN_TTL_S }))
  return `${body}.${sign(requireSecret(secret), body)}`
}

// Returns the claims, or throws on a bad signature, malformed token or expiry.
function verifyToken (secret, token, now = Date.now()) {
  const [body, sig, extra] = String(token || '').split('.')
  if (!body || !sig || extra !== undefined) throw new Error('malformed token')
  const want = Buffer.from(sign(requireSecret(secret), body))
  const got = Buffer.from(sig)
  if (want.length !== got.length || !crypto.timingSafeEqual(want, got)) throw new Error('bad token signature')
  let claims
  try { claims = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) } catch (e) { throw new Error('malformed token') }
  if (!claims || typeof claims.exp !== 'number' || claims.exp * 1000 < now) throw new Error('token expired')
  return claims
}

// A bare file name: no path separators, control characters or leading dot.
const safeName = (n) => typeof n === 'string' && /^[^/\\\x00-\x1f.][^/\\\x00-\x1f]*$/.test(n) && n.length <= 200 // eslint-disable-line no-control-regex

const rowName = (row, i) => String(row.outputFileName || `row${i + 1}`).trim()

// One ad per (html5 size x variation row). `pages` / `rows` optionally narrow the list.
function buildAds ({ pagemapText, csvText, outputs = [], cfg, campaign, template, pages, rows }) {
  const paths = h.campaignPaths(cfg, campaign, template)
  const have = new Set(outputs)
  const sizes = h.pagemapHtml5(pagemapText).filter((p) => p.html5 && (!pages || pages.includes(p.pagename)))
  const variations = rowsFromRecords(csvRecords(String(csvText || ''))).map(rowName).filter((r) => !rows || rows.includes(r))
  const ads = []
  for (const p of sizes) {
    for (const row of variations) {
      const name = `${p.pagename}_${row}`
      if (!safeName(name)) continue
      ads.push({
        page: p.pagename,
        path: paths.pagePath(p.pagename),
        row,
        budgetKB: p.budgetKB,
        name,
        ...(have.has(`${name}.jpg`) ? { backup: `${name}.jpg` } : {})
      })
    }
  }
  return ads
}

const expectedNames = (ad) => [`${ad.name}.zip`, `${ad.name}_preview.gif`, `${ad.name}_storyboard.jpg`]
const MIME = { zip: 'application/zip', gif: 'image/gif', jpg: 'image/jpeg' }
const mimeFor = (name) => MIME[String(name).split('.').pop().toLowerCase()]

// The packaging workflow lives in `<org>/<repo>` and listens for repository_dispatch type "package".
async function dispatch (repo, token, payload) {
  if (!/^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/.test(String(repo || ''))) throw new Error(`invalid GITHUB_REPO: ${repo}`)
  if (!token) throw new Error('GITHUB_DISPATCH_TOKEN is not configured')
  const res = await fetch(`https://api.github.com/repos/${repo}/dispatches`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'Content-Type': 'application/json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'idapi-banner-auto'
    },
    body: JSON.stringify({ event_type: 'package', client_payload: payload })
  })
  if (res.status !== 204 && !res.ok) throw new Error(`GitHub dispatch ${repo} -> ${res.status}`)
}

// AEM asset metadata written on each zip (design §9). Unknown values are left out.
function zipMetadata (report = {}, ad = {}, template) {
  const fid = report.fidelity || {}
  const props = {
    'html5:bytes': report.bytes,
    'html5:budgetKB': report.budgetKB,
    'html5:budgetStep': report.step,
    'html5:overBudget': report.over,
    'html5:clickthrough': report.clickthrough,
    'html5:duration': report.duration,
    'html5:loops': report.loops,
    'html5:fidelityScore': fid.score,
    'html5:fidelityVerdict': fid.verdict,
    'html5:previewUrl': report.previewUrl,
    'html5:page': ad.page,
    'html5:row': ad.row,
    'html5:sourceTemplate': template
  }
  return Object.fromEntries(Object.entries(props).filter(([, v]) => v !== undefined && v !== null && v !== ''))
}

module.exports = { TOKEN_TTL_S, mintToken, verifyToken, safeName, buildAds, expectedNames, mimeFor, dispatch, zipMetadata }
