const { app }        = require('electron')
const { fetchOHLCV } = require('./data/provider')
const binance        = require('./data/binance')
const yahoo          = require('./data/yahoo')
const { computeAll } = require('./indicators')
const rsiIndicator   = require('./indicators/rsi')
const { getAll, getCrypto, getStocks, getRuntimeAll } = require('./assets')
const config         = require('./config')
const { isUSMarketOpen } = require('./marketHours')

const DEFAULT_TIMEFRAMES = ['15m', '1h', '4h', '1d']

exports.register = (ipcMain) => {

  // Asset config management
  ipcMain.handle('assets:getConfig', () => {
    const cfg = config.load()
    if (cfg) return cfg
    return {
      crypto: getCrypto(),
      stocks: getStocks(),
    }
  })

  ipcMain.handle('assets:saveConfig', (_, cfg) => {
    config.save(cfg)
    return { ok: true }
  })

  ipcMain.handle('assets:getBinancePairs', async () => {
    const [spot, futures] = await Promise.all([
      binance.fetchAllUsdtPairs(),
      binance.fetchAllFuturesPairs(),
    ])
    return { spot, futures }
  })

  ipcMain.handle('assets:validateStock', async (_, ticker) => {
    return yahoo.validateTicker(ticker)
  })

  ipcMain.handle('alerts:load', () => config.loadAlerts() ?? [])

  ipcMain.handle('alerts:save', (_, rules) => {
    config.saveAlerts(rules)
    return { ok: true }
  })

  ipcMain.handle('alerts:show', (_, data) => {
    require('./notificationWindow').show(data)
    return { ok: true }
  })

  ipcMain.handle('alerts:showBatch', (_, items) => {
    require('./notificationWindow').showBatch(items)
    return { ok: true }
  })

  ipcMain.handle('feed:load', () => config.loadFeed() ?? [])
  ipcMain.handle('feed:save', (_, feed) => { config.saveFeed(feed); return { ok: true } })

  ipcMain.handle('settings:get',  ()     => config.loadSettings())
  ipcMain.handle('settings:save', (_, s) => { config.saveSettings(s); return { ok: true } })

  ipcMain.handle('settings:getAutoLaunch', () =>
    app.getLoginItemSettings().openAtLogin
  )
  ipcMain.handle('settings:setAutoLaunch', (_, enabled) => {
    app.setLoginItemSettings({ openAtLogin: !!enabled })
    return { ok: true }
  })

  // Streaming: returns immediately, pushes chunks via event as each asset finishes
  ipcMain.handle('market:fetch', async (event, { timeframes = DEFAULT_TIMEFRAMES, rsiPeriod = 14 } = {}) => {
    const assets        = getRuntimeAll()
    const cryptoAssets  = assets.filter(a => a.source === 'binance')
    const futuresAssets = assets.filter(a => a.source === 'binance-futures')
    const stockAssets   = assets.filter(a => a.source === 'yahoo')

    const push = (data) => {
      if (!event.sender.isDestroyed()) event.sender.send('market:chunk', data)
    }

    // Fetch spot + futures tickers in parallel (single request each)
    let spotTickers = {}, futuresTickers = {}
    try {
      [spotTickers, futuresTickers] = await Promise.all([
        binance.fetchTickers(cryptoAssets.map(a => a.apiSymbol)),
        binance.fetchFuturesTickers(futuresAssets.map(a => a.apiSymbol)),
      ])
    } catch (err) {
      console.warn('[ipc] ticker fetch failed:', err.message)
    }

    // Spot crypto: fully parallel
    const cryptoJobs = cryptoAssets.map(async asset => {
      try {
        const result = await buildResult(asset, timeframes, spotTickers, rsiPeriod)
        if (result) push(result)
      } catch (err) {
        console.warn(`[ipc] ${asset.symbol}: ${err.message}`)
      }
    })

    // Futures: fully parallel
    const futuresJobs = futuresAssets.map(async asset => {
      try {
        const result = await buildResult(asset, timeframes, futuresTickers, rsiPeriod)
        if (result) push(result)
      } catch (err) {
        console.warn(`[ipc] ${asset.symbol}: ${err.message}`)
      }
    })

    // Stocks: serial — Yahoo throttle is enforced inside yahoo.js; skip when market is closed
    const stockJob = isUSMarketOpen()
      ? (async () => {
          for (const asset of stockAssets) {
            try {
              const result = await buildResult(asset, timeframes, {}, rsiPeriod)
              if (result) push(result)
            } catch (err) {
              console.warn(`[ipc] ${asset.symbol}: ${err.message}`)
            }
          }
        })()
      : Promise.resolve()

    await Promise.all([...cryptoJobs, ...futuresJobs, stockJob])

    if (!event.sender.isDestroyed()) {
      event.sender.send('market:done', { updatedAt: Date.now() })
    }

    return { ok: true }
  })

  // Raw OHLCV for future use (candlestick charts, custom indicators, etc.)
  ipcMain.handle('market:ohlcv', async (_, { symbol, source, timeframes = DEFAULT_TIMEFRAMES }) => {
    const asset = { symbol, apiSymbol: symbol, source }
    const result = {}
    for (const tf of timeframes) {
      try { result[tf] = await fetchOHLCV(asset, tf) }
      catch { result[tf] = [] }
    }
    return result
  })
}

