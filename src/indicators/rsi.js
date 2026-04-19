// Wilder's smoothed RSI
function computeSeries(closes, period) {
  if (closes.length < period + 1) return []

  let gains = 0, losses = 0
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1]
    if (d > 0) gains += d; else losses -= d
  }

  let avgGain = gains / period
  let avgLoss = losses / period
  const series = []

  const toRsi = () => avgLoss === 0 ? 100 : parseFloat((100 - 100 / (1 + avgGain / avgLoss)).toFixed(2))
  series.push(toRsi())

  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1]
    avgGain = (avgGain * (period - 1) + Math.max(0,  d)) / period
    avgLoss = (avgLoss * (period - 1) + Math.max(0, -d)) / period
    series.push(toRsi())
  }

  return series
}

function compute(candles, params = {}) {
  const period = params.period ?? 14
  const closes = candles.map(c => c.close)
  const series = computeSeries(closes, period)
  return series.length ? series[series.length - 1] : null
}

function computeSeriesFromCandles(candles, params = {}) {
  const period = params.period ?? 14
  return computeSeries(candles.map(c => c.close), period)
}

module.exports = {
  name: 'rsi',
  defaultParams: { period: 14 },
  compute,
  computeSeriesFromCandles,
}
