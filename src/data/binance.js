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
    time:               k[0],
    open:               parseFloat(k[1]),
    high:               parseFloat(k[2]),
    low:                parseFloat(k[3]),
    close:              parseFloat(k[4]),
    volume:             parseFloat(k[5]),
    closeTime:          k[6],
    quoteVolume:        parseFloat(k[7]),
    trades:             Number(k[8]),
    takerBuyBaseVolume: parseFloat(k[9]),
    takerBuyQuoteVolume: parseFloat(k[10]),
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
        quoteVolume24h: parseFloat(t.quoteVolume),
      }])
  )
}

async function fetchBookTickers(symbols) {
  if (!symbols.length) return {}
  const res = await fetch(`${BASE}/api/v3/ticker/bookTicker`)
  if (!res.ok) throw new Error(`Binance bookTicker ${res.status}`)
  return normalizeBookTickers(await res.json(), symbols)
}

async function fetchFuturesBookTickers(symbols) {
  if (!symbols.length) return {}
  const res = await fetch(`${FAPI_BASE}/fapi/v1/ticker/bookTicker`)
  if (!res.ok) throw new Error(`Binance Futures bookTicker ${res.status}`)
  return normalizeBookTickers(await res.json(), symbols)
}

function normalizeBookTickers(rows, symbols) {
  const set = new Set(symbols)
  return Object.fromEntries((rows ?? [])
    .filter(row => set.has(row.symbol))
    .map(row => {
      const bidPrice = parseFloat(row.bidPrice)
      const askPrice = parseFloat(row.askPrice)
      const bidQty = parseFloat(row.bidQty)
      const askQty = parseFloat(row.askQty)
      const mid = bidPrice > 0 && askPrice > 0 ? (bidPrice + askPrice) / 2 : null
      return [row.symbol, {
        bidPrice,
        askPrice,
        bidQty,
        askQty,
        spreadPct: mid ? ((askPrice - bidPrice) / mid) * 100 : null,
        topBookNotional: (bidPrice > 0 ? bidPrice * bidQty : 0) + (askPrice > 0 ? askPrice * askQty : 0),
      }]
    }))
}

async function fetchOrderBookDepth(symbol, futures = false, limit = 20) {
  const base = futures ? FAPI_BASE : BASE
  const path = futures ? '/fapi/v1/depth' : '/api/v3/depth'
  const res = await fetch(`${base}${path}?symbol=${encodeURIComponent(symbol)}&limit=${limit}`)
  if (!res.ok) throw new Error(`Binance${futures ? ' Futures' : ''} depth ${res.status} ${symbol}`)
  const raw = await res.json()
  const bids = (raw.bids ?? []).map(([price, qty]) => [parseFloat(price), parseFloat(qty)])
  const asks = (raw.asks ?? []).map(([price, qty]) => [parseFloat(price), parseFloat(qty)])
  const notionals = [1000, 5000, 10000]
  return {
    fetchedAt: Date.now(),
    levels: Math.min(bids.length, asks.length),
    bidCapacity: bids.reduce((sum, [price, qty]) => sum + price * qty, 0),
    askCapacity: asks.reduce((sum, [price, qty]) => sum + price * qty, 0),
    buy: depthExecution(asks, notionals),
    sell: depthExecution(bids, notionals),
  }
}

