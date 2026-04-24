import { useEffect, useRef, useState, useMemo } from 'react'
import * as echarts from 'echarts'
import { getRsiColor } from '../utils/rsi'
import useSettingsStore from '../store/settingsStore'

const TIMEFRAMES = ['15m', '1h', '4h', '1d']

function computeMa(vals, length, type) {
  if (type === 'None') return vals.map(() => null)
  const result = new Array(vals.length).fill(null)
  if (type === 'SMA') {
    for (let i = 0; i < vals.length; i++) {
      if (vals[i] == null) continue
      let sum = 0, count = 0
      for (let j = i; j >= 0 && count < length; j--) {
        if (vals[j] == null) break
        sum += vals[j]; count++
      }
      if (count === length) result[i] = parseFloat((sum / length).toFixed(2))
    }
  } else if (type === 'EMA') {
    const k = 2 / (length + 1)
    let ema = null, warmup = 0
    for (let i = 0; i < vals.length; i++) {
      if (vals[i] == null) continue
      if (ema == null) { ema = vals[i]; warmup = 1; continue }
      ema = vals[i] * k + ema * (1 - k)
      if (++warmup >= length) result[i] = parseFloat(ema.toFixed(2))
    }
  } else if (type === 'RMA') {
    const k = 1 / length
    let rma = null, warmup = 0
    for (let i = 0; i < vals.length; i++) {
      if (vals[i] == null) continue
      if (rma == null) { rma = vals[i]; warmup = 1; continue }
      rma = vals[i] * k + rma * (1 - k)
      if (++warmup >= length) result[i] = parseFloat(rma.toFixed(2))
    }
  } else if (type === 'WMA') {
    const denom = (length * (length + 1)) / 2
    for (let i = 0; i < vals.length; i++) {
      if (vals[i] == null) continue
      let sum = 0, valid = true
      for (let j = 0; j < length; j++) {
        if (i - j < 0 || vals[i - j] == null) { valid = false; break }
        sum += vals[i - j] * (length - j)
      }
      if (valid) result[i] = parseFloat((sum / denom).toFixed(2))
    }
  }
  return result
}

function computeStdDev(vals, maSeries, length) {
  return vals.map((v, i) => {
    if (v == null || maSeries[i] == null) return null
    let sum = 0, count = 0
    for (let j = i; j >= 0 && count < length; j--) {
      if (vals[j] == null) break
      const diff = vals[j] - maSeries[i]
      sum += diff * diff
      count++
    }
    return count === length ? Math.sqrt(sum / length) : null
  })
}

function computeRsi(candles, period = 14) {
  const closes = candles.map(c => c.close)
  if (closes.length < period + 1) return []
  let gains = 0, losses = 0
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1]
    if (d > 0) gains += d; else losses -= d
  }
  let avgGain = gains / period
  let avgLoss = losses / period
  const result = new Array(period).fill(null)
  result.push(parseFloat((100 - 100 / (1 + (avgLoss === 0 ? Infinity : avgGain / avgLoss))).toFixed(2)))
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1]
    avgGain = (avgGain * (period - 1) + Math.max(0,  d)) / period
    avgLoss = (avgLoss * (period - 1) + Math.max(0, -d)) / period
    result.push(avgLoss === 0 ? 100 : parseFloat((100 - 100 / (1 + avgGain / avgLoss)).toFixed(2)))
  }
  return result
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

function findDivergencePoints(candles, rsiVals) {
  const WINDOW = 50
  if (candles.length < WINDOW) return null
  const startIdx = candles.length - WINDOW
  const closes = candles.slice(startIdx).map(c => c.close)
  const rsi    = rsiVals.slice(startIdx)
  if (rsi.some(v => v == null)) return null
  const last = WINDOW - 1
  const curPrice = closes[last], curRsi = rsi[last]

  const { peaks, troughs } = findLocalPivots(closes)

  if (peaks.length >= 1) {
    const pk = peaks[peaks.length - 1]
    if (curPrice > closes[pk] * 0.997 && curRsi < rsi[pk] - 3)
      return { type: 'bearish', pivotIdx: startIdx + pk, currentIdx: candles.length - 1,
               pivotPrice: closes[pk], currentPrice: curPrice,
               pivotRsi: rsi[pk], currentRsi: curRsi }
  }
  if (troughs.length >= 1) {
    const tr = troughs[troughs.length - 1]
    if (curPrice < closes[tr] * 1.003 && curRsi > rsi[tr] + 3)
      return { type: 'bullish', pivotIdx: startIdx + tr, currentIdx: candles.length - 1,
               pivotPrice: closes[tr], currentPrice: curPrice,
               pivotRsi: rsi[tr], currentRsi: curRsi }
  }
  return null
}

