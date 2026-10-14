const { planRelations, newItems } = require('../actions/generate-idapi-banners/relations')

test('plans template->INDD derived and two-way INDD<->image other, grouped per asset', () => {
  const plan = planRelations('T', [
    { inddId: 'I6', imageIds: ['P6', 'L', 'P6'] },
    { inddId: 'I7', imageIds: ['P7', 'L'] }
  ])
  const by = Object.fromEntries(plan.map((p) => [p.onId, p.items]))
  expect(by.T).toEqual([{ assetId: 'I6', relationType: 'derived' }, { assetId: 'I7', relationType: 'derived' }])
  expect(by.I6).toEqual([{ assetId: 'P6', relationType: 'other' }, { assetId: 'L', relationType: 'other' }])
  expect(by.L).toEqual([{ assetId: 'I6', relationType: 'other' }, { assetId: 'I7', relationType: 'other' }])
  expect(by.P7).toEqual([{ assetId: 'I7', relationType: 'other' }])
})

test('skips pairs the asset already has', () => {
  const wanted = [{ assetId: 'A', relationType: 'other' }, { assetId: 'B', relationType: 'other' }]
  expect(newItems([{ assetId: 'A', relationType: 'sources' }], wanted)).toEqual([wanted[1]])
  expect(newItems(undefined, wanted)).toEqual(wanted)
})
