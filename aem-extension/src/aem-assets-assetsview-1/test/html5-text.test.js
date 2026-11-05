const h = require('../actions/generate-idapi-banners/html5.js')

// The app card's text layers as the capability exports them (box in px, size in pt).
const el = (label, x, y, w, ht, size, lead, extra = {}) => ({ label, kind: 'text', box: { x, y, w, h: ht }, style: { size, lead, ...extra } })
const appCard = () => ({
  width: 890,
  height: 1335,
  elements: [
    el('tag', 320, 172, 250, 42, 18.5, 22.2),
    el('kicker', 230, 306, 430, 29, 21, 25.2),
    el('headline', 230, 346, 430, 125, 106.5, 106.5),
    el('subhead', 230, 482, 430, 39, 28.5, 34.2),
    el('cta', 270, 690, 350, 84, 29, 34.8, { button: true }),
    el('legal', 235, 800, 420, 28, 18.5, 24.1)
  ]
})
const layer = (layers, name) => layers.find((l) => l.name === name)

describe('HTML5 text sizing', () => {
  test('an eyebrow over the largest text is raised to the ratio, growing upward', () => {
    const layers = h.layersFromManifest(appCard())
    const k = layer(layers, 'kicker')
    expect(k.style).toMatch(/^37\.3\/44\.7\b/) // 0.35 x 106.5
    expect(k.box).toBe('230,284,430,51') // bottom edge kept at 335, clear of the headline at 346
    // everything else stays as designed
    expect(layer(layers, 'headline').style).toMatch(/^106\.5\/106\.5/)
    expect(layer(layers, 'subhead').style).toMatch(/^28\.5\/34\.2/)
    expect(layer(layers, 'legal').style).toMatch(/^18\.5\/24\.1/)
    expect(layer(layers, 'tag').box).toBe('320,172,250,42')
  })

  test('growth stops short of the layer above', () => {
    const page = appCard()
    page.elements[0].box.y = 250 // tag bottom at 292: 4px margin leaves 39px of height
    const k = layer(h.layersFromManifest(page), 'kicker')
    expect(k.box).toBe('230,296,430,39')
  })

  test('text below or beside the largest text, and big-enough eyebrows, are left alone', () => {
    const page = appCard()
    page.elements[1].box.x = 700 // kicker no longer in the headline's column
    expect(layer(h.layersFromManifest(page), 'kicker').box).toBe('700,306,430,29')
    const big = appCard()
    big.elements[1].style.size = 40
    expect(layer(h.layersFromManifest(big), 'kicker').style).toMatch(/^40\/25\.2/)
  })

  test('TEXT_SCALE per label wins, and EYEBROW_RATIO 0 turns the rule off', () => {
    const off = h.layersFromManifest(appCard(), { text: { eyebrowRatio: 0, scale: {} } })
    expect(layer(off, 'kicker').style).toMatch(/^21\/25\.2/)
    const named = h.layersFromManifest(appCard(), { text: { eyebrowRatio: 0.35, scale: { kicker: 1, legal: 1.2 } } })
    expect(layer(named, 'kicker').style).toMatch(/^21\/25\.2/)
    expect(layer(named, 'legal').style).toMatch(/^22\.2\/28\.9/)
  })

  test('html5.json keys are validated', () => {
    const site = { DA_ORG: 'o', DA_SITE: 's' }
    expect(h.daConfig(site).text).toEqual({ eyebrowRatio: 0.35, scale: {} })
    expect(h.daConfig({ ...site, EYEBROW_RATIO: 0.4, TEXT_SCALE: { Kicker: 1.5 } }).text).toEqual({ eyebrowRatio: 0.4, scale: { kicker: 1.5 } })
    expect(() => h.daConfig({ ...site, EYEBROW_RATIO: 3 })).toThrow(/EYEBROW_RATIO/)
    expect(() => h.daConfig({ ...site, TEXT_SCALE: { kicker: 'big' } })).toThrow(/TEXT_SCALE/)
    expect(() => h.daConfig({ ...site, TEXT_SCALE: [] })).toThrow(/TEXT_SCALE/)
  })
})
