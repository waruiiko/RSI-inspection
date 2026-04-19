const binance = require('./binance')
const yahoo   = require('./yahoo')
const cache   = require('../cache')

// How long to cache each timeframe's OHLCV
const CACHE_TTL = {
  '15m':   60_000,
  '1h':   300_000,
  '4h':   900_000,
  '1d': 3_600_000,
}

async function fetchOHLCV(asset, timeframe) {
  const key = `ohlcv:${asset.apiSymbol}:${timeframe}`
  const cached = cache.get(key)
  if (cached) return cached

  let data
  if (asset.source === 'binance') {
    data = await binance.fetchKlines(asset.apiSymbol, timeframe, 120)
  } else if (asset.source === 'binance-futures') {
    data = await binance.fetchFuturesKlines(asset.apiSymbol, timeframe, 120)
  } else if (asset.source === 'yahoo') {
    data = await yahoo.fetchOHLCV(asset.apiSymbol, timeframe, 120)
  } else {
    throw new Error(`Unknown source: ${asset.source}`)
  }

  cache.set(key, data, CACHE_TTL[timeframe] ?? 300_000)
  return data
}

async function fetchBatch(assets, timeframes, { concurrency = 8, delayMs = 0 } = {}) {
  const results = []
  for (let i = 0; i < assets.length; i += concurrency) {
    const chunk = assets.slice(i, i + concurrency)
    const settled = await Promise.allSettled(
      chunk.map(async (asset, idx) => {
        if (delayMs > 0) await new Promise(r => setTimeout(r, idx * delayMs))
        const candlesByTf = {}
        for (const tf of timeframes) {
          try {
            candlesByTf[tf] = await fetchOHLCV(asset, tf)
          } catch (err) {
            console.warn(`[provider] ${asset.symbol} ${tf}: ${err.message}`)
            candlesByTf[tf] = []
          }
        }
        return { asset, candlesByTf }
      })
    )
    for (const r of settled) {
      if (r.status === 'fulfilled') results.push(r.value)
    }
    if (delayMs > 0 && i + concurrency < assets.length) {
      await new Promise(r => setTimeout(r, delayMs))
    }
  }
  return results
}

async function fetchAllMarketData(assets, timeframes) {
  const cryptoAssets = assets.filter(a => a.source === 'binance')
  const stockAssets  = assets.filter(a => a.source === 'yahoo')

  // Fetch OHLCV for all assets; Binance tickers in parallel
  const [ohlcvResults, tickerResult] = await Promise.allSettled([
    Promise.all([
      fetchBatch(cryptoAssets, timeframes, { concurrency: 20 }),
      fetchBatch(stockAssets,  timeframes, { concurrency: 1 }),
    ]),
    binance.fetchTickers(cryptoAssets.map(a => a.apiSymbol)),
  ])

  const [cryptoOHLCV, stockOHLCV] = ohlcvResults.status === 'fulfilled'
    ? ohlcvResults.value
    : [[], []]

  const tickers = tickerResult.status === 'fulfilled' ? tickerResult.value : {}

  // Attach price / 24h change
  return [...cryptoOHLCV, ...stockOHLCV].map(({ asset, candlesByTf }) => {
    let price = null, change24h = null

    if (asset.source === 'binance') {
      const t = tickers[asset.apiSymbol]
      if (t) { price = t.price; change24h = t.change24h }
    }

    // Fallback: last close from any timeframe
    if (price == null) {
      for (const tf of timeframes) {
        const c = candlesByTf[tf]
        if (c?.length) { price = c[c.length - 1].close; break }
      }
    }

    return { asset, candlesByTf, price, change24h }
  })
}

// Expose raw OHLCV for future use (charts, custom indicators, etc.)
module.exports = { fetchOHLCV, fetchAllMarketData }
