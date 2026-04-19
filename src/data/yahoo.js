// Direct Yahoo Finance fetcher — no third-party library needed
// Uses v8/finance/chart with browser-like headers

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept': 'application/json, text/plain, */*',
  'Accept-Language': 'en-US,en;q=0.9',
  'Referer': 'https://finance.yahoo.com/',
  'Origin': 'https://finance.yahoo.com',
}

// Yahoo doesn't support 4h natively — we aggregate from 1h
const YAHOO_INTERVAL = {
  '15m': '15m',
  '1h':  '60m',
  '4h':  '60m',
  '1d':  '1d',
}

// How much historical range to request per timeframe
const RANGE = {
  '15m': '5d',
  '1h':  '60d',
  '4h':  '60d',
  '1d':  '1y',
}

// Global rate limiter — 1 request per second max
let _lastRequest = 0
async function throttle() {
  const wait = 1100 - (Date.now() - _lastRequest)
  if (wait > 0) await new Promise(r => setTimeout(r, wait))
  _lastRequest = Date.now()
}

async function fetchOHLCV(symbol, interval, limit = 100, retries = 2) {
  await throttle()

  const yahooInterval = YAHOO_INTERVAL[interval]
  const range = RANGE[interval]
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?interval=${yahooInterval}&range=${range}&includePrePost=false`

  let res
  try {
    res = await fetch(url, { headers: HEADERS })
  } catch (err) {
    if (retries > 0) return fetchOHLCV(symbol, interval, limit, retries - 1)
    throw err
  }

  if (res.status === 429) {
    if (retries > 0) {
      await new Promise(r => setTimeout(r, 3000))
      return fetchOHLCV(symbol, interval, limit, retries - 1)
    }
    throw new Error(`Yahoo Finance rate limited: ${symbol} ${interval}`)
  }

  if (!res.ok) throw new Error(`Yahoo HTTP ${res.status}: ${symbol} ${interval}`)

  const json = await res.json()
  const result = json?.chart?.result?.[0]
  if (!result) {
    if (retries > 0) return fetchOHLCV(symbol, interval, limit, retries - 1)
    return []
  }

  const timestamps = result.timestamp ?? []
  const ohlcv = result.indicators?.quote?.[0] ?? {}

  const candles = timestamps
    .map((t, i) => ({
      time:   t * 1000,
      open:   ohlcv.open?.[i],
      high:   ohlcv.high?.[i],
      low:    ohlcv.low?.[i],
      close:  ohlcv.close?.[i],
      volume: ohlcv.volume?.[i] ?? 0,
    }))
    .filter(c => c.close != null)

  if (interval === '4h') return aggregateTo4h(candles).slice(-limit)
  return candles.slice(-limit)
}

function aggregateTo4h(candles) {
  const groups = new Map()
  for (const c of candles) {
    const key = Math.floor(c.time / 14_400_000) * 14_400_000
    if (!groups.has(key)) {
      groups.set(key, { ...c, time: key })
    } else {
      const g = groups.get(key)
      g.high   = Math.max(g.high, c.high)
      g.low    = Math.min(g.low, c.low)
      g.close  = c.close
      g.volume += c.volume
    }
  }
  return Array.from(groups.values()).sort((a, b) => a.time - b.time)
}

async function fetchQuote(symbol) {
  try {
    await throttle()
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?interval=1d&range=2d`
    const res = await fetch(url, { headers: HEADERS })
    if (!res.ok) return null
    const json = await res.json()
    const meta = json?.chart?.result?.[0]?.meta
    if (!meta) return null
    return {
      price:     meta.regularMarketPrice,
      change24h: ((meta.regularMarketPrice - meta.chartPreviousClose) / meta.chartPreviousClose) * 100,
    }
  } catch {
    return null
  }
}

async function validateTicker(ticker) {
  try {
    await throttle()
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?interval=1d&range=5d`
    const res = await fetch(url, { headers: HEADERS })
    if (!res.ok) return { valid: false }
    const json = await res.json()
    const meta = json?.chart?.result?.[0]?.meta
    if (!meta || !meta.regularMarketPrice) return { valid: false }
    return {
      valid:    true,
      name:     meta.longName || meta.shortName || ticker,
      price:    meta.regularMarketPrice,
      currency: meta.currency || 'USD',
    }
  } catch {
    return { valid: false }
  }
}

module.exports = { fetchOHLCV, fetchQuote, validateTicker }
