const fs = require('fs')
const path = require('path')
const os = require('os')
const { __test } = require('../src/ipc')

const cacheDir = process.argv[2] || path.join(os.homedir(), 'AppData', 'Roaming', 'market-rsi', 'market-cache-v2')
const reports = []

for (const name of fs.readdirSync(cacheDir)) {
  if (!name.endsWith('.json')) continue
  let key
  try { key = Buffer.from(name.slice(0, -5), 'base64url').toString('utf8') } catch { continue }
  const [source, apiSymbol, timeframe] = key.split(':')
  if (!['1h', '4h'].includes(timeframe)) continue
  let payload
  try { payload = JSON.parse(fs.readFileSync(path.join(cacheDir, name), 'utf8')) } catch { continue }
  if (!Array.isArray(payload.candles) || payload.candles.length < 65) continue
  reports.push(__test.runSignalHunterReplay({ symbol: apiSymbol, apiSymbol, source }, timeframe, payload.candles))
}

const outcomes = reports.flatMap(report => report.outcomes ?? []).filter(item => item.result === 'win' || item.result === 'loss')
function summarize(rows) {
  const wins = rows.filter(item => item.result === 'win').length
  return { samples: rows.length, wins, winRate: rows.length ? Number((wins / rows.length * 100).toFixed(1)) : null }
}
function groups(key) {
  return Object.fromEntries(Object.entries(Object.groupBy(outcomes, item => item[key] ?? 'unknown'))
    .map(([name, rows]) => [name, summarize(rows)]))
}

const screens = [
  ['trend only', item => item.marketRegime === 'trend'],
  ['trend EMA', item => item.marketRegime === 'trend' && ['pullback_long', 'rebound_short'].includes(item.setup)],
  ['EMA slope aligned', item => ['pullback_long', 'rebound_short'].includes(item.setup) && (item.side === 'short' ? item.ema21SlopePct < 0 : item.ema21SlopePct > 0)],
  ['4h EMA aligned', item => item.timeframe === '4h' && ['pullback_long', 'rebound_short'].includes(item.setup) && (item.side === 'short' ? item.ema21SlopePct < 0 : item.ema21SlopePct > 0)],
  ['low-vol EMA aligned', item => item.marketRegime === 'low_volatility' && ['pullback_long', 'rebound_short'].includes(item.setup) && (item.side === 'short' ? item.ema21SlopePct < 0 : item.ema21SlopePct > 0)],
  ['retest 3 touches', item => item.setup.startsWith('retest_') && (item.side === 'short' ? item.resistanceTouches : item.supportTouches) >= 3],
  ['score 7+', item => item.score >= 7],
  ['RR 2+', item => item.rewardRisk >= 2],
].map(([name, predicate]) => [name, summarize(outcomes.filter(predicate))])

process.stdout.write(JSON.stringify({
  cacheDir,
  reports: reports.length,
  overall: summarize(outcomes),
  timeframe: groups('timeframe'),
  setup: groups('setup'),
  side: groups('side'),
  regime: groups('marketRegime'),
  screens: Object.fromEntries(screens),
}, null, 2))
