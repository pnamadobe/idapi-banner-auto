const h = require('../actions/generate-idapi-banners/html5')

const PAGEMAP = [
  'pagenumber,pagename,html5,motion,duration,loops,budgetKB',
  '2,Leaderboard_728x90,no,,,,',
  '1,MedRect_300x250,yes,"hero:kenburns; headline:FADEUP@0.4; cta:pulse@1.6s",8,2,200',
  '3,HalfPage_300x600,yes,logo:explode,20,2,'
].join('\n')

test('pagemapHtml5 reads html5 columns with defaults', () => {
  const pages = h.pagemapHtml5(PAGEMAP)
  expect(pages.map((p) => p.pagename)).toEqual(['MedRect_300x250', 'Leaderboard_728x90', 'HalfPage_300x600'])
  expect(pages[0]).toMatchObject({ html5: true, duration: 8, loops: 2, budgetKB: 200, tooLong: false })
  expect(pages[0].motion).toEqual({ hero: 'kenburns', headline: 'fadeUp@0.4', cta: 'pulse@1.6' })
  expect(pages[1]).toMatchObject({ html5: false, duration: 6, loops: 1, budgetKB: 150 })
  expect(pages[2].unknownMotion).toEqual(['logo:explode'])
  expect(pages[2].tooLong).toBe(true)
})

test('normalizeMotion', () => {
  expect(h.normalizeMotion('wipe @1s/0.8')).toBe('wipe@1/0.8')
  expect(h.normalizeMotion('explode')).toBeNull()
  expect(h.normalizeMotion('fade; color:red')).toBeNull()
})

test('styleTokens: text and image', () => {
  expect(h.styleTokens({
    kind: 'text',
    style: { font: 'Proxima "Nova"};', weight: 'Extra Bold', size: 22, lead: 24.04, color: 'FFFFFF', align: 'center', caps: true, track: 20, bg: '#E00', radius: 4, valign: 'middle', button: true }
  })).toBe('"Proxima Nova" ExtraBold 22/24 #ffffff center caps track:20 bg:#e00 radius:4 valign:middle button')
  expect(h.styleTokens({ kind: 'text', style: { font: 'Arial', weight: 'Regular', size: 12, color: 'red', align: 'left' } })).toBe('"Arial" 12')
  expect(h.styleTokens({ kind: 'text', style: { size: 40, color: '#3a1f6b', stroke: '#E0D8FF', strokeW: 2.31 } })).toBe('40 #3a1f6b stroke:2.3,#e0d8ff')
  expect(h.styleTokens({ kind: 'text', style: { size: 40, stroke: '#fff', strokeW: 2, strokeOut: true } })).toBe('40 stroke:4,#fff')
  expect(h.styleTokens({ kind: 'text', style: { size: 40, stroke: '#fff', strokeW: 0 } })).toBe('40')
  expect(h.styleTokens({ kind: 'image', crop: { fx: 50.4, fy: 30 }, style: { fit: 'cover' } })).toBe('focus:50,30 fit:cover')
})

const MANIFEST = {
  width: 300,
  height: 250,
  slices: [{ name: 'static-0', file: 'html5/MedRect/static-0.png', z: 0 }, { name: 'static-1', file: 'html5/MedRect/static-1.png', z: 3 }],
  elements: [
    { label: 'hero', kind: 'image', box: { x: 0, y: 0, w: 300, h: 250 }, crop: { fx: 50, fy: 30 }, z: 1 },
    { label: 'headline', kind: 'text', box: { x: 16, y: 150.4, w: 268, h: 48 }, style: { font: 'Sans', size: 22 }, z: 2 },
    { label: 'cta', kind: 'text', box: { x: 16, y: 206, w: 120, h: 28 }, style: { button: true }, z: 4 }
  ]
}

