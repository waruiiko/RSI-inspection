const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const binance = require('../src/data/binance')
const config = require('../src/config')
const { getUSMarketSession } = require('../src/marketHours')
const ipc = require('../src/ipc')
const codexReview = require('../src/codexReview')

test('depth execution calculates fill ratio, VWAP and slippage', () => {
  const result = binance.__test.depthExecution([[100, 2], [101, 10]], [500])['500']
  assert.equal(result.fillRatio, 1)
  assert.ok(result.vwap > 100)
  assert.ok(result.slippagePct > 0)

  const insufficient = binance.__test.depthExecution([[100, 1]], [1000])['1000']
  assert.equal(insufficient.fillRatio, 0.1)
})

test('US market session distinguishes regular, premarket and holiday', () => {
  assert.equal(getUSMarketSession(new Date('2026-07-06T14:00:00Z')), 'regular')
  assert.equal(getUSMarketSession(new Date('2026-07-06T12:00:00Z')), 'premarket')
  assert.equal(getUSMarketSession(new Date('2026-07-03T15:00:00Z')), 'closed')
})

test('shadow parameter profile is stricter without replacing stable profile', () => {
  const asset = { source: 'binance-futures' }
  const stable = ipc.__test.signalHunterParameterProfile(asset, 600_000_000, 'v1')
  const shadow = ipc.__test.signalHunterParameterProfile(asset, 600_000_000, 'v2')
  assert.equal(stable.version, 'v1')
  assert.equal(shadow.version, 'v2')
  assert.ok(shadow.minTurnover > stable.minTurnover)
  assert.ok(shadow.maxSpreadPct < stable.maxSpreadPct)
  assert.ok(shadow.maxSlippagePct < stable.maxSlippagePct)
})

test('replay entry requires touch and recovery close', () => {
  const plan = { side: 'long', entryMode: 'pullback', entryPrice: 100 }
  assert.equal(ipc.__test.replayEntryConfirmed(plan, { high: 102, low: 99.8, close: 101 }), true)
  assert.equal(ipc.__test.replayEntryConfirmed(plan, { high: 101, low: 99.8, close: 99 }), false)
})

test('signal lifecycle file replaces prior content through atomic save', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'signal-hunter-test-'))
  try {
    config.init(dir)
    config.saveSignalLifecycle([{ key: 'a' }])
    config.saveSignalLifecycle([{ key: 'b' }, { key: 'c' }])
    assert.deepEqual(config.loadSignalLifecycle(), [{ key: 'b' }, { key: 'c' }])
    assert.equal(fs.readdirSync(dir).some(name => name.endsWith('.tmp')), false)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('Codex screen schema constrains Signal Hunter output to JSON', () => {
  const schema = codexReview.__test.screenOutputSchema('signal-hunter-interest-BTC')
  assert.deepEqual(schema.required, ['summary', 'items'])
  assert.equal(schema.properties.items.items.properties.timeframe.enum.includes('15m'), false)
  assert.equal(schema.properties.items.items.additionalProperties, false)
})

test('Signal Hunter keeps deterministic plans when AI output is invalid', () => {
  const fallback = codexReview.__test.deterministicScreenFallback({
    scope: 'signal-hunter',
    candidates: [{
      key: 'binance-futures:BTCUSDT',
      symbol: 'BTC',
      deterministicPlan: {
        status: 'armed', side: 'long', timeframe: '1h', entryMode: 'pullback',
        setup: 'pullback_long', setupLabel: 'EMA 回踩多', entryPrice: 100,
        confirmPrice: 101, stopLoss: 98, targets: [102, 104], rewardRisk: 2,
      },
    }],
  }, 'invalid JSON')
  assert.equal(fallback._meta.degraded, true)
  assert.equal(fallback.items[0].key, 'binance-futures:BTCUSDT')
  assert.equal(fallback.items[0].entryPrice, 100)
})

test('operational data keeps an atomic backup and restores it when primary JSON is corrupt', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'operational-data-test-'))
  try {
    config.init(dir)
    config.saveOperationalData('watchPool', [{ symbol: 'BTC' }])
    config.saveOperationalData('watchPool', [{ symbol: 'ETH' }])
    fs.writeFileSync(path.join(dir, 'watch-pool.json'), '{broken', 'utf8')
    assert.deepEqual(config.loadOperationalData('watchPool'), [{ symbol: 'BTC' }])
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