export default function ChartModal({ asset, onClose }) {
  const rsiPeriod     = useSettingsStore(s => s.rsiPeriod)
  const rsiOverbought = useSettingsStore(s => s.rsiOverbought)
  const rsiOversold   = useSettingsStore(s => s.rsiOversold)
  const rsiMaType     = useSettingsStore(s => s.rsiMaType)
  const rsiMaLength   = useSettingsStore(s => s.rsiMaLength)
  const rsiBbMult     = useSettingsStore(s => s.rsiBbMult)
  const [tf, setTf]         = useState('4h')
  const [ohlcv, setOhlcv]   = useState({})
  const [loading, setLoading] = useState(true)
  const candleRef = useRef(null)
  const rsiRef    = useRef(null)
  const candleChart = useRef(null)
  const rsiChart    = useRef(null)

  useEffect(() => {
    setLoading(true)
    window.api.fetchRawOHLCV(asset.apiSymbol, asset.source, TIMEFRAMES).then(data => {
      setOhlcv(data)
      setLoading(false)
    })
  }, [asset])

  useEffect(() => {
    const onKey = e => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  useEffect(() => {
    if (loading || !candleRef.current || !rsiRef.current) return

    if (!candleChart.current) {
      candleChart.current = echarts.init(candleRef.current, 'dark')
      rsiChart.current    = echarts.init(rsiRef.current,    'dark')
      echarts.connect([candleChart.current, rsiChart.current])
    }

    const candles = ohlcv[tf] ?? []
    const times   = candles.map(c => new Date(c.time).toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }))
    const rsiVals = computeRsi(candles, rsiPeriod)
    const divPts  = findDivergencePoints(candles, rsiVals)
    const divColor = divPts?.type === 'bearish' ? '#f97316' : '#22c55e'

    // Helper: build a 2-point line series for divergence annotation
    const divLineSeries = (yPivot, yCurrent) => divPts ? [{
      type: 'line',
      data: Array(candles.length).fill(null).map((_, i) =>
        i === divPts.pivotIdx ? yPivot : i === divPts.currentIdx ? yCurrent : null
      ),
      symbol: 'circle', symbolSize: 6,
      lineStyle: { color: divColor, type: 'dashed', width: 1.5 },
      itemStyle: { color: divColor },
      connectNulls: true,
      silent: true, z: 10,
    }] : []

    candleChart.current.setOption({
      backgroundColor: 'transparent',
      animation: false,
      grid: { top: 16, bottom: 36, left: 60, right: 16 },
      xAxis: {
        type: 'category', data: times, boundaryGap: true,
        axisLabel: { color: '#6b7280', fontSize: 10, rotate: 30 },
        axisLine:  { lineStyle: { color: '#30363d' } },
        splitLine: { show: false },
      },
      yAxis: [
        {
          type: 'value', scale: true,
          splitLine: { lineStyle: { color: '#1f2937', type: 'dashed' } },
          axisLabel: { color: '#6b7280', fontSize: 10 },
        },
        {
          type: 'value', show: false,
          // squeeze volume bars into bottom 25% by making max = 4× actual max
          max: v => v.max * 4,
          min: 0,
        },
      ],
      dataZoom: [{ type: 'inside', start: 40, end: 100 }],
      tooltip: {
        trigger: 'axis', axisPointer: { type: 'cross' },
        backgroundColor: '#161b22', borderColor: '#30363d',
        textStyle: { color: '#e6edf3', fontSize: 11 },
        formatter(params) {
          const p = params.find(x => x.seriesType === 'candlestick')
          const v = params.find(x => x.seriesType === 'bar')
          if (!p) return ''
          const [o, c, l, h] = p.value
          const color = c >= o ? '#3fb950' : '#f85149'
          const vol = v?.value != null
            ? v.value >= 1e9 ? `${(v.value / 1e9).toFixed(2)}B`
              : v.value >= 1e6 ? `${(v.value / 1e6).toFixed(2)}M`
              : v.value >= 1e3 ? `${(v.value / 1e3).toFixed(1)}K`
              : String(v.value)
            : '—'
          return `<b>${p.name}</b><br/>
            开 <span style="color:${color}">${o}</span>&nbsp;
            收 <span style="color:${color}">${c}</span><br/>
            高 ${h}&nbsp; 低 ${l}<br/>
            <span style="color:#6b7280">量 ${vol}</span>`
        },
      },
      series: [
        {
          type: 'candlestick',
          yAxisIndex: 0,
          data: candles.map(c => [c.open, c.close, c.low, c.high]),
          itemStyle: {
            color: '#3fb950', color0: '#f85149',
            borderColor: '#3fb950', borderColor0: '#f85149',
          },
        },
        {
          type: 'bar',
          yAxisIndex: 1,
          data: candles.map(c => ({
            value: c.volume,
            itemStyle: { color: c.close >= c.open ? 'rgba(63,185,80,0.25)' : 'rgba(248,81,73,0.25)' },
          })),
          barMaxWidth: 8,
        },
        ...divLineSeries(divPts?.pivotPrice, divPts?.currentPrice),
      ],
    }, true)

    const lastRsi  = rsiVals.at(-1)
    const isBB     = rsiMaType === 'BB'
    const maType   = isBB ? 'SMA' : rsiMaType
    const maVals   = computeMa(rsiVals, rsiMaLength, maType)
    const showMa   = rsiMaType !== 'None'
    const stdDevs  = isBB ? computeStdDev(rsiVals, maVals, rsiMaLength) : null
    const bbUpper  = isBB ? maVals.map((m, i) => stdDevs[i] != null ? parseFloat((m + stdDevs[i] * rsiBbMult).toFixed(2)) : null) : []
    const bbLower  = isBB ? maVals.map((m, i) => stdDevs[i] != null ? parseFloat((m - stdDevs[i] * rsiBbMult).toFixed(2)) : null) : []
    rsiChart.current.setOption({
      backgroundColor: 'transparent',
      animation: false,
      grid: { top: 8, bottom: 36, left: 60, right: 16 },
      xAxis: {
        type: 'category', data: times, boundaryGap: true,
        axisLabel: { color: '#6b7280', fontSize: 10, rotate: 30 },
        axisLine:  { lineStyle: { color: '#30363d' } },
        splitLine: { show: false },
      },
      yAxis: {
        type: 'value', min: 0, max: 100,
        splitLine: { lineStyle: { color: '#1f2937', type: 'dashed' } },
        axisLabel: { color: '#6b7280', fontSize: 10 },
      },
      dataZoom: [{ type: 'inside', start: 40, end: 100 }],
      tooltip: {
        trigger: 'axis',
        backgroundColor: '#161b22', borderColor: '#30363d',
        textStyle: { color: '#e6edf3', fontSize: 11 },
        formatter: params => {
          const rsiP  = params.find(p => p.seriesName === 'RSI')
          const maP   = params.find(p => p.seriesName === 'MA')
          const bbUP  = params.find(p => p.seriesName === 'BB+')
          const bbLP  = params.find(p => p.seriesName === 'BB-')
          let html = ''
          if (rsiP?.value != null) html += `RSI&nbsp;<b style="color:${getRsiColor(rsiP.value)}">${rsiP.value}</b>`
          if (maP?.value != null)  html += `&nbsp;&nbsp;MA&nbsp;<b style="color:#eab308">${maP.value}</b>`
          if (bbUP?.value != null) html += `&nbsp;&nbsp;↑<b style="color:#6ee7b7">${bbUP.value}</b>`
          if (bbLP?.value != null) html += `&nbsp;&nbsp;↓<b style="color:#6ee7b7">${bbLP.value}</b>`
          return html || ''
        },
      },
      series: [
        {
          name: 'RSI',
          type: 'line', data: rsiVals, smooth: false, symbol: 'none',
          lineStyle: { color: lastRsi != null ? getRsiColor(lastRsi) : '#9ca3af', width: 1.5 },
          markLine: {
            silent: true, symbol: 'none',
            lineStyle: { width: 1 },
            data: [
              { yAxis: rsiOverbought, lineStyle: { color: 'rgba(239,68,68,0.4)', type: 'dashed' }, label: { formatter: String(rsiOverbought), color: '#ef4444', fontSize: 9 } },
              { yAxis: rsiOversold,   lineStyle: { color: 'rgba(34,197,94,0.4)',  type: 'dashed' }, label: { formatter: String(rsiOversold),   color: '#22c55e',  fontSize: 9 } },
            ],
          },
          markArea: {
            silent: true,
            data: [
              [{ yAxis: rsiOverbought, itemStyle: { color: 'rgba(239,68,68,0.06)' } }, { yAxis: 100 }],
              [{ yAxis: 0,             itemStyle: { color: 'rgba(34,197,94,0.06)' } }, { yAxis: rsiOversold }],
            ],
          },
        },
        {
          name: 'MA',
          type: 'line', data: showMa ? maVals : [], smooth: false, symbol: 'none',
          lineStyle: { color: '#eab308', width: 1.5 },
          connectNulls: false,
        },
        {
          name: 'BB+',
          type: 'line', data: isBB ? bbUpper : [], smooth: false, symbol: 'none',
          lineStyle: { color: '#6ee7b7', width: 1, type: 'dashed' },
          connectNulls: false,
          areaStyle: { color: 'transparent' },
        },
        {
          name: 'BB-',
          type: 'line', data: isBB ? bbLower : [], smooth: false, symbol: 'none',
          lineStyle: { color: '#6ee7b7', width: 1, type: 'dashed' },
          connectNulls: false,
          areaStyle: {
            color: 'rgba(110,231,183,0.06)',
            origin: 'start',
          },
        },
        ...divLineSeries(divPts?.pivotRsi, divPts?.currentRsi),
      ],
    }, true)

    const ro1 = new ResizeObserver(() => candleChart.current?.resize())
    const ro2 = new ResizeObserver(() => rsiChart.current?.resize())
    ro1.observe(candleRef.current)
    ro2.observe(rsiRef.current)
    return () => { ro1.disconnect(); ro2.disconnect() }
  }, [ohlcv, tf, loading, rsiPeriod, rsiOverbought, rsiOversold, rsiMaType, rsiMaLength, rsiBbMult])

  useEffect(() => () => {
    candleChart.current?.dispose(); candleChart.current = null
    rsiChart.current?.dispose();    rsiChart.current    = null
  }, [])

  const { rsiStats, divPtsDisplay } = useMemo(() => {
    const candles = ohlcv[tf]
    if (!candles || candles.length < rsiPeriod + 10) return { rsiStats: null, divPtsDisplay: null }
    const series = computeRsi(candles, rsiPeriod)
    const valid  = series.filter(v => v != null)
    if (!valid.length) return { rsiStats: null, divPtsDisplay: null }
    const ob  = valid.filter(v => v >= rsiOverbought).length
    const os  = valid.filter(v => v <= rsiOversold).length
    const pct = n => ((n / valid.length) * 100).toFixed(1)
    return {
      rsiStats:    { obPct: pct(ob), osPct: pct(os), bars: valid.length },
      divPtsDisplay: findDivergencePoints(candles, series),
    }
  }, [ohlcv, tf, rsiPeriod, rsiOverbought, rsiOversold])

  return (
    <div className="chart-modal-overlay" onClick={onClose}>
      <div className="chart-modal" onClick={e => e.stopPropagation()}>
        <div className="chart-modal-header">
          <div className="chart-modal-title">
            <span className={`badge badge-${asset.type}`}>
              {asset.type === 'crypto' ? 'C' : asset.type === 'tradfi' ? 'T' : 'S'}
            </span>
            {asset.symbol}
            {asset.price != null && (
              <span className="chart-modal-price">
                ${asset.price.toLocaleString('en', { maximumFractionDigits: 4 })}
              </span>
            )}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <div className="btn-group">
              {TIMEFRAMES.map(t => (
                <button key={t} className={tf === t ? 'active' : ''} onClick={() => setTf(t)}>{t}</button>
              ))}
            </div>
            <button className="chart-modal-close" onClick={onClose}>✕</button>
          </div>
        </div>

        <div className="chart-modal-body">
          {loading ? (
            <div className="chart-modal-loading"><div className="spinner" />加载中…</div>
          ) : (ohlcv[tf]?.length ?? 0) < 15 ? (
            <div className="chart-modal-loading">数据不足</div>
          ) : (
            <>
              <div ref={candleRef} style={{ flex: '0 0 52%' }} />
              <div ref={rsiRef}    style={{ flex: '1 1 0' }} />
              {rsiStats && (
                <div className="chart-rsi-stats">
                  <span>RSI 历史概率（{rsiStats.bars} 根K线）：</span>
                  <span style={{ color: '#ef4444' }}>超买 {rsiStats.obPct}%</span>
                  <span style={{ color: '#9ca3af' }}>·</span>
                  <span style={{ color: '#22c55e' }}>超卖 {rsiStats.osPct}%</span>
                  {divPtsDisplay && (
                    <>
                      <span style={{ color: '#9ca3af' }}>·</span>
                      <span style={{
                        color: divPtsDisplay.type === 'bearish' ? '#f97316' : '#22c55e',
                        fontWeight: 600,
                      }}>
                        {divPtsDisplay.type === 'bearish' ? '⚠ 熊市背离' : '✓ 牛市背离'}
                      </span>
                    </>
                  )}
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  )
}
