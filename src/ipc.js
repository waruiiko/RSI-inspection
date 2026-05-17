const { app, BrowserWindow, dialog, shell } = require('electron')
const { Worker } = require('worker_threads')
const fs             = require('fs')
const path           = require('path')
const codexReview    = require('./codexReview')
const { fetchOHLCV } = require('./data/provider')
const binance        = require('./data/binance')
const yahoo          = require('./data/yahoo')
const { getAll, getCrypto, getStocks, getRuntimeAll } = require('./assets')
const config         = require('./config')
const { isUSMarketOpen } = require('./marketHours')

const DEFAULT_TIMEFRAMES = ['15m', '1h', '4h', '1d']
let _indicatorWorker = null
let _indicatorSeq = 0
const _indicatorPending = new Map()
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
  ipcMain.handle('settings:diagnostics', () => config.getDiagnostics())
  ipcMain.handle('settings:cacheStats', () => config.getMarketCacheStats())
  ipcMain.handle('settings:clearCache', () => {
    return config.clearMarketCache()
  })
  ipcMain.handle('settings:cleanupInstallers', () => cleanupOldInstallers())

  ipcMain.handle('settings:exportConfig', async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    const result = await dialog.showSaveDialog(win, {
      title: '导出 RSI-inspection 配置',
      defaultPath: `RSI-inspection-config-${new Date().toISOString().slice(0, 10)}.json`,
      filters: [{ name: 'JSON', extensions: ['json'] }],
    })
    if (result.canceled || !result.filePath) return { canceled: true }
    fs.writeFileSync(result.filePath, JSON.stringify(config.exportUserConfig(), null, 2), 'utf8')
    return { ok: true, filePath: result.filePath }
  })

  ipcMain.handle('settings:importConfig', async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    const result = await dialog.showOpenDialog(win, {
      title: '导入 RSI-inspection 配置',
      properties: ['openFile'],
      filters: [{ name: 'JSON', extensions: ['json'] }],
    })
    if (result.canceled || !result.filePaths?.[0]) return { canceled: true }
    const payload = JSON.parse(fs.readFileSync(result.filePaths[0], 'utf8'))
    config.importUserConfig(payload)
    return { ok: true, filePath: result.filePaths[0] }
  })

  ipcMain.handle('settings:checkUpdates', async (_, openRelease = true) => {
    const res = await fetch('https://api.github.com/repos/waruiiko/RSI-inspection/releases/latest', {
      headers: { 'User-Agent': 'RSI-inspection' },
    })
    if (!res.ok) throw new Error(`GitHub ${res.status}`)
    const release = await res.json()
    if (openRelease && release.html_url) shell.openExternal(release.html_url)
    return { ok: true, tag: release.tag_name, url: release.html_url, name: release.name }
  })

  ipcMain.handle('settings:getAutoLaunch', () =>
    app.getLoginItemSettings().openAtLogin
  )
  ipcMain.handle('settings:setAutoLaunch', (_, enabled) => {
    app.setLoginItemSettings({ openAtLogin: !!enabled })
    return { ok: true }
  })

  ipcMain.handle('codex:status', async () => {
    return codexReview.getStatus(config.loadSettings())
  })

  ipcMain.handle('codex:runReview', async (_, payload) => {
    return codexReview.runReview(payload, config.loadSettings())
  })

  ipcMain.handle('shell:openPath', async (_, target) => {
    if (!target) return { ok: false, error: 'Missing path' }
    const result = await shell.openPath(target)
    return result ? { ok: false, error: result } : { ok: true }
  })

  // Streaming: returns immediately, pushes chunks via event as each asset finishes
  ipcMain.handle('market:fetch', async (event, {
    timeframes = DEFAULT_TIMEFRAMES,
    rsiPeriod = 14,
    requestId = Date.now(),
    limit = null,
    scope = 'full',
    suppressAlerts = false,
  } = {}) => {
    const assets        = getRuntimeAll()
    const normalizedAssets = assets.map(normalizeAsset)
    let cryptoAssets  = normalizedAssets.filter(a => a.source === 'binance')
    let futuresAssets = normalizedAssets.filter(a => a.source === 'binance-futures')
    let stockAssets   = normalizedAssets.filter(a => a.source === 'yahoo')

    const status = []
    const push = (data) => {
      if (!event.sender.isDestroyed()) event.sender.send('market:chunk', { requestId, data })
    }
    const pushStatus = (item) => {
      status.push({ ...item, ts: Date.now() })
      if (!event.sender.isDestroyed()) event.sender.send('market:status', { requestId, item: status.at(-1) })
    }

    // Fetch spot + futures tickers independently, so one failed endpoint
    // does not discard the other endpoint's turnover data.
    let spotTickers = {}, futuresTickers = {}
    const [spotTickerResult, futuresTickerResult] = await Promise.allSettled([
      binance.fetchTickers(cryptoAssets.map(a => a.apiSymbol)),
      binance.fetchFuturesTickers(futuresAssets.map(a => a.apiSymbol)),
    ])
    if (spotTickerResult.status === 'fulfilled') spotTickers = spotTickerResult.value
    else {
      const message = spotTickerResult.reason?.message ?? String(spotTickerResult.reason)
      console.warn('[ipc] spot ticker fetch failed:', message)
      pushStatus({ level: 'warn', scope: 'Binance spot ticker', message })
    }
    if (futuresTickerResult.status === 'fulfilled') futuresTickers = futuresTickerResult.value
    else {
      const message = futuresTickerResult.reason?.message ?? String(futuresTickerResult.reason)
      console.warn('[ipc] futures ticker fetch failed:', message)
      pushStatus({ level: 'warn', scope: 'Binance futures ticker', message })
    }

    if (limit && Number.isFinite(limit)) {
      const ranked = [...cryptoAssets, ...futuresAssets]
        .map(asset => ({
          asset,
          volume: tickerVolume(resolveTicker(asset.source === 'binance' ? spotTickers : futuresTickers, asset)),
        }))
        .sort((a, b) => b.volume - a.volume)
        .slice(0, limit)
        .map(x => x.asset)
      const top = new Set(ranked.map(a => `${a.source}:${a.apiSymbol}`))
      cryptoAssets = cryptoAssets.filter(a => top.has(`${a.source}:${a.apiSymbol}`))
      futuresAssets = futuresAssets.filter(a => top.has(`${a.source}:${a.apiSymbol}`))
      stockAssets = []
    }

    const cryptoJob = runWithConcurrency(cryptoAssets, 4, async asset => {
      try {
        const result = await buildResult(asset, timeframes, spotTickers, rsiPeriod)
        if (result) push(result)
      } catch (err) {
        console.warn(`[ipc] ${asset.symbol}: ${err.message}`)
        pushStatus({ level: 'warn', scope: asset.symbol, message: err.message })
      }
    })

    const futuresJob = runWithConcurrency(futuresAssets, 4, async asset => {
      try {
        const result = await buildResult(asset, timeframes, futuresTickers, rsiPeriod)
        if (result) push(result)
      } catch (err) {
        console.warn(`[ipc] ${asset.symbol}: ${err.message}`)
        pushStatus({ level: 'warn', scope: asset.symbol, message: err.message })
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
              pushStatus({ level: 'warn', scope: asset.symbol, message: err.message })
            }
          }
        })()
      : Promise.resolve()

    await Promise.all([cryptoJob, futuresJob, stockJob])

    const updatedAt = Date.now()
    if (!event.sender.isDestroyed()) {
      event.sender.send('market:done', { requestId, updatedAt, status, meta: { scope, limit, timeframes, suppressAlerts } })
    }

    return { ok: true, requestId, updatedAt, meta: { scope, limit, timeframes, suppressAlerts } }
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

function cleanupOldInstallers() {
  const distDir = path.join(__dirname, '..', 'dist')
  if (!fs.existsSync(distDir)) return { ok: true, removed: [], kept: null }
  const installers = fs.readdirSync(distDir)
    .filter(name => /^市场RSI热力图 Setup .*\.exe$/.test(name))
    .map(name => {
      const file = path.join(distDir, name)
      return { name, file, mtime: fs.statSync(file).mtimeMs }
    })
    .sort((a, b) => b.mtime - a.mtime)
  const kept = installers[0] ?? null
  const removed = []
  for (const item of installers.slice(1)) {
    for (const file of [item.file, `${item.file}.blockmap`]) {
      try {
        if (fs.existsSync(file)) {
          fs.rmSync(file, { force: true })
          removed.push(path.basename(file))
        }
      } catch {}
    }
  }
  return { ok: true, kept: kept?.name ?? null, removed }
}

async function runWithConcurrency(items, concurrency, worker) {
  let nextIndex = 0
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (nextIndex < items.length) {
      const item = items[nextIndex++]
      await worker(item)
    }
  })
  await Promise.all(workers)
}

