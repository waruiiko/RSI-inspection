const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

function loadCompanyEvents() {
  const source = fs.readFileSync(path.join(__dirname, '../renderer/src/utils/companyEvents.js'), 'utf8')
    .replace(/export const /g, 'const ')
    .replace(/export function /g, 'function ')
  return Function(`${source}\nreturn { eventGuard, eventsForAsset };`)()
}

test('earnings event opens a caution window one day before and after', () => {
  const { eventGuard } = loadCompanyEvents()
  const at = Date.UTC(2026, 6, 20, 12)
  assert.equal(eventGuard({ eventType: 'earnings', effectiveAt: at }, at - 12 * 60 * 60 * 1000).active, true)
  assert.equal(eventGuard({ eventType: 'earnings', effectiveAt: at }, at - 48 * 60 * 60 * 1000).active, false)
})

test('split and halt events are blocking while ordinary filings are caution only', () => {
  const { eventGuard } = loadCompanyEvents()
  const now = Date.now()
  assert.equal(eventGuard({ eventType: 'split', effectiveAt: now }, now).blocking, true)
  assert.equal(eventGuard({ eventType: 'halt', effectiveAt: now }, now).blocking, true)
  assert.equal(eventGuard({ eventType: 'material_filing', effectiveAt: now }, now).blocking, false)
})
