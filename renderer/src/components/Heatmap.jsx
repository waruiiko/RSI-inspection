import { useRef, useEffect, useMemo } from 'react'
import * as echarts from 'echarts'
import useMarketStore   from '../store/marketStore'
import useSettingsStore from '../store/settingsStore'
import useGroupsStore   from '../store/groupsStore'
import { getRsiColor, getRsiZone } from '../utils/rsi'

const TIMEFRAMES = ['15m', '1h', '4h', '1d']

function symbolHash(str) {
  let h = 2166136261
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i)
    h = Math.imul(h, 16777619) >>> 0
  }
  return h
}

function buildRandomPositions(symbols) {
  const raw = symbols.map(s => ({ s, x: (symbolHash(s) % 10000) / 100 }))
  raw.sort((a, b) => a.x - b.x)
  const minGap = 100 / (symbols.length * 1.2)
  for (let i = 1; i < raw.length; i++) {
    if (raw[i].x - raw[i - 1].x < minGap) raw[i].x = raw[i - 1].x + minGap
  }
  return Object.fromEntries(raw.map(({ s, x }) => [s, Math.min(x, 100)]))
}

export default function Heatmap() {
  const containerRef      = useRef(null)
  const chartRef          = useRef(null)
  const visibleRef        = useRef([])
  const flashTimer        = useRef(null)
  const downplayTimer     = useRef(null)
  const currentHoveredRef = useRef(null)

  const assets        = useMarketStore(s => s.assets)
  const filter        = useMarketStore(s => s.filter)
  const timeframe     = useMarketStore(s => s.timeframe)
  const layout        = useMarketStore(s => s.layout)
  const rsiZones      = useMarketStore(s => s.rsiZones)
  const hoveredSymbol = useMarketStore(s => s.hoveredSymbol)
  const flashSymbol   = useMarketStore(s => s.flashSymbol)
  const setFlash      = useMarketStore(s => s.setFlash)
  const rsiOverbought = useSettingsStore(s => s.rsiOverbought)
  const rsiOversold   = useSettingsStore(s => s.rsiOversold)
  const groups        = useGroupsStore(s => s.groups)
  const groupFilter   = useGroupsStore(s => s.groupFilter)

  const visible = useMemo(() => {
    const groupSet = groupFilter ? new Set(groups[groupFilter] ?? []) : null
    const base = filter === 'all'    ? assets
      : filter === 'crypto'          ? assets.filter(a => a.type === 'crypto')
      : assets.filter(a => a.type !== 'crypto')
    return base
      .filter(a => a.rsi[timeframe] != null)
      .filter(a => !groupSet || groupSet.has(a.apiSymbol))
      .filter(a => rsiZones.length === 5 || rsiZones.includes(getRsiZone(a.rsi[timeframe])))
      .sort((a, b) => b.rsi[timeframe] - a.rsi[timeframe])
  }, [assets, filter, timeframe, rsiZones, groupFilter, groups])

  visibleRef.current = visible
  currentHoveredRef.current = hoveredSymbol

  const avgRsi = useMemo(() => {
    if (!visible.length) return 50
    return visible.reduce((s, a) => s + a.rsi[timeframe], 0) / visible.length
  }, [visible, timeframe])

  const randomPos = useMemo(
    () => buildRandomPositions(visible.map(a => a.symbol)),
    [visible.map(a => a.symbol).join(',')]
  )

  const setFlashRef = useRef(setFlash)
  setFlashRef.current = setFlash

  // Init chart once
  useEffect(() => {
    if (!containerRef.current) return
    const chart = echarts.init(containerRef.current, 'dark')
    chartRef.current = chart

    chart.on('click', (params) => {
      if (params.componentType === 'series' && params.name) {
        setFlashRef.current(params.name)
      }
    })

    const ro = new ResizeObserver(() => {
      if (!chartRef.current?.isDisposed()) chartRef.current?.resize()
    })
    ro.observe(containerRef.current)
    return () => {
      ro.disconnect()
      if (downplayTimer.current) { clearTimeout(downplayTimer.current);  downplayTimer.current = null }
      if (flashTimer.current)    { clearInterval(flashTimer.current);     flashTimer.current    = null }
      chart.dispose()
      chartRef.current = null
    }
  }, [])

  // Update chart data
  useEffect(() => {
    const chart = chartRef.current
    if (!chart || !visible.length) return

    const isRandom = layout === 'random'

    const scatterData = visible.map((a, i) => {
      const xVal = isRandom ? randomPos[a.symbol] : i
      return {
        value: [xVal, a.rsi[timeframe]],
        name:  a.symbol,
        asset: a,
        itemStyle: { color: getRsiColor(a.rsi[timeframe]), borderColor: 'rgba(255,255,255,0.18)', borderWidth: 1 },
        label: {
          show:      true,
          position:  'bottom',
          formatter: a.symbol,
          fontSize:  9,
          color:     '#6b7280',
          rotate:    60,
          distance:  4,
        },
      }
    })

    const xAxisMax = isRandom ? 100 : visible.length - 1

    chart.setOption({
      backgroundColor: 'transparent',
      animation: false,
      grid: { top: 14, bottom: 44, left: 45, right: 20 },
      xAxis: {
        type:  'value',
        min:   isRandom ? -2 : -0.5,
        max:   isRandom ? 102 : xAxisMax + 0.5,
        axisLabel: { show: false },
        axisLine:  { lineStyle: { color: '#30363d' } },
        splitLine: { show: false },
      },
      yAxis: {
        type:  'value',
        min:   0,
        max:   100,
        splitLine: { lineStyle: { color: '#1f2937', type: 'dashed' } },
        axisLabel: { color: '#6b7280', fontSize: 11 },
      },
      tooltip: {
        trigger: 'item',
        confine: true,
        backgroundColor: '#161b22',
        borderColor: '#30363d',
        textStyle: { color: '#e6edf3', fontSize: 12 },
        formatter(params) {
          const a = params.data.asset
          const price = a.price != null
            ? `$${a.price.toLocaleString('en', { maximumFractionDigits: 4 })}`
            : '—'
          const chg = a.change24h != null
            ? `<span style="color:${a.change24h > 0 ? '#3fb950' : '#f85149'}">${a.change24h > 0 ? '+' : ''}${a.change24h.toFixed(2)}%</span>`
            : '—'

          const rsiRows = TIMEFRAMES.map(tf => {
            const val = a.rsi[tf]
            const color = getRsiColor(val)
            return `<tr>
              <td style="color:#6b7280;padding-right:16px">RSI ${tf}</td>
              <td style="color:${color};font-weight:600;text-align:right">${val != null ? val.toFixed(1) : '—'}</td>
            </tr>`
          }).join('')

          return `
            <div style="min-width:160px">
              <div style="font-weight:700;font-size:13px;margin-bottom:6px">
                ${a.symbol}&nbsp;&nbsp;${chg}
              </div>
              <div style="color:#8b949e;margin-bottom:6px">${price}</div>
              <table style="border-collapse:collapse;width:100%">${rsiRows}</table>
            </div>`
        },
      },
      series: [{
        type: 'scatter',
        data: scatterData,
        symbolSize: 10,
        label: { show: true },
        emphasis: {
          scale: 2.2,
          itemStyle: { borderColor: '#fff', borderWidth: 2 },
          label: { color: '#e6edf3', fontSize: 10 },
        },
        z: 10,
        markLine: {
          silent: true,
          symbol: 'none',
          lineStyle: { width: 1 },
          data: [
            {
              yAxis: rsiOverbought,
              lineStyle: { color: 'rgba(239,68,68,0.5)', type: 'dashed' },
              label: { formatter: `超买 ${rsiOverbought}`, color: '#ef4444', position: 'insideEndTop', fontSize: 10 },
            },
            {
              yAxis: rsiOversold,
              lineStyle: { color: 'rgba(34,197,94,0.5)', type: 'dashed' },
              label: { formatter: `超卖 ${rsiOversold}`, color: '#22c55e', position: 'insideEndBottom', fontSize: 10 },
            },
            {
              yAxis: parseFloat(avgRsi.toFixed(1)),
              lineStyle: { color: 'rgba(245,158,11,0.6)', type: 'dashed' },
              label: {
                formatter: `均值 ${avgRsi.toFixed(1)}`,
                color: '#f59e0b',
                position: avgRsi > 62 ? 'insideEndBottom' : 'insideEndTop',
                fontSize: 10,
              },
            },
          ],
        },
        markArea: {
          silent: true,
          data: [
            [{ yAxis: rsiOverbought, itemStyle: { color: 'rgba(239,68,68,0.08)' } }, { yAxis: 100 }],
            [{ yAxis: 0, itemStyle: { color: 'rgba(34,197,94,0.08)' } }, { yAxis: rsiOversold }],
          ],
        },
      },
      {
        type: 'scatter',
        data: visible.map((a, i) => {
          const xVal = isRandom ? randomPos[a.symbol] : i
          const chg  = a.change24h
          return {
            value: [xVal, a.rsi[timeframe]],
            name:  a.symbol,
            label: {
              show:      chg != null,
              position:  'top',
              formatter: chg != null ? `${chg > 0 ? '+' : ''}${chg.toFixed(1)}%` : '',
              fontSize:  8,
              color:     chg > 0 ? '#3fb950' : '#f85149',
              distance:  3,
            },
          }
        }),
        symbolSize: 0,
        silent: true,
        label: { show: true },
        z: 9,
      }],
    }, true)
  }, [visible, timeframe, layout, avgRsi, randomPos, rsiOverbought, rsiOversold])

  // Hover highlight with 1s delayed downplay of previous
  useEffect(() => {
    const chart = chartRef.current
    if (!chart || chart.isDisposed()) return
    if (downplayTimer.current) { clearTimeout(downplayTimer.current); downplayTimer.current = null }
    if (!hoveredSymbol) {
      chart.dispatchAction({ type: 'downplay', seriesIndex: 0 })
      return
    }
    const idx = visibleRef.current.findIndex(a => a.symbol === hoveredSymbol)
    if (idx >= 0) chart.dispatchAction({ type: 'highlight', seriesIndex: 0, dataIndex: idx })
    downplayTimer.current = setTimeout(() => {
      downplayTimer.current = null
      const c = chartRef.current
      if (!c || c.isDisposed()) return
      c.dispatchAction({ type: 'downplay', seriesIndex: 0 })
      const cur = currentHoveredRef.current
      if (cur) {
        const curIdx = visibleRef.current.findIndex(a => a.symbol === cur)
        if (curIdx >= 0) c.dispatchAction({ type: 'highlight', seriesIndex: 0, dataIndex: curIdx })
      }
    }, 1000)
  }, [hoveredSymbol])

  // Flash on click
  useEffect(() => {
    if (!flashSymbol) return
    const chart = chartRef.current
    if (!chart || chart.isDisposed()) return
    const idx = visibleRef.current.findIndex(a => a.symbol === flashSymbol.symbol)
    if (idx < 0) return

    if (flashTimer.current) clearInterval(flashTimer.current)
    let step = 0
    const STEPS = 6  // 3 full blink cycles × 2
    flashTimer.current = setInterval(() => {
      const c = chartRef.current
      if (!c || c.isDisposed()) { clearInterval(flashTimer.current); flashTimer.current = null; return }
      step++
      if (step % 2 === 1) {
        c.dispatchAction({ type: 'highlight', seriesIndex: 0, dataIndex: idx })
      } else {
        c.dispatchAction({ type: 'downplay', seriesIndex: 0 })
      }
      if (step >= STEPS) {
        clearInterval(flashTimer.current)
        flashTimer.current = null
        c.dispatchAction({ type: 'downplay', seriesIndex: 0 })
      }
    }, 400)
  }, [flashSymbol])

  return (
    <div ref={containerRef} style={{ width: '100%', height: '100%' }} />
  )
}
