const { keyFor, publicJob } = require('../actions/job-utils')

test('job key is deterministic and separates editable-output jobs', () => {
  expect(keyFor('/content/dam/campaign', false)).toBe(keyFor('/content/dam/campaign', false))
  expect(keyFor('/content/dam/campaign', false)).not.toBe(keyFor('/content/dam/campaign', true))
  expect(keyFor('/content/dam/campaign', false)).toMatch(/^idapi-job-[a-f0-9]{48}$/)
})

test('public status does not expose orchestration state', () => {
  expect(publicJob({ jobId: 'abc', folder: '/content/dam/x', status: 'running', outputs: ['a.png'], secret: 'nope' }))
    .toEqual(expect.objectContaining({ jobId: 'abc', status: 'running', count: 1 }))
  expect(publicJob({ secret: 'nope' })).not.toHaveProperty('secret')
})

test('count only includes banner deliverables, not the run log', () => {
  expect(publicJob({ outputs: ['a.jpg', 'b.PNG', 'c.indd', '_run_log.txt'] }).count).toBe(3)
})

test('output link deep-links the stamped subfolder in Assets View', () => {
  const { outputUrl } = require('../actions/job-utils')
  const params = { ASSETS_VIEW_TENANT: '@acme', AEM_AUTHOR_URL: 'https://author-p1-e2.adobeaemcloud.com' }
  expect(outputUrl({ folder: '/content/dam/a b', outputFolder: '/content/dam/a b/output/2026-10-22_171540' }, params))
    .toBe('https://experience.adobe.com/?repoId=author-p1-e2.adobeaemcloud.com#/@acme/assets/browse/content/dam/a%20b/output/2026-10-22_171540')
  expect(outputUrl({ folder: '/content/dam/x' }, params)).toMatch(/browse\/content\/dam\/x\/output$/)
  expect(outputUrl({ folder: '/content/dam/x' }, { AEM_AUTHOR_URL: params.AEM_AUTHOR_URL })).toBeUndefined() // no tenant -> no link
})

describe('selected template', () => {
  const { keyFor, isTemplateName } = require('../actions/job-utils')
  const { classify } = require('../actions/generate-idapi-banners/classify')
  const entry = (name) => ({ name, isFolder: false })
  const folder = ['a-template.psd', 'b-template.psd', 'old-template.indd', 'campaign-pagemap.csv', 'campaign-variations.csv', 'hero.png'].map(entry)

  test('uses exactly the selected file even when several templates are present', () => {
    expect(classify(folder, 'b-template.psd').template.name).toBe('b-template.psd')
    expect(classify(folder, 'old-template.indd').template.name).toBe('old-template.indd')
    expect(classify(folder, 'a-template.psd').pagemap.name).toBe('campaign-pagemap.csv')
  })

  test('a selected template that is not in the folder is not silently replaced', () => {
    expect(classify(folder, 'missing.psd').template).toBeUndefined()
  })

  test('without a selection it keeps the old "first *template*" behaviour', () => {
    expect(classify(folder).template.name).toBe('a-template.psd')
  })

  test('each template gets its own job; legacy keys are unchanged', () => {
    expect(keyFor('/f', false, 'a.psd')).not.toBe(keyFor('/f', false, 'b.psd'))
    expect(keyFor('/f', false, 'a.psd')).not.toBe(keyFor('/f', true, 'a.psd'))
    expect(keyFor('/f', false)).toBe(keyFor('/f', false, ''))
    expect(keyFor('/f', false, 'a.psd')).toMatch(/^idapi-job-[a-f0-9]{48}$/)
  })

  test('template must be a bare .indd/.psd file name', () => {
    expect(['a.psd', 'My Template.INDD'].every(isTemplateName)).toBe(true)
    expect(['../a.psd', 'x/a.psd', 'a.csv', '', undefined].some(isTemplateName)).toBe(false)
  })
})