function getIndicatorWorker() {
  if (_indicatorWorker) return _indicatorWorker
  const workerPath = path.join(__dirname, 'indicatorWorker.js')
  const resolvedWorkerPath = app.isPackaged
    ? workerPath.replace('app.asar', 'app.asar.unpacked')
    : workerPath
  _indicatorWorker = new Worker(resolvedWorkerPath)
  _indicatorWorker.on('message', msg => {
    const pending = _indicatorPending.get(msg.id)
    if (!pending) return
    _indicatorPending.delete(msg.id)
    msg.ok ? pending.resolve(msg.result) : pending.reject(new Error(msg.error || 'indicator worker failed'))
  })
  _indicatorWorker.on('error', err => {
    for (const pending of _indicatorPending.values()) pending.reject(err)
    _indicatorPending.clear()
    _indicatorWorker = null
  })
  _indicatorWorker.on('exit', code => {
    if (code !== 0) {
      for (const pending of _indicatorPending.values()) pending.reject(new Error(`indicator worker exited: ${code}`))
      _indicatorPending.clear()
    }
    _indicatorWorker = null
  })
  return _indicatorWorker
}

function computeIndicatorData(payload) {
  const id = ++_indicatorSeq
  return new Promise((resolve, reject) => {
    _indicatorPending.set(id, { resolve, reject })
    getIndicatorWorker().postMessage({ id, payload })
  })
}