test('layersFromManifest orders by z and resolves motion precedence', () => {
  const layers = h.layersFromManifest(MANIFEST, {
    sliceUrl: (s) => `https://delivery-p1-e2.adobeaemcloud.com/adobe/assets/urn:aaid:aem:${s.name}/as/${s.name}.png`,
    pagemapMotion: { hero: 'kenburns', headline: 'fadeUp@0.4' },
    authored: { headline: 'wipe@0.2', cta: '' }
  })
  expect(layers.map((l) => l.name)).toEqual(['static-0', 'hero', 'headline', 'static-1', 'cta'])
  expect(layers[0]).toMatchObject({ kind: 'image', box: '0,0,300,250', image: true })
  expect(layers[1]).toMatchObject({ source: '{hero}', motion: 'kenburns', style: 'focus:50,30' })
  expect(layers[2]).toMatchObject({ source: '{headline}', box: '16,150,268,48', motion: 'wipe@0.2', style: '"Sans" 22' })
  expect(layers[4].motion).toBe('') // author cleared it: keep cleared
})

test('daPageHtml escapes and round-trips authored motion through readDaPage', () => {
  const layers = h.layersFromManifest(MANIFEST, { sliceUrl: (s) => `https://d.example/${s.name}.png`, pagemapMotion: { headline: 'fadeUp@0.4' } })
  layers.push({ name: 'evil<x>', kind: 'text', source: '{a}</div>', box: '0,0,1,1', motion: '', style: '' })
  layers[0].source = 'javascript:alert(1)'
  const html = h.daPageHtml({ width: 300, height: 250, duration: 8, loops: 2, rowsPath: '/ads/spring/variations.json', layers })
  expect(html).toMatch(/^<body><header><\/header><main><div><div class="ad"><div><div>size<\/div><div>300x250<\/div><div>duration 8<\/div><div>loops 2<\/div><div>rows \/ads\/spring\/variations.json<\/div><\/div>/)
  expect(html).toContain('<img src="https://d.example/static-1.png" alt="">')
  expect(html).not.toContain('<img src="javascript')
  expect(html).toContain('evil&lt;x&gt;')
  expect(html).toContain('{a}&lt;/div&gt;')
  const authored = h.readDaPage(html.replace('fadeUp@0.4', 'slideLeft@1'))
  expect(authored.headline).toBe('slideLeft@1')
  expect(authored.hero).toBe('')
  expect(authored.size).toBeUndefined()
})

test('readDaPage tolerates DA wrapping cells in <p>', () => {
  const html = '<body><main><div><div class="ad"><div><div><p>size</p></div><div><p>300x250</p></div></div><div><div><p>cta</p></div><div><p>text</p></div><div><p>{cta}</p></div><div><p>1,2,3,4</p></div><div><p>pulse@2 · bold</p></div></div></div></div></main></body>'
  expect(h.readDaPage(html)).toEqual({ cta: 'pulse@2' })
  expect(h.readDaPage('<html></html>')).toEqual({})
})

test('variationsSheet names the click-through column clickthrough however the CSV spells it', () => {
  const accepted = [
    'clickthrough', 'clickthru', 'Clickthrough', 'Click-Through URL', 'click_thru', 'clickTag', 'Click URL', 'clickthru-link',
    'cta-link', 'cta-url', 'CTA_URL', 'CTA Link', 'ctaUrl', 'cta.href', 'landing-page', 'Landing Page URL', 'destination_url', 'Exit URL'
  ]
  for (const col of accepted) {
    expect(h.isClickthroughColumn(col)).toBe(true)
    const sheet = h.variationsSheet(`outputFileName,${col}\nSpring, https://example.com/a.png \n`, () => 'resolved')
    expect(sheet.data).toEqual([{ outputFileName: 'resolved', clickthrough: 'https://example.com/a.png' }])
  }
  // Not click-through columns: left as they are (`cta` is the button's text).
  for (const col of ['cta', 'CTA text', 'cta-color', 'click', 'clickcount', 'url', 'link', 'landing', 'destination', 'heroUrl']) {
    expect(h.isClickthroughColumn(col)).toBe(false)
  }
  const other = h.variationsSheet('click,clickcount,cta\na,b,c\n')
  expect(other.data).toEqual([{ click: 'a', clickcount: 'b', cta: 'c' }])
  // A CTA button text column next to its link: only the link is the click-through.
  expect(h.variationsSheet('cta,cta-link\nBook now,https://c.example\n').data).toEqual([{ cta: 'Book now', clickthrough: 'https://c.example' }])
  // Two spellings: the first non-empty one wins.
  expect(h.variationsSheet('clickthrough,clickthru\n,https://b.example\n').data).toEqual([{ clickthrough: 'https://b.example' }])
})

