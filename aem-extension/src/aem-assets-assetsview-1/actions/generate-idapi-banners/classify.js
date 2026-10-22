/*
 * Folder-as-key classification: which entries in the job folder are the template, CSVs and images.
 * Pure (no I/O) so it can be unit-tested.
 */

function classify (entries, templateName) {
  const assets = entries.filter((e) => !e.isFolder)
  const isCsv = (n) => /\.csv$/i.test(n)
  const isImg = (n) => /\.(jpe?g|png)$/i.test(n)
  // The template the user selected, exactly; only without a selection fall back to the first "*template*.indd|psd".
  const template = templateName
    ? assets.find((e) => e.name === templateName)
    : assets.find((e) => /template/i.test(e.name) && /\.(indd|psd)$/i.test(e.name))
  const pagemap = assets.find((e) => /pagemap/i.test(e.name) && isCsv(e.name))
  const variations = assets.find((e) => isCsv(e.name) && e !== pagemap && !/pagemap/i.test(e.name))
  const images = assets.filter((e) => isImg(e.name))
  return { template, variations, pagemap, images }
}

module.exports = { classify }