async function buildResult(asset, timeframes, tickers, rsiPeriod = 14) {
  const candlesByTf = {}
  const closedCandlesByTf = {}
  for (const tf of timeframes) {
    try {
      candlesByTf[tf] = await fetchOHLCVWithRetry(asset, tf)
      closedCandlesByTf[tf] = onlyClosedCandles(candlesByTf[tf])
    } catch (err) {
      console.warn(`[ipc] ${asset.symbol} ${tf}: ${err.message}`)
      candlesByTf[tf] = []
      closedCandlesByTf[tf] = []
    }
  }

  const { rsi, sparkline, divergence, volumeSignal, signalScore } = await computeIndicatorData({
    closedCandlesByTf,
    timeframes,
    rsiPeriod,
  })
  if (Object.keys(rsi).length === 0) return null

  // Price from ticker (crypto) or last candle (stocks)
  let price = null, change24h = null, quoteVolume24h = null
  const ticker = resolveTicker(tickers, asset)
  if (ticker) {
    price = ticker.price
    change24h = ticker.change24h
    quoteVolume24h = toNumber(ticker.quoteVolume24h ?? ticker.volume24h)
  } else {
    for (const tf of timeframes) {
      if (closedCandlesByTf[tf]?.length) { price = closedCandlesByTf[tf].at(-1).close; break }
    }
  }

  if (quoteVolume24h == null) quoteVolume24h = estimateTurnover(closedCandlesByTf)

  return { ...asset, price, change24h, quoteVolume24h, rsi, sparkline, divergence, volumeSignal, signalScore }
}