test('variationsSheet resolves images but leaves clickthrough alone', () => {
  const csv = 'outputFileName,headline,hero,clickthrough\nSpring,"Hi, there",assets/hero.jpg,https://example.com/a?b=1\n'
  const sheet = h.variationsSheet(csv, (v, col) => (col === 'hero' ? `https://d.example/${v}` : v))
  expect(sheet).toEqual({
    ':type': 'sheet',
    total: 1,
    limit: 1,
    offset: 0,
    data: [{ outputFileName: 'Spring', headline: 'Hi, there', hero: 'https://d.example/assets/hero.jpg', clickthrough: 'https://example.com/a?b=1' }]
  })
  expect(h.sheetEdited(sheet, sheet)).toBe(false)
  expect(h.sheetEdited({ ...sheet, data: [{ ...sheet.data[0], headline: 'Edited' }] }, sheet)).toBe(true)
  expect(h.sheetEdited(null, sheet)).toBe(false)
})

test('the site comes only from html5.json; campaignPaths', () => {
  const cfg = h.siteConfig('{"DA_ORG": "teammate", "DA_SITE": "Banner-Ads"}')
  expect(cfg).toMatchObject({ org: 'teammate', site: 'banner-ads', root: '', ref: 'main', repo: 'teammate/banner-ads', previewOrigin: 'https://main--banner-ads--teammate.aem.page' })
  expect(h.siteConfig('{"DA_ORG":"a","DA_SITE":"b","DA_ADS_ROOT":"/banners/","EDS_REF":"dev","GITHUB_REPO":"Owner/pkg.repo"}')).toMatchObject({ root: '/banners', ref: 'dev', repo: 'Owner/pkg.repo' })
  // no deployment default: a missing, empty or incomplete html5.json is HTML5_NO_SITE
  for (const text of [null, '', '  ', '{}', '{"DA_ORG":"a"}', '{"DA_SITE":"b"}']) {
    expect(() => h.siteConfig(text)).toThrow(expect.objectContaining({ code: 'HTML5_NO_SITE', message: expect.stringMatching(/add html5.json to the campaign folder/) }))
  }
  expect(() => h.daConfig()).toThrow(/add html5.json/)
  expect(() => h.siteConfig('{nope')).toThrow(/not valid JSON/)
  expect(() => h.siteConfig('[1]')).toThrow(/must be a JSON object/)
  expect(() => h.siteConfig('{"DA_ORG":"evil.com/x","DA_SITE":"b"}')).toThrow(/DA_ORG "evil.com\/x" is not a valid name/)
  expect(() => h.siteConfig('{"DA_ORG":"a","DA_SITE":"b","DA_ADS_ROOT":"/../x"}')).toThrow(/DA_ADS_ROOT/)
  expect(() => h.siteConfig('{"DA_ORG":"a","DA_SITE":"b","GITHUB_REPO":"x"}')).toThrow(/GITHUB_REPO/)
  expect(() => h.siteConfig('{"DA_ORG":"a","DA_SITE":"b","EDS_REF":"bad ref"}')).toThrow(expect.objectContaining({ code: 'HTML5_NO_SITE' }))
  const p = h.campaignPaths(cfg, 'Spring Sale 2026!')
  expect(p.pagePath('MedRect_300x250')).toBe('/spring-sale-2026/medrect-300x250')
  expect(p.rowsPath).toBe('/spring-sale-2026/variations.json')
  expect(p.previewUrl('MedRect_300x250', 'Spring A')).toBe('https://main--banner-ads--teammate.aem.page/spring-sale-2026/medrect-300x250?v=Spring%20A')

  // with a template, uses the template name (without extension) instead of the DAM folder name
  const t = h.campaignPaths(cfg, 'automation', 'United Summer.indd')
  expect(t.pagePath('MedRect_300x250')).toBe('/united-summer/medrect-300x250')
  expect(t.rowsPath).toBe('/united-summer/variations.json')

  // only two folder levels in DA: /<template-name>/<animation-style>
  const styled = h.campaignPaths(cfg, 'automation', 'United Summer.indd', 'kinetic')
  expect(styled.base).toBe('/united-summer/kinetic')
  expect(styled.pagePath('MedRect_300x250')).toBe('/united-summer/kinetic/medrect-300x250')
  expect(styled.rowsPath).toBe('/united-summer/kinetic/variations.json')
  expect(styled.previewUrl('MedRect_300x250', 'Spring A')).toBe('https://main--banner-ads--teammate.aem.page/united-summer/kinetic/medrect-300x250?v=Spring%20A')
})