async function buildResult(asset, timeframes, tickers, rsiPeriod = 14) {
  const candlesByTf = {}
  for (const tf of timeframes) {
    try {
      candlesByTf[tf] = await fetchOHLCV(asset, tf)
    } catch (err) {
      console.warn(`[ipc] ${asset.symbol} ${tf}: ${err.message}`)
      candlesByTf[tf] = []
    }
  }

  const rsi = {}
  for (const tf of timeframes) {
    if (candlesByTf[tf]?.length > rsiPeriod + 1) {
      rsi[tf] = computeAll(candlesByTf[tf], ['rsi'], { rsi: { period: rsiPeriod } }).rsi
    }
  }
  if (Object.keys(rsi).length === 0) return null

  // Price from ticker (crypto) or last candle (stocks)
  let price = null, change24h = null
  const ticker = tickers[asset.apiSymbol]
  if (ticker) {
    price = ticker.price
    change24h = ticker.change24h
  } else {
    for (const tf of timeframes) {
      if (candlesByTf[tf]?.length) { price = candlesByTf[tf].at(-1).close; break }
    }
  }

  // Sparkline: last 20 closes from longest available timeframe
  let sparkline = []
  for (const tf of ['1d', '4h', '1h', '15m']) {
    const candles = candlesByTf[tf]
    if (candles?.length >= 10) {
      sparkline = candles.slice(-20).map(c => c.close)
      break
    }
  }

  // RSI divergence per timeframe (last 30 bars)
  const divergence = {}
  for (const tf of timeframes) {
    const candles = candlesByTf[tf]
    if (!candles || candles.length < rsiPeriod + 50) continue
    const rsiSeries = rsiIndicator.computeSeriesFromCandles(candles, { period: rsiPeriod })
    if (rsiSeries.length < 40) continue
    divergence[tf] = detectDivergence(candles.slice(-50).map(c => c.close), rsiSeries.slice(-50))
  }

  return { ...asset, price, change24h, rsi, sparkline, divergence }
}

function findLocalPivots(arr, lob = 3) {
  const peaks = [], troughs = []
  for (let i = lob; i < arr.length - lob; i++) {
    let hi = true, lo = true
    for (let j = 1; j <= lob; j++) {
      if (arr[i] <= arr[i - j] || arr[i] <= arr[i + j]) hi = false
      if (arr[i] >= arr[i - j] || arr[i] >= arr[i + j]) lo = false
    }
    if (hi) peaks.push(i)
    if (lo) troughs.push(i)
  }
  return { peaks, troughs }
}

function detectDivergence(closes, rsiSeries) {
  const n = Math.min(closes.length, rsiSeries.length)
  if (n < 15) return null

  const c = closes.slice(-n)
  const r = rsiSeries.slice(-n)
  const last = n - 1
  const curPrice = c[last], curRsi = r[last]

  const { peaks, troughs } = findLocalPivots(c)

  // Bearish: last pivot peak where price < curPrice (higher price now) but RSI was higher then
  if (peaks.length >= 1) {
    const pk = peaks[peaks.length - 1]
    if (curPrice > c[pk] * 0.997 && curRsi < r[pk] - 3) return 'bearish'
  }
  // Bullish: last pivot trough where price > curPrice (lower price now) but RSI was lower then
  if (troughs.length >= 1) {
    const tr = troughs[troughs.length - 1]
    if (curPrice < c[tr] * 1.003 && curRsi > r[tr] + 3) return 'bullish'
  }
  return null
}
