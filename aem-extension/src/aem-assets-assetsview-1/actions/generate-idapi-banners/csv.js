/*
 * CSV record splitting — pure; no I/O. Shared by the engine and the preflight so the
 * preflight sees exactly the records the render will.
 */

// Split CSV text into records. Quote-aware: a line break inside "..." stays in its record.
// Blank records are dropped; the record's own trailing line break is not kept.
function csvRecords (text) {
  const records = []
  let record = ''
  let quoted = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    record += ch
    if (ch === '"') quoted = !quoted // an escaped "" flips twice, so it never ends the cell
    if ((ch === '\n' || (ch === '\r' && text[i + 1] !== '\n')) && !quoted) {
      if (record.replace(/\r?\n$/, '').trim()) records.push(record.replace(/\r?\n$/, ''))
      record = ''
    }
  }
  if (record.trim()) records.push(record)
  return records
}

module.exports = { csvRecords }