function depthExecution(levels, notionals) {
  const best = levels[0]?.[0]
  return Object.fromEntries(notionals.map(notional => {
    let remaining = notional
    let quantity = 0
    let cost = 0
    for (const [price, availableQty] of levels) {
      if (!Number.isFinite(price) || !Number.isFinite(availableQty) || price <= 0 || availableQty <= 0) continue
      const takeQty = Math.min(availableQty, remaining / price)
      quantity += takeQty
      cost += takeQty * price
      remaining -= takeQty * price
      if (remaining <= 0.01) break
    }
    const vwap = quantity > 0 ? cost / quantity : null
    const filled = Math.max(0, notional - remaining)
    const slippagePct = Number.isFinite(best) && Number.isFinite(vwap) && best > 0
      ? (Math.abs(vwap - best) / best) * 100
      : null
    return [String(notional), { notional, filled, fillRatio: notional ? filled / notional : 0, vwap, slippagePct }]
  }))
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
    time:               k[0],
    open:               parseFloat(k[1]),
    high:               parseFloat(k[2]),
    low:                parseFloat(k[3]),
    close:              parseFloat(k[4]),
    volume:             parseFloat(k[5]),
    closeTime:          k[6],
    quoteVolume:        parseFloat(k[7]),
    trades:             Number(k[8]),
    takerBuyBaseVolume: parseFloat(k[9]),
    takerBuyQuoteVolume: parseFloat(k[10]),
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
        quoteVolume24h: parseFloat(t.quoteVolume),
      }])
  )
}

async function fetchTopFuturesByVolume(symbols, limit = 50) {
  const url = `${FAPI_BASE}/fapi/v1/ticker/24hr`
  const res = await fetch(url)
  if (!res.ok) throw new Error(`Binance Futures ticker ${res.status}`)
  const all = await res.json()
  const allowed = new Set(symbols ?? [])
  return all
    .filter(t => t.symbol?.endsWith('USDT'))
    .filter(t => !allowed.size || allowed.has(t.symbol))
    .map(t => ({
      symbol: t.symbol,
      quoteVolume24h: parseFloat(t.quoteVolume) || 0,
      change24h: parseFloat(t.priceChangePercent),
      price: parseFloat(t.lastPrice),
    }))
    .sort((a, b) => b.quoteVolume24h - a.quoteVolume24h)
    .slice(0, limit)
}

async function fetchFuturesOpenInterestHist(symbol, period = '1h', limit = 24) {
  const KEY = `binance:futures:oi:${symbol}:${period}:${limit}`, TTL = 5 * 60 * 1000
  const cached = cache.get(KEY)
  if (cached) return cached

  const url = `${FAPI_BASE}/futures/data/openInterestHist?symbol=${symbol}&period=${period}&limit=${limit}`
  const res = await fetch(url)
  if (!res.ok) throw new Error(`Binance Futures OI ${res.status} ${symbol}`)
  const raw = await res.json()
  const data = raw.map(x => ({
    symbol: x.symbol,
    openInterest: parseFloat(x.sumOpenInterest),
    openInterestValue: parseFloat(x.sumOpenInterestValue),
    timestamp: Number(x.timestamp),
  }))
  cache.set(KEY, data, TTL)
  return data
}

async function fetchFuturesPremiumIndex(symbol) {
  const KEY = `binance:futures:premium:${symbol}`, TTL = 2 * 60 * 1000
  const cached = cache.get(KEY)
  if (cached) return cached

  const url = `${FAPI_BASE}/fapi/v1/premiumIndex?symbol=${symbol}`
  const res = await fetch(url)
  if (!res.ok) throw new Error(`Binance Futures premium ${res.status} ${symbol}`)
  const x = await res.json()
  const data = {
    symbol: x.symbol,
    markPrice: parseFloat(x.markPrice),
    indexPrice: parseFloat(x.indexPrice),
    lastFundingRate: parseFloat(x.lastFundingRate),
    nextFundingTime: Number(x.nextFundingTime),
    time: Number(x.time),
  }
  cache.set(KEY, data, TTL)
  return data
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
  fetchKlines, fetchTickers, fetchBookTickers, fetchAllUsdtPairs,
  fetchFuturesKlines, fetchFuturesTickers, fetchFuturesBookTickers, fetchAllFuturesPairs,
  fetchOrderBookDepth,
  fetchTopFuturesByVolume,
  fetchFuturesOpenInterestHist, fetchFuturesPremiumIndex,
  __test: { depthExecution, normalizeBookTickers },
}
