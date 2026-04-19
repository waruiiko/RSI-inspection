const BASE       = 'https://api.binance.com'
const FAPI_BASE  = 'https://fapi.binance.com'
const cache      = require('../cache')

const INTERVAL_MAP = {
  '15m': '15m',
  '1h':  '1h',
  '4h':  '4h',
  '1d':  '1d',
}

async function fetchKlines(symbol, interval, limit = 100) {
  const mapped = INTERVAL_MAP[interval]
  if (!mapped) throw new Error(`Unsupported interval: ${interval}`)

  const url = `${BASE}/api/v3/klines?symbol=${symbol}&interval=${mapped}&limit=${limit}`
  const res = await fetch(url)
  if (!res.ok) throw new Error(`Binance ${res.status} ${symbol} ${interval}`)

  const raw = await res.json()
  return raw.map(k => ({
    time:   k[0],
    open:   parseFloat(k[1]),
    high:   parseFloat(k[2]),
    low:    parseFloat(k[3]),
    close:  parseFloat(k[4]),
    volume: parseFloat(k[5]),
  }))
}

// Single request returns all tickers — very efficient
async function fetchTickers(symbols) {
  const url = `${BASE}/api/v3/ticker/24hr`
  const res = await fetch(url)
  if (!res.ok) throw new Error(`Binance ticker ${res.status}`)

  const all = await res.json()
  const set = new Set(symbols)
  return Object.fromEntries(
    all
      .filter(t => set.has(t.symbol))
      .map(t => [t.symbol, {
        price:     parseFloat(t.lastPrice),
        change24h: parseFloat(t.priceChangePercent),
        volume24h: parseFloat(t.quoteVolume),
      }])
  )
}

async function fetchAllUsdtPairs() {
  const KEY = 'binance:spotPairs', TTL = 60 * 60 * 1000
  const cached = cache.get(KEY)
  if (cached) return cached

  const res = await fetch(`${BASE}/api/v3/exchangeInfo?permissions=SPOT`)
  if (!res.ok) throw new Error(`Binance exchangeInfo ${res.status}`)
  const data = await res.json()
  const pairs = data.symbols
    .filter(s => s.quoteAsset === 'USDT' && s.status === 'TRADING' && s.isSpotTradingAllowed)
    .map(s => ({ symbol: s.baseAsset, apiSymbol: s.symbol }))
    .sort((a, b) => a.symbol.localeCompare(b.symbol))
  cache.set(KEY, pairs, TTL)
  return pairs
}

// ── Futures (USD-M perpetual) ─────────────────────────────

async function fetchFuturesKlines(symbol, interval, limit = 100) {
  const mapped = INTERVAL_MAP[interval]
  if (!mapped) throw new Error(`Unsupported interval: ${interval}`)
  const url = `${FAPI_BASE}/fapi/v1/klines?symbol=${symbol}&interval=${mapped}&limit=${limit}`
  const res = await fetch(url)
  if (!res.ok) throw new Error(`Binance Futures ${res.status} ${symbol} ${interval}`)
  const raw = await res.json()
  return raw.map(k => ({
    time:   k[0],
    open:   parseFloat(k[1]),
    high:   parseFloat(k[2]),
    low:    parseFloat(k[3]),
    close:  parseFloat(k[4]),
    volume: parseFloat(k[5]),
  }))
}

async function fetchFuturesTickers(symbols) {
  if (!symbols.length) return {}
  const url = `${FAPI_BASE}/fapi/v1/ticker/24hr`
  const res = await fetch(url)
  if (!res.ok) throw new Error(`Binance Futures ticker ${res.status}`)
  const all = await res.json()
  const set = new Set(symbols)
  return Object.fromEntries(
    all
      .filter(t => set.has(t.symbol))
      .map(t => [t.symbol, {
        price:     parseFloat(t.lastPrice),
        change24h: parseFloat(t.priceChangePercent),
        volume24h: parseFloat(t.quoteVolume),
      }])
  )
}

async function fetchAllFuturesPairs() {
  const KEY = 'binance:futuresPairs', TTL = 60 * 60 * 1000
  const cached = cache.get(KEY)
  if (cached) return cached

  const res = await fetch(`${FAPI_BASE}/fapi/v1/exchangeInfo`)
  if (!res.ok) throw new Error(`Binance Futures exchangeInfo ${res.status}`)
  const data = await res.json()
  const pairs = data.symbols
    .filter(s => s.quoteAsset === 'USDT' && s.status === 'TRADING'
      && (s.contractType === 'PERPETUAL' || s.contractType === 'TRADIFI_PERPETUAL'))
    .map(s => ({ symbol: s.baseAsset, apiSymbol: s.symbol, contractType: s.contractType }))
    .sort((a, b) => a.symbol.localeCompare(b.symbol))
  cache.set(KEY, pairs, TTL)
  return pairs
}

module.exports = {
  fetchKlines, fetchTickers, fetchAllUsdtPairs,
  fetchFuturesKlines, fetchFuturesTickers, fetchAllFuturesPairs,
}