test('whole-banner animation styles assign distinct choreographies and respect overrides', () => {
  expect(h.ANIMATION_STYLES.map((s) => s.id)).toEqual(['editorial', 'luxury', 'kinetic', 'retail', 'wipe', 'minimal'])
  expect(h.normalizeAnimationStyle('LUXURY')).toBe('luxury')
  expect(h.normalizeAnimationStyle('unknown')).toBe('editorial')
  expect(h.normalizeAnimationStyle('')).toBe('editorial')

  const page = {
    width: 300,
    height: 250,
    slices: [{ name: 'static-0', file: 's0.png', z: 0 }],
    elements: [
      { label: 'hero', kind: 'image', box: { x: 0, y: 0, w: 300, h: 250 }, z: 1 },
      { label: 'kicker', kind: 'text', box: { x: 16, y: 100, w: 200, h: 20 }, style: { size: 14 }, z: 2 },
      { label: 'headline', kind: 'text', box: { x: 16, y: 130, w: 268, h: 48 }, style: { size: 22 }, z: 3 },
      { label: 'cta', kind: 'text', box: { x: 16, y: 206, w: 120, h: 28 }, style: { button: true }, z: 4 }
    ]
  }
  const byStyle = (style, extra = {}) => Object.fromEntries(
    h.layersFromManifest(page, { animationStyle: style, duration: 6, ...extra }).map((l) => [l.name, l.motion])
  )
  expect(byStyle('editorial')).toEqual({ 'static-0': '', hero: 'kenburns', kicker: 'fadeUp@0.3/0.5', headline: 'fadeUp@0.6/0.5', cta: 'pulse@0.9/1' })
  expect(byStyle('luxury')).toEqual({ 'static-0': '', hero: 'kenburns', kicker: 'fadeDown@0.45/0.9', headline: 'fade@0.9/0.9', cta: 'fade@1.35/0.9' })
  expect(byStyle('kinetic')).toEqual({ 'static-0': '', hero: 'zoomIn@0/0.4', kicker: 'slideLeft@0.18/0.35', headline: 'slideRight@0.36/0.35', cta: 'pulse@0.54/0.7' })
  expect(byStyle('retail')).toEqual({ 'static-0': '', hero: 'zoomIn@0/0.5', kicker: 'zoomIn@0.25/0.45', headline: 'fadeDown@0.5/0.45', cta: 'pulse@0.75/1.2' })
  expect(byStyle('wipe')).toEqual({ 'static-0': '', hero: 'wipe@0/0.6', kicker: 'wipe@0.25/0.5', headline: 'wipe@0.5/0.5', cta: 'wipe@0.75/0.5' })
  expect(byStyle('minimal')).toEqual({ 'static-0': '', hero: 'fade@0/0.4', kicker: 'fade@0.35/0.4', headline: 'fade@0.7/0.4', cta: 'fade@1.05/0.4' })

  // Explicit pagemap and authored motion still win over the style choreography
  expect(byStyle('kinetic', { pagemapMotion: { headline: 'wipe@0.4' }, authored: { cta: 'fade@1' } })).toMatchObject({
    kicker: 'slideLeft@0.18/0.35',
    headline: 'wipe@0.4',
    cta: 'fade@1'
  })
})

