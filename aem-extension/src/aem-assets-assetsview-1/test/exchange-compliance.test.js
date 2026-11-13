/*
 * Layer 1: Package, Schema & Repo Hygiene Gate (PKG-01 .. PKG-06)
 *
 * Automatically verifies that app.config.yaml, ext.config.yaml, package.json,
 * bundled ExtendScript files, and git-tracked files meet Adobe Exchange
 * Public Distribution and Security Review requirements.
 */

const crypto = require('crypto')
const cp = require('child_process')
const fs = require('fs')
const path = require('path')
const yaml = require('js-yaml')

const EXT_ROOT = path.resolve(__dirname, '../../..')
const REPO_ROOT = path.resolve(EXT_ROOT, '..')
const ACTIONS_DIR = path.resolve(__dirname, '../actions')

const readYaml = (relPath) => yaml.load(fs.readFileSync(path.join(EXT_ROOT, relPath), 'utf8'))

function walkJsFiles (dir, out = []) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, ent.name)
    if (ent.isDirectory()) walkJsFiles(full, out)
    else if (ent.isFile() && ent.name.endsWith('.js')) out.push(full)
  }
  return out
}

describe('Layer 1: Package, Schema & Repo Hygiene Gate', () => {
  test('PKG-01: app.config.yaml and ext.config.yaml conform to App Builder Exchange schema', () => {
    const appCfg = readYaml('app.config.yaml')
    expect(Array.isArray(appCfg.productDependencies)).toBe(true)
    expect(appCfg.productDependencies.length).toBeGreaterThanOrEqual(1)
    for (const dep of appCfg.productDependencies) {
      expect(typeof dep.code).toBe('string')
      expect(dep.minVersion).toMatch(/^\d+\.\d+\.\d+$/)
      expect(dep.maxVersion).toMatch(/^\d+\.\d+\.\d+$/)
    }

    expect(appCfg.configSchema).toBeDefined()
    expect(typeof appCfg.configSchema.title).toBe('string')
    expect(Array.isArray(appCfg.configSchema.properties)).toBe(true)
    expect(appCfg.configSchema.properties.length).toBeGreaterThanOrEqual(8)

    for (const prop of appCfg.configSchema.properties) {
      expect(prop.envKey).toMatch(/^[A-Za-z_][A-Za-z0-9_]*$/)
      expect(['string', 'boolean']).toContain(prop.type)
      expect(typeof prop.title).toBe('string')
    }

    const extCfg = readYaml('src/aem-assets-assetsview-1/ext.config.yaml')
    const actions = extCfg.runtimeManifest.packages['aem-assets-assetsview-1'].actions
    for (const [name, act] of Object.entries(actions)) {
      expect(act.runtime).toBe('nodejs:22')
      expect(act.annotations && act.annotations.final).toBe(true)
      expect(fs.existsSync(path.join(EXT_ROOT, 'src/aem-assets-assetsview-1', act.function))).toBe(true)
      expect(name).toBeTruthy()
    }
  })

  test('PKG-02: every secret/token/credential in configSchema is marked secret: true', () => {
    const appCfg = readYaml('app.config.yaml')
    const secretRe = /SECRET|TOKEN|SC_JSON|PASSWORD|PRIVATE_KEY/i
    const secretProps = appCfg.configSchema.properties.filter((p) => secretRe.test(p.envKey))
    expect(secretProps.length).toBeGreaterThanOrEqual(5)
    for (const p of secretProps) {
      expect(p.secret).toBe(true)
    }
  })

  test('PKG-03: zero hardcoded internal namespace, org ID, or developer path leaks in git-tracked files', () => {
    const tracked = cp.execSync('git ls-files', { cwd: REPO_ROOT, encoding: 'utf8' })
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean)
      // Exclude this test file itself (which defines the forbidden regex patterns)
      .filter((f) => !f.endsWith('exchange-compliance.test.js'))

    const forbidden = new RegExp([
      '374tanbadger',
      '767251',
      '4A603BC061E191130A495FEF',
      'p59602',
      'e520244',
      '2928f570a0de4f3ebc7dcb8a29baa3fe',
      '12771dc03d90ae51a7f75c0b7d2ddcc6',
      'pnamadobestorage',
      '/Users/pnam/Sandbox'
    ].join('|'), 'i')

    const leaks = []
    for (const rel of tracked) {
      if (/\.(png|jpe?g|gif|indd|psd|pdf|otf|ttf|zip)$/i.test(rel)) continue
      const full = path.join(REPO_ROOT, rel)
      if (!fs.existsSync(full) || fs.statSync(full).isDirectory()) continue
      const text = fs.readFileSync(full, 'utf8')
      const m = forbidden.exec(text)
      if (m) leaks.push(`${rel}: matched "${m[0]}"`)
    }
    expect(leaks).toEqual([])
  })

  test('PKG-04: every external npm package required in actions/ is declared in package.json dependencies', () => {
    const pkgJson = JSON.parse(fs.readFileSync(path.join(EXT_ROOT, 'package.json'), 'utf8'))
    expect(pkgJson.version).toMatch(/^\d+\.\d+\.\d+$/)
    expect(pkgJson.name).toBe('aem-banner-automation')
    const deps = new Set(Object.keys(pkgJson.dependencies || {}))
    const builtins = new Set(['crypto', 'fs', 'path', 'url', 'zlib', 'util', 'stream', 'buffer', 'events', 'http', 'https', 'os'])

    const jsFiles = walkJsFiles(ACTIONS_DIR)
    const undeclared = []
    const reqRe = /\brequire\(\s*['"]([^'"]+)['"]\s*\)/g
    for (const file of jsFiles) {
      const src = fs.readFileSync(file, 'utf8')
      let m
      while ((m = reqRe.exec(src))) {
        const spec = m[1]
        if (spec.startsWith('.') || spec.startsWith('/')) continue
        const clean = spec.replace(/^node:/, '')
        const pkgName = clean.startsWith('@') ? clean.split('/').slice(0, 2).join('/') : clean.split('/')[0]
        if (!builtins.has(pkgName) && !deps.has(pkgName)) {
          undeclared.push(`${path.relative(EXT_ROOT, file)} -> ${pkgName}`)
        }
      }
    }
    expect(undeclared).toEqual([])
  })

  test('PKG-05: bundled ExtendScript files in actions/ match root scripts/ byte-for-byte', () => {
    for (const name of ['generate_variations.jsx', 'brand_lib.jsx']) {
      const rootBuf = fs.readFileSync(path.join(REPO_ROOT, 'scripts', name))
      const actionBuf = fs.readFileSync(path.join(ACTIONS_DIR, 'generate-idapi-banners/scripts', name))
      const h1 = crypto.createHash('sha256').update(rootBuf).digest('hex')
      const h2 = crypto.createHash('sha256').update(actionBuf).digest('hex')
      expect(h2).toBe(h1)
    }
  })

  test('PKG-06: worker action is non-web, 2048 MB, concurrency 1, and final: true', () => {
    const extCfg = readYaml('src/aem-assets-assetsview-1/ext.config.yaml')
    const worker = extCfg.runtimeManifest.packages['aem-assets-assetsview-1'].actions['generate-idapi-banners-worker']
    expect(String(worker.web)).toBe('no')
    expect(worker.limits.memorySize).toBe(2048)
    expect(worker.limits.concurrency).toBe(1)
    expect(worker.limits.timeout).toBe(600000)
    expect(worker.annotations.final).toBe(true)
  })
})
