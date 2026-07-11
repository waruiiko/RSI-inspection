const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

function loadCrossMarket(phase = 'regular') {
  let source = fs.readFileSync(path.join(__dirname, '../renderer/src/utils/crossMarket.js'), 'utf8')
    .replace(/^import .*$/gm, '')
    .replace(/export const /g, 'const ')
    .replace(/export function /g, 'function ')
  const prelude = `
    const localStorage = { getItem: () => null };
    const assetKey = asset => String(asset.source || '') + ':' + String(asset.apiSymbol || asset.symbol || '');
    const underlyingKey = asset => (asset.type === 'stock' || asset.type === 'tradfi' ? 'equity:' : String(asset.type || 'asset') + ':') + String(asset.symbol || '').toUpperCase();
    const sameUnderlying = (a, b) => underlyingKey(a) === underlyingKey(b);
    const getUSMarketPhase = () => ${JSON.stringify(phase)};
  `
  return Function(`${prelude}\n${source}\nreturn { assessContractQuality, appendBasisSample, basisStatistics, buildCrossMarketIndex, crossMarketContext, reconcileDivergenceStates, reconcileOpenValidationQueue };`)()
}

test('cross-market context pairs cash and TradFi without conflating venue prices', () => {
  const { crossMarketContext } = loadCrossMarket()
  const cash = { symbol: 'AAPL', apiSymbol: 'AAPL', source: 'yahoo', type: 'stock', price: 200, signalHunter: { side: 'long', status: 'triggered' } }
  const perp = { symbol: 'AAPL', apiSymbol: 'AAPLUSDT', source: 'binance-futures', type: 'tradfi', price: 202, signalHunter: { side: 'long', status: 'armed' } }
  const result = crossMarketContext(perp, [cash, perp])
  assert.equal(result.confirmation, 'confirmed')
  assert.equal(result.basisPct, 1)
})

test('contract quality rejects thin wide-spread contracts', () => {
  const { assessContractQuality } = loadCrossMarket()
  const strong = assessContractQuality({ type: 'tradfi', quoteVolume24h: 60_000_000, liquidity: { spreadPct: 0.05, topBookNotional: 300_000 }, derivatives: { oiValue: 1 } })
  const weak = assessContractQuality({ type: 'tradfi', quoteVolume24h: 100_000, liquidity: { spreadPct: 0.8, topBookNotional: 1000 }, derivatives: {} })
  assert.equal(strong.executable, true)
  assert.equal(weak.executable, false)
})

test('basis statistics waits for samples and flags a large z-score', () => {
  const { basisStatistics } = loadCrossMarket()
  const history = { 'equity:AAPL': Array.from({ length: 20 }, (_, index) => ({ value: 0.1 + (index % 2) * 0.02 })) }
  assert.equal(basisStatistics(history, 'equity:AAPL', 0.5).abnormal, true)
  assert.equal(basisStatistics({ 'equity:AAPL': history['equity:AAPL'].slice(0, 5) }, 'equity:AAPL', 0.5).abnormal, false)
})

test('open validation queue changes pending TradFi signal to cash confirmation', () => {
  const offHours = loadCrossMarket('weekend')
  const perp = { symbol: 'AAPL', apiSymbol: 'AAPLUSDT', source: 'binance-futures', type: 'tradfi', price: 201, signalHunter: { side: 'long', timeframe: '1h', status: 'triggered' } }
  const pending = offHours.reconcileOpenValidationQueue([perp], [], 1000)
  assert.equal(pending[0].status, 'pending_open')
  const regular = loadCrossMarket('regular')
  const cash = { symbol: 'AAPL', apiSymbol: 'AAPL', source: 'yahoo', type: 'stock', price: 200, signalHunter: { side: 'long', timeframe: '1h', status: 'triggered' } }
  const checked = regular.reconcileOpenValidationQueue([perp, cash], pending, 2000)
  assert.equal(checked[0].status, 'confirmed')
})

test('unhealthy cash source pauses cross-market confirmation and basis', () => {
  const { crossMarketContext } = loadCrossMarket()
  const cash = { symbol: 'AAPL', source: 'yahoo', type: 'stock', price: 200, dataQuality: { ok: false }, signalHunter: { side: 'long', status: 'triggered' } }
  const perp = { symbol: 'AAPL', source: 'binance-futures', type: 'tradfi', price: 201, signalHunter: { side: 'long', status: 'triggered' } }
  const result = crossMarketContext(perp, [cash, perp])
  assert.equal(result.confirmation, 'cash_unavailable')
  assert.equal(result.basisPct, null)
})

test('divergence recovery waits one full signal timeframe', () => {
  const { buildCrossMarketIndex, reconcileDivergenceStates } = loadCrossMarket()
  const cash = { symbol: 'AAPL', source: 'yahoo', type: 'stock', price: 200, signalHunter: { side: 'long', timeframe: '1h', status: 'triggered' } }
  const perp = { symbol: 'AAPL', source: 'binance-futures', type: 'tradfi', price: 201, signalHunter: { side: 'short', timeframe: '1h', status: 'triggered' } }
  let states = reconcileDivergenceStates([cash, perp], {}, 1000, buildCrossMarketIndex([cash, perp]))
  assert.equal(states['equity:AAPL'].status, 'diverged')
  perp.signalHunter.side = 'long'
  states = reconcileDivergenceStates([cash, perp], states, 2000, buildCrossMarketIndex([cash, perp]))
  assert.equal(states['equity:AAPL'].status, 'recovering')
  states = reconcileDivergenceStates([cash, perp], states, 2000 + 60 * 60 * 1000, buildCrossMarketIndex([cash, perp]))
  assert.equal(states['equity:AAPL'].status, 'recovered')
})