test('parseAdPage round-trips an existing DA or EDS page into a reusable manifest page', () => {
  const layers = h.layersFromManifest(MANIFEST, {
    sliceUrl: (s) => `https://content.da.live/pnamadobe/banner-ads/cwfall/editorial/${s.name}.png`,
    animationStyle: 'editorial',
    duration: 6
  })
  const html = h.daPageHtml({ width: 300, height: 250, duration: 6, loops: 1, rowsPath: '/cwfall/editorial/variations.json', layers })
  const parsed = h.parseAdPage(html, 'https://main--banner-ads--pnamadobe.aem.page/cwfall/editorial/')
  expect(parsed).toMatchObject({
    width: 300,
    height: 250,
    slices: [
      { name: 'static-0', z: 0, box: { x: 0, y: 0, w: 300, h: 250 }, url: 'https://admin.da.live/source/pnamadobe/banner-ads/cwfall/editorial/static-0.png' },
      { name: 'static-1', z: 3, box: { x: 0, y: 0, w: 300, h: 250 }, url: 'https://admin.da.live/source/pnamadobe/banner-ads/cwfall/editorial/static-1.png' }
    ],
    elements: [
      { label: 'hero', kind: 'image', z: 1, box: { x: 0, y: 0, w: 300, h: 250 }, rawStyle: 'focus:50,30' },
      { label: 'headline', kind: 'text', z: 2, box: { x: 16, y: 150, w: 268, h: 48 }, rawStyle: '"Sans" 22' },
      { label: 'cta', kind: 'text', z: 4, box: { x: 16, y: 206, w: 120, h: 28 }, rawStyle: 'button' }
    ]
  })
  const restyled = h.layersFromManifest(parsed, { sliceUrl: (s) => `https://content.da.live/pnamadobe/banner-ads/cwfall/wipe/${s.name}.png`, animationStyle: 'wipe', duration: 6 })
  expect(restyled.map((l) => [l.name, l.motion, l.style])).toEqual([
    ['static-0', '', ''],
    ['hero', 'wipe@0/0.6', 'focus:50,30'],
    ['headline', 'wipe@0.25/0.5', '"Sans" 22'],
    ['static-1', '', ''],
    ['cta', 'wipe@0.5/0.5', 'button']
  ])
})

test('pagemap without an html5 column opts every page in', () => {
  const text = 'pagenumber,pagename\n1,WEB_LEADERBOARD_1000x320\n2,MedRect_300x250\n'
  expect(h.pagemapHtml5(text).map((p) => p.html5)).toEqual([true, true])
  const all = h.pagemapAllHtml5(text)
  expect(all.split('\n')[0]).toBe('pagenumber,pagename,html5')
  expect(all).toContain('2,MedRect_300x250,yes')
  expect(h.pagemapHtml5(all).map((p) => p.html5)).toEqual([true, true])
})

test('pagemap with an html5 column is left as authored', () => {
  expect(h.pagemapAllHtml5(PAGEMAP)).toBe(PAGEMAP)
  expect(h.pagemapHtml5(PAGEMAP).filter((p) => p.html5).length).toBe(2)
})