async function fetchOHLCVWithRetry(asset, timeframe, attempts = 3) {
  const cacheKey = `${asset.source}:${asset.apiSymbol}:${timeframe}`
  const ttlMs = cacheTtlMs(timeframe)
  const cached = config.loadMarketCacheEntry(cacheKey)
  if (cached?.candles?.length && Date.now() - (cached.savedAt ?? 0) < ttlMs) {
    return cached.candles
  }

  let lastError
  for (let i = 0; i < attempts; i++) {
    try {
      const candles = await fetchOHLCV(asset, timeframe)
      config.saveMarketCacheEntry(cacheKey, { savedAt: Date.now(), candles })
      return candles
    } catch (err) {
      lastError = err
      const message = String(err?.message ?? '')
      const retryable = /429|418|5\d\d|fetch failed|ECONNRESET|ETIMEDOUT|ENOTFOUND/i.test(message)
      if (!retryable || i === attempts - 1) break
      await sleep(350 * (i + 1) + Math.floor(Math.random() * 250))
    }
  }
  if (cached?.candles?.length) return cached.candles
  throw lastError
}

function cacheTtlMs(timeframe) {
  if (timeframe === '15m') return 2 * 60 * 1000
  if (timeframe === '1h') return 5 * 60 * 1000
  if (timeframe === '4h') return 10 * 60 * 1000
  return 30 * 60 * 1000
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function normalizeAsset(asset) {
  const source = asset.source || (asset.type === 'stock' ? 'yahoo' : 'binance')
  let apiSymbol = asset.apiSymbol || asset.symbol
  if ((source === 'binance' || source === 'binance-futures') && apiSymbol && !apiSymbol.endsWith('USDT')) {
    apiSymbol = `${apiSymbol}USDT`
  }
  return {
    ...asset,
    source,
    apiSymbol,
    type: asset.type || (source === 'yahoo' ? 'stock' : 'crypto'),
  }
}

function resolveTicker(tickers, asset) {
  return tickers[asset.apiSymbol]
    || tickers[asset.symbol]
    || tickers[`${asset.symbol}USDT`]
    || null
}

function tickerVolume(ticker) {
  return toNumber(ticker?.quoteVolume24h ?? ticker?.volume24h ?? ticker?.quoteVolume ?? ticker?.volume) ?? 0
}

function onlyClosedCandles(candles) {
  const now = Date.now()
  return (candles ?? []).filter(c => !c.closeTime || c.closeTime <= now)
}

function toNumber(value) {
  const n = typeof value === 'string' ? parseFloat(value) : value
  return Number.isFinite(n) ? n : null
}

function estimateTurnover(candlesByTf) {
  const dayCandle = candlesByTf['1d']?.at(-1)
  const dayTurnover = candleTurnover(dayCandle)
  if (dayTurnover != null) return dayTurnover

  const hourly = candlesByTf['1h']?.slice(-24).map(candleTurnover).filter(v => v != null)
  if (hourly?.length) return hourly.reduce((sum, v) => sum + v, 0)

  const fourHour = candlesByTf['4h']?.slice(-6).map(candleTurnover).filter(v => v != null)
  if (fourHour?.length) return fourHour.reduce((sum, v) => sum + v, 0)

  const fifteen = candlesByTf['15m']?.slice(-96).map(candleTurnover).filter(v => v != null)
  if (fifteen?.length) return fifteen.reduce((sum, v) => sum + v, 0)

  return null
}

function candleTurnover(candle) {
  if (!candle) return null
  const quoteVolume = toNumber(candle.quoteVolume)
  if (quoteVolume != null) return quoteVolume
  const volume = toNumber(candle.volume)
  const close = toNumber(candle.close)
  return volume != null && close != null ? volume * close : null
}

function avg(nums) {
  const vals = nums.filter(v => Number.isFinite(v))
  return vals.length ? vals.reduce((s, v) => s + v, 0) / vals.length : null
}

function pctChange(from, to) {
  if (!from) return 0
  return ((to - from) / from) * 100
}

function candleVolume(candle) {
  return candle?.quoteVolume || candle?.volume || 0
}

function closePosition(candle) {
  const range = candle.high - candle.low
  if (!Number.isFinite(range) || range <= 0) return 0.5
  return (candle.close - candle.low) / range
}

function consecutiveHigherCloses(candles, count = 3) {
  if (!candles || candles.length < count) return false
  const recent = candles.slice(-count)
  for (let i = 1; i < recent.length; i++) {
    if (recent[i].close <= recent[i - 1].close) return false
  }
  return true
}

function consecutiveLowerCloses(candles, count = 3) {
  if (!candles || candles.length < count) return false
  const recent = candles.slice(-count)
  for (let i = 1; i < recent.length; i++) {
    if (recent[i].close >= recent[i - 1].close) return false
  }
  return true
}

function detectTrend(candles) {
  if (!candles || candles.length < 30) return null
  const last = candles.at(-1)
  const ma20 = avg(candles.slice(-20).map(c => c.close))
  const ma50 = candles.length >= 50 ? avg(candles.slice(-50).map(c => c.close)) : avg(candles.slice(-30).map(c => c.close))
  if (!last || ma20 == null || ma50 == null) return null
  if (last.close > ma20 && ma20 > ma50) return 'up'
  if (last.close < ma20 && ma20 < ma50) return 'down'
  return 'range'
}

function detectVolumePriceSignal(candles) {
  if (!candles || candles.length < 35) return null

  const cur = candles.at(-1)
  const prev = candles.at(-2)
  const lookback = candles.slice(-31, -1)
  const longer = candles.slice(-51, -1)
  const vol = candleVolume(cur)
  const avgVol = avg(lookback.slice(-20).map(candleVolume))
  if (!cur || !prev || !avgVol) return null

  const volumeRatio = parseFloat((vol / avgVol).toFixed(2))
  const priceMovePct = parseFloat(pctChange(prev.close, cur.close).toFixed(2))
  const closePos = parseFloat(closePosition(cur).toFixed(2))
  const prevHigh = Math.max(...lookback.map(c => c.high))
  const prevLow = Math.min(...lookback.map(c => c.low))
  const breaksUp = cur.close > prevHigh * 1.002
  const breaksDown = cur.close < prevLow * 0.998
  const volExpansion = volumeRatio >= 1.5
  const strongVolExpansion = volumeRatio >= 1.8
  const volDry = volumeRatio <= 0.7
  const risingCloses = consecutiveHigherCloses(candles.slice(-4), 3)
  const fallingCloses = consecutiveLowerCloses(candles.slice(-4), 3)

  const highCloseCandle = longer.reduce((best, c) => c.close > best.close ? c : best, longer[0])
  const lowCloseCandle = longer.reduce((best, c) => c.close < best.close ? c : best, longer[0])
  const highVol = candleVolume(highCloseCandle)
  const lowVol = candleVolume(lowCloseCandle)

  if (cur.close > highCloseCandle.close * 1.003 && highVol && vol < highVol * 0.75 && volumeRatio < 1.2) {
    return {
      type: 'bearish_volume_divergence',
      label: '新高量能背离',
      direction: 'caution',
      score: -2,
      volumeRatio,
      priceMovePct,
      closePos,
      level: highCloseCandle.close,
    }
  }

  if (cur.close < lowCloseCandle.close * 0.997 && lowVol && vol < lowVol * 0.75 && volumeRatio < 1.2) {
    return {
      type: 'bullish_seller_exhaustion',
      label: '新低抛压减弱',
      direction: 'caution',
      score: 2,
      volumeRatio,
      priceMovePct,
      closePos,
      level: lowCloseCandle.close,
    }
  }

  if (breaksUp) {
    const confirmed = volExpansion && priceMovePct > 0 && closePos >= 0.65
    return {
      type: confirmed ? 'breakout_confirmed' : 'breakout_attempt',
      label: confirmed ? '放量突破' : '突破尝试',
      direction: confirmed ? 'bullish' : 'caution',
      score: confirmed ? 4 : 1,
      volumeRatio,
      priceMovePct,
      closePos,
      level: prevHigh,
    }
  }

  if (breaksDown) {
    const confirmed = volExpansion && priceMovePct < 0 && closePos <= 0.35
    return {
      type: confirmed ? 'breakdown_confirmed' : 'breakdown_attempt',
      label: confirmed ? '放量破位' : '破位尝试',
      direction: confirmed ? 'bearish' : 'caution',
      score: confirmed ? -4 : -1,
      volumeRatio,
      priceMovePct,
      closePos,
      level: prevLow,
    }
  }

  const recentVol = avg(lookback.slice(-5).map(candleVolume))
  const rangePct = pctChange(prev.close, Math.max(...lookback.slice(-8).map(c => c.high)))
    - pctChange(prev.close, Math.min(...lookback.slice(-8).map(c => c.low)))
  if (recentVol && recentVol < avgVol * 0.72 && Math.abs(rangePct) < 4) {
    return {
      type: 'range_compression',
      label: '缩量压缩',
      direction: 'neutral',
      score: 0,
      volumeRatio: parseFloat((recentVol / avgVol).toFixed(2)),
      priceMovePct,
      closePos,
    }
  }

  if (strongVolExpansion && priceMovePct >= 2 && closePos >= 0.65 && risingCloses) {
    return {
      type: 'volume_rebound_up',
      label: '放量反弹',
      direction: 'caution',
      score: 1,
      volumeRatio,
      priceMovePct,
      closePos,
    }
  }

  if (strongVolExpansion && priceMovePct <= -2 && closePos <= 0.35 && fallingCloses) {
    return {
      type: 'volume_selloff',
      label: '放量回落',
      direction: 'caution',
      score: -1,
      volumeRatio,
      priceMovePct,
      closePos,
    }
  }

  if (volDry) {
    return {
      type: 'quiet_volume',
      label: '量能偏低',
      direction: 'neutral',
      score: 0,
      volumeRatio,
      priceMovePct,
      closePos,
    }
  }

  return null
}

function computeSignalScore({ rsi, divergence, volumeSignal, higherTfTrend }) {
  let score = volumeSignal?.score ?? 0
  if (higherTfTrend === 'up') score += 1
  if (higherTfTrend === 'down') score -= 1
  if (rsi >= 70) score -= 1
  if (rsi <= 30) score += 1
  if (divergence === 'bullish') score += 1
  if (divergence === 'bearish') score -= 1
  return Math.max(-6, Math.min(6, score))
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
  if (curPrice == null || curRsi == null) return null

  const { peaks, troughs } = findLocalPivots(c)

  const valid = i => c[i] != null && r[i] != null

  // Bearish: price makes a higher high while RSI makes a lower high.
  if (peaks.length >= 2) {
    const [p1, p2] = peaks.slice(-2)
    if (valid(p1) && valid(p2) && c[p2] > c[p1] * 0.997 && r[p2] < r[p1] - 3) return 'bearish'
  }
  if (peaks.length >= 1) {
    const pk = peaks[peaks.length - 1]
    if (valid(pk) && curPrice > c[pk] * 0.997 && curRsi < r[pk] - 3) return 'bearish'
  }

  // Bullish: price makes a lower low while RSI makes a higher low.
  if (troughs.length >= 2) {
    const [t1, t2] = troughs.slice(-2)
    if (valid(t1) && valid(t2) && c[t2] < c[t1] * 1.003 && r[t2] > r[t1] + 3) return 'bullish'
  }
  if (troughs.length >= 1) {
    const tr = troughs[troughs.length - 1]
    if (valid(tr) && curPrice < c[tr] * 1.003 && curRsi > r[tr] + 3) return 'bullish'
  }
  return null
}
