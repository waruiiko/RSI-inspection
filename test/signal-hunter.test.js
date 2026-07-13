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
  assert.deepEqual(schema.properties.items.items.required, ['key', 'symbol', 'narrativeSummary', 'riskNarrative', 'narrativeTags'])
  assert.equal('entryPrice' in schema.properties.items.items.properties, false)
  assert.equal(schema.properties.items.items.additionalProperties, false)
})

test('Codex JSON extractor tolerates prose, multiple fences and braces inside strings', () => {
  const text = '说明文字\n```text\nnot json\n```\n```json\n{"summary":"含有 } 字符","items":[]}\n```\n结束'
  assert.deepEqual(codexReview.__test.extractJson(text), { summary: '含有 } 字符', items: [] })
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

test('Signal Hunter sends Codex a compact prompt without large duplicate market structures', () => {
  const payload = codexReview.__test.screenPromptPayload({
    scope: 'signal-hunter',
    candidates: [{
      key: 'binance-futures:BTCUSDT',
      symbol: 'BTC',
      price: 100,
      derivatives: { oiChange4h: 2, fundingRate: 0.01, depth: { large: true } },
      liquidity: { spreadPct: 0.01, topBookNotional: 50000, depth: { large: true } },
      localSignalHunter: { duplicate: true },
      timeframeCandidates: [{ duplicate: true }],
      deterministicPlan: { status: 'armed', entryPrice: 99 },
    }],
  })
  const candidate = payload.candidates[0]
  assert.equal(candidate.deterministicPlan.entryPrice, 99)
  assert.equal(candidate.liquidity.spreadPct, 0.01)
  assert.equal('localSignalHunter' in candidate, false)
  assert.equal('timeframeCandidates' in candidate, false)
  assert.equal('depth' in candidate.liquidity, false)
  assert.equal('depth' in candidate.derivatives, false)
})

test('Signal Hunter canonical result keeps local execution plan and only accepts AI narrative', () => {
  const result = codexReview.__test.canonicalScreenResult({
    candidates: [{
      key: 'binance-futures:BTCUSDT', symbol: 'BTC',
      deterministicPlan: {
        status: 'armed', side: 'long', timeframe: '1h', entryMode: 'pullback',
        setup: 'pullback_long', setupLabel: 'EMA 回踩多', entryPrice: 100,
        confirmPrice: 101, stopLoss: 98, targets: [102, 104], rewardRisk: 2,
        score: { total: 8, chart: 8, data: 7, risk: 1 }, reasons: ['本地依据'], riskFlags: [], rejectReasons: [],
      },
    }],
  }, [{
    key: 'binance-futures:BTCUSDT', symbol: 'BTC', entryPrice: 999, status: 'triggered',
    narrativeSummary: '结构说明', riskNarrative: '风险说明', narrativeTags: ['回踩'],
  }])
  assert.equal(result.items[0].entryPrice, 100)
  assert.equal(result.items[0].status, 'armed')
  assert.equal(result.items[0].narrativeSummary, '结构说明')
  assert.equal(result._meta.missing, 0)
})

test('Codex screen failures distinguish timeout, process and truncated output', () => {
  assert.equal(codexReview.__test.classifyScreenFailure({ timedOut: true }, '', null), 'timeout')
  assert.equal(codexReview.__test.classifyScreenFailure({ ok: false }, '', null), 'process_error')
  assert.equal(codexReview.__test.classifyScreenFailure({ ok: true }, '{"items":[', null), 'truncated_output')
})

test('Signal Hunter chunks candidates and reuses a fresh unchanged narrative', () => {
  assert.deepEqual(codexReview.__test.chunkScreenCandidates(Array.from({ length: 60 }), 24).map(batch => batch.length), [24, 24, 12])
  const now = Date.now()
  const cached = codexReview.__test.persistedNarrativeItem({
    key: 'x', symbol: 'BTC',
    localSignalHunter: { side: 'long', timeframe: '1h', entryMode: 'pullback', setup: 'pullback_long', entryPrice: 100, narrativeSummary: '旧摘要' },
    deterministicPlan: { side: 'long', timeframe: '1h', entryMode: 'pullback', setup: 'pullback_long', entryPrice: 100.1 },
  }, now - 1000, now, 90 * 60 * 1000, { pipeline: 'sh-ai-v3', schema: 'narrative-v2', prompt: 'narrative-v2', strategy: 'strict-entry-v2' })
  assert.equal(cached.narrativeSummary, '旧摘要')
  assert.equal(codexReview.__test.persistedNarrativeItem({ localSignalHunter: {}, deterministicPlan: {} }, 0, now), null)
})

test('Signal Hunter runtime presets, priority queue and narrative quality are deterministic', () => {
  const options = codexReview.__test.screenRuntimeOptions({ shAiProfile: 'fast' })
  assert.equal(options.profile, 'fast')
  assert.equal(options.batchSize, 24)
  assert.equal(options.concurrency, 2)
  assert.equal(options.cacheMinutes, 60)
  const ordered = codexReview.__test.prioritizeScreenCandidates([
    { key: 'watch', priority: 99, deterministicPlan: { status: 'watch', executionEligible: false } },
    { key: 'ready', priority: 1, deterministicPlan: { status: 'triggered', executionEligible: true } },
  ])
  assert.equal(ordered[0].key, 'ready')
  const keys = new Set(['ready'])
  assert.equal(codexReview.__test.validNarrativeItem({ key: 'ready', narrativeSummary: '趋势回踩结构保持稳定', riskNarrative: '关注量能变化', narrativeTags: ['回踩'] }, keys), true)
  assert.equal(codexReview.__test.validNarrativeItem({ key: 'ready', narrativeSummary: '建议买入', riskNarrative: '风险较低', narrativeTags: [] }, keys), false)
})

test('Signal Hunter cache versions reject incompatible narratives', () => {
  assert.equal(codexReview.__test.sameScreenVersions(codexReview.__test.SCREEN_VERSIONS), true)
  assert.equal(codexReview.__test.sameScreenVersions({ pipeline: 'old' }), false)
})

test('diagnostic ZIP is valid and sensitive fields are redacted', () => {
  const sanitized = ipc.__test.sanitizeDiagnostics({ telegramToken: 'secret', path: 'C:\\Users\\Alice\\data', ok: true })
  assert.equal(sanitized.telegramToken, '[redacted]')
  assert.match(sanitized.path, /%USERPROFILE%/)
  const zip = ipc.__test.createStoredZip([['diagnostics.json', JSON.stringify(sanitized)]])
  assert.equal(zip.subarray(0, 2).toString(), 'PK')
  assert.ok(zip.includes(Buffer.from('diagnostics.json')))
})

test('shadow prompt is isolated and requests schema-only evaluation', () => {
  const prompt = codexReview.__test.buildShadowScreenPrompt({ candidates: [{ key: 'x' }] })
  assert.match(prompt, /影子叙述评估器/)
  assert.match(prompt, /严格输出Schema JSON/)
  assert.match(prompt, /"key": "x"/)
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

test('runtime health history is persisted as operational data', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-health-test-'))
  try {
    config.init(dir)
    const events = [{ ts: 1, scope: 'binance', level: 'warn', message: 'timeout' }]
    config.saveOperationalData('runtimeHealth', events)
    assert.deepEqual(config.loadOperationalData('runtimeHealth'), events)
    assert.equal(fs.existsSync(path.join(dir, 'runtime-health.json')), true)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('shadow strategy observations use atomic operational storage', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shadow-strategy-test-'))
  try {
    config.init(dir)
    const payload = { observations: [{ id: 'scan:BTC', stablePassed: true, shadowPassed: false }], plans: [] }
    config.saveOperationalData('shadowStrategy', payload)
    assert.deepEqual(config.loadOperationalData('shadowStrategy'), payload)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('rule drift snapshots use atomic operational storage', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rule-drift-test-'))
  try {
    config.init(dir)
    const snapshots = [{ scanAt: 1, counts: { scanned: 10, accepted: 2 } }]
    config.saveOperationalData('ruleDrift', snapshots)
    assert.deepEqual(config.loadOperationalData('ruleDrift'), snapshots)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