test('dropClickthroughColumns removes every click-through spelling and keeps the CSV intact', () => {
  const csv = 'outputFileName,headline,clickthru,cta,cta-link\r\nA,"Hi, ""you""","https://a.example/?x=1,2",Go,https://c.example\r\nB,"two\r\nlines",,Buy,\r\n'
  const { text, dropped } = h.dropClickthroughColumns(csv)
  expect(dropped).toEqual(['clickthru', 'cta-link'])
  expect(text).toBe('outputFileName,headline,cta\r\nA,"Hi, ""you""",Go\r\nB,"two\r\nlines",Buy\r\n')
  // The DA sheet built from the dropped text has no click-through, the original keeps it.
  expect(h.variationsSheet(text).data[0]).toEqual({ outputFileName: 'A', headline: 'Hi, "you"', cta: 'Go' })
  expect(h.variationsSheet(csv).data[0].clickthrough).toBe('https://a.example/?x=1,2')
})

test('dropClickthroughColumns: no click-through column, no change; a row left empty keeps its place', () => {
  const plain = 'outputFileName,headline\nA,Hi\n'
  expect(h.dropClickthroughColumns(plain)).toEqual({ text: plain, dropped: [] })
  expect(h.dropClickthroughColumns('')).toEqual({ text: '', dropped: [] })
  expect(h.dropClickthroughColumns('Landing Page URL\nhttps://x\n')).toEqual({ text: '""\n""\n', dropped: ['Landing Page URL'] })
  expect(h.dropClickthroughColumns('outputFileName,Exit URL\nA,https://x').text).toBe('outputFileName\nA')
})

test('unrotateBox recovers a rotated frame from its bounding box', () => {
  const t = 5.6 * Math.PI / 180
  const W = 400 * Math.cos(t) + 600 * Math.sin(t)
  const H = 400 * Math.sin(t) + 600 * Math.cos(t)
  const out = h.unrotateBox({ x: 100, y: 50, w: W, h: H }, -5.6)
  expect(out.w).toBeCloseTo(400, 6)
  expect(out.h).toBeCloseTo(600, 6)
  expect(out.x + out.w / 2).toBeCloseTo(100 + W / 2, 6)
  expect(out.y + out.h / 2).toBeCloseTo(50 + H / 2, 6)
  // no angle, or an angle too steep to invert: the box is kept
  const box = { x: 0, y: 0, w: 10, h: 20 }
  expect(h.unrotateBox(box, 0)).toBe(box)
  expect(h.unrotateBox(box, 44)).toBe(box)
})

test('layersFromManifest turns an exported rotation into a rotate token and the unrotated box', () => {
  const W = 400 * Math.cos(Math.PI / 36) + 300 * Math.sin(Math.PI / 36)
  const H = 400 * Math.sin(Math.PI / 36) + 300 * Math.cos(Math.PI / 36)
  const [hero, kicker] = h.layersFromManifest({
    width: 800,
    height: 600,
    elements: [
      { label: 'hero', z: 1, kind: 'image', rot: 5, box: { x: 10, y: 10, w: W, h: H }, crop: { fx: 50, fy: 40 } },
      { label: 'kicker', z: 2, kind: 'text', rot: 0.01, box: { x: 0, y: 0, w: 100, h: 20 }, style: { size: 21 } }
    ]
  })
  expect(hero.style).toBe('focus:50,40 rotate:-5')
  const [x, y, w, hh] = hero.box.split(',').map(Number)
  expect([w, hh]).toEqual([400, 300])
  expect(x + w / 2).toBeCloseTo(10 + W / 2, 0)
  expect(y + hh / 2).toBeCloseTo(10 + H / 2, 0)
  expect(kicker.style).toBe('21')
  expect(kicker.box).toBe('0,0,100,20')
})
