const { parentPort } = require('worker_threads')
const { computeAll } = require('./indicators')
const rsiIndicator = require('./indicators/rsi')

parentPort.on('message', ({ id, payload }) => {
  try {
    parentPort.postMessage({ id, ok: true, result: computeIndicatorPayload(payload) })
  } catch (err) {
    parentPort.postMessage({ id, ok: false, error: err.message })
  }
})

function computeIndicatorPayload({ closedCandlesByTf, timeframes, rsiPeriod }) {
  const rsi = {}
  for (const tf of timeframes) {
    if (closedCandlesByTf[tf]?.length > rsiPeriod + 1) {
      rsi[tf] = computeAll(closedCandlesByTf[tf], ['rsi'], { rsi: { period: rsiPeriod } }).rsi
    }
  }

  let sparkline = []
  for (const tf of ['1d', '4h', '1h', '15m']) {
    const candles = closedCandlesByTf[tf]
    if (candles?.length >= 10) {
      sparkline = candles.slice(-20).map(c => c.close)
      break
    }
  }

  const divergence = {}
  const volumeSignal = {}
  const signalScore = {}
  for (const tf of timeframes) {
    const candles = closedCandlesByTf[tf]
    if (!candles || candles.length < rsiPeriod + 50) continue
    const rsiSeries = rsiIndicator.computeSeriesFromCandles(candles, { period: rsiPeriod })
    if (rsiSeries.length < 40) continue
    divergence[tf] = detectDivergence(candles.slice(-50).map(c => c.close), rsiSeries.slice(-50))
  }

  for (const tf of timeframes) {
    volumeSignal[tf] = detectVolumePriceSignal(closedCandlesByTf[tf])
    signalScore[tf] = computeSignalScore({
      rsi: rsi[tf],
      divergence: divergence[tf],
      volumeSignal: volumeSignal[tf],
      higherTfTrend: tf !== '1d' ? detectTrend(closedCandlesByTf['1d']) : null,
    })
  }

  return { rsi, sparkline, divergence, volumeSignal, signalScore }
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
    return { type: 'bearish_volume_divergence', label: '新高量能背离', direction: 'caution', score: -2, volumeRatio, priceMovePct, closePos, level: highCloseCandle.close }
  }

  if (cur.close < lowCloseCandle.close * 0.997 && lowVol && vol < lowVol * 0.75 && volumeRatio < 1.2) {
    return { type: 'bullish_seller_exhaustion', label: '新低抛压减弱', direction: 'caution', score: 2, volumeRatio, priceMovePct, closePos, level: lowCloseCandle.close }
  }

  if (breaksUp) {
    const confirmed = volExpansion && priceMovePct > 0 && closePos >= 0.65
    return { type: confirmed ? 'breakout_confirmed' : 'breakout_attempt', label: confirmed ? '放量突破' : '突破尝试', direction: confirmed ? 'bullish' : 'caution', score: confirmed ? 4 : 1, volumeRatio, priceMovePct, closePos, level: prevHigh }
  }

  if (breaksDown) {
    const confirmed = volExpansion && priceMovePct < 0 && closePos <= 0.35
    return { type: confirmed ? 'breakdown_confirmed' : 'breakdown_attempt', label: confirmed ? '放量破位' : '破位尝试', direction: confirmed ? 'bearish' : 'caution', score: confirmed ? -4 : -1, volumeRatio, priceMovePct, closePos, level: prevLow }
  }

  const recentVol = avg(lookback.slice(-5).map(candleVolume))
  const rangePct = pctChange(prev.close, Math.max(...lookback.slice(-8).map(c => c.high)))
    - pctChange(prev.close, Math.min(...lookback.slice(-8).map(c => c.low)))
  if (recentVol && recentVol < avgVol * 0.72 && Math.abs(rangePct) < 4) {
    return { type: 'range_compression', label: '缩量压缩', direction: 'neutral', score: 0, volumeRatio: parseFloat((recentVol / avgVol).toFixed(2)), priceMovePct, closePos }
  }

  if (strongVolExpansion && priceMovePct >= 2 && closePos >= 0.65 && risingCloses) {
    return { type: 'volume_rebound_up', label: '放量反弹', direction: 'caution', score: 1, volumeRatio, priceMovePct, closePos }
  }

  if (strongVolExpansion && priceMovePct <= -2 && closePos <= 0.35 && fallingCloses) {
    return { type: 'volume_selloff', label: '放量回落', direction: 'caution', score: -1, volumeRatio, priceMovePct, closePos }
  }

  if (volDry) return { type: 'quiet_volume', label: '量能偏低', direction: 'neutral', score: 0, volumeRatio, priceMovePct, closePos }
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

  if (peaks.length >= 2) {
    const [p1, p2] = peaks.slice(-2)
    if (valid(p1) && valid(p2) && c[p2] > c[p1] * 0.997 && r[p2] < r[p1] - 3) return 'bearish'
  }
  if (peaks.length >= 1) {
    const pk = peaks[peaks.length - 1]
    if (valid(pk) && curPrice > c[pk] * 0.997 && curRsi < r[pk] - 3) return 'bearish'
  }

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
