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

test('daConfig: defaults, override, validation; campaignPaths', () => {
  const cfg = h.daConfig({ DA_SITE: 'Banner-Ads' }, { DA_ORG: 'teammate' })
  expect(cfg).toMatchObject({ org: 'teammate', site: 'banner-ads', root: '/ads', ref: 'main', previewOrigin: 'https://main--banner-ads--teammate.aem.page' })
  expect(h.daConfig({}).org).toBe('pnamadobe')
  expect(() => h.daConfig({ DA_ORG: 'evil.com/x' })).toThrow(/invalid org/)
  expect(() => h.daConfig({ DA_ADS_ROOT: '/../x' })).toThrow(/DA_ADS_ROOT/)
  const p = h.campaignPaths(cfg, 'Spring Sale 2026!')
  expect(p.pagePath('MedRect_300x250')).toBe('/ads/spring-sale-2026/medrect-300x250')
  expect(p.rowsPath).toBe('/ads/spring-sale-2026/variations.json')
  expect(p.previewUrl('MedRect_300x250', 'Spring A')).toBe('https://main--banner-ads--teammate.aem.page/ads/spring-sale-2026/medrect-300x250?v=Spring%20A')

  // a sub-folder per template (the .indd name without its extension)
  const t = h.campaignPaths(cfg, 'Spring Sale 2026!', 'United Summer.indd')
  expect(t.pagePath('MedRect_300x250')).toBe('/ads/united-summer/spring-sale-2026/medrect-300x250')
  expect(t.rowsPath).toBe('/ads/united-summer/spring-sale-2026/variations.json')
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
