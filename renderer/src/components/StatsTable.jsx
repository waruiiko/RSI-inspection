import { useState, useRef, useCallback, useMemo, useEffect } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import useMarketStore   from '../store/marketStore'
import useSettingsStore from '../store/settingsStore'
import useGroupsStore   from '../store/groupsStore'
import { getRsiColor, getRsiZone, formatPrice } from '../utils/rsi'
import ChartModal from './ChartModal'
import { applyLiquidityLimit, formatTurnover, getQuoteVolume } from '../utils/liquidity'
import { assetKey, matchesAssetRef } from '../utils/assetKey'

const TIMEFRAMES = ['15m', '1h', '4h', '1d']
const ROW_HEIGHT = 38
const SIGNAL_FILTERS = [
  { key: 'all', label: '全部信号' },
  { key: 'breakout', label: '突破' },
  { key: 'breakdown', label: '破位' },
  { key: 'divergence', label: '背离' },
  { key: 'strong', label: '强信号' },
]
const SIGNAL_DESCRIPTIONS = {
  breakout_confirmed: '收盘价突破近期高点，且成交量明显高于均值。',
  breakout_attempt: '价格接近突破区，但确认强度不足，适合继续观察。',
  breakdown_confirmed: '收盘价跌破近期低点，且成交量放大。',
  breakdown_attempt: '价格接近破位区，但确认强度不足，适合继续观察。',
  bearish_volume_divergence: '价格创新高，但量能没有同步放大。',
  bullish_seller_exhaustion: '价格创新低，但抛压和量能在减弱。',
  volume_rebound_up: '下跌后出现放量反弹，但还不是突破确认。',
  volume_selloff: '上涨或横盘后出现放量回落。',
}

function signalMatches(signal, score, filter) {
  if (filter === 'all') return true
  if (!signal) return false
  if (filter === 'breakout') return ['breakout_confirmed', 'breakout_attempt', 'volume_rebound_up'].includes(signal.type)
  if (filter === 'breakdown') return ['breakdown_confirmed', 'breakdown_attempt', 'volume_selloff'].includes(signal.type)
  if (filter === 'divergence') return ['bearish_volume_divergence', 'bullish_seller_exhaustion'].includes(signal.type)
  if (filter === 'strong') return Math.abs(score ?? 0) >= 4
  return true
}

/* 鈹€鈹€ Score helpers 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€ */
function getScore(asset, ob, os, tf = '4h') {
  if (asset.signalScore?.[tf] != null) return asset.signalScore[tf]
  return TIMEFRAMES.reduce((sum, tf) => {
    const rsi = asset.rsi[tf]
    if (rsi == null) return sum
    if (rsi >= ob) return sum + 1
    if (rsi <= os) return sum - 1
    return sum
  }, 0)
}

function scoreColor(s) {
  if (s >=  3) return '#ef4444'
  if (s >=  1) return '#f97316'
  if (s === 0) return '#6b7280'
  if (s >= -2) return '#4ade80'
  return '#22c55e'
}

/* 鈹€鈹€ Sort icon 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€ */
function SortIcon({ col, sortCol, sortDir }) {
  if (sortCol !== col) return <span className="sort-icon dim">↕</span>
  return <span className="sort-icon active">{sortDir === 'desc' ? '↓' : '↑'}</span>
}

/* 鈹€鈹€ Gradient sparkline 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€ */
function Sparkline({ closes }) {
  if (!closes || closes.length < 2) return null
  const W = 56, H = 20
  const min = Math.min(...closes)
  const max = Math.max(...closes)
  const range = max - min || 1
  const pts = closes.map((v, i) => [
    (i / (closes.length - 1)) * W,
    H - 2 - ((v - min) / range) * (H - 4),
  ])
  const linePts = pts.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' ')
  const up = closes[closes.length - 1] >= closes[0]
  const color = up ? '#22c55e' : '#ef4444'
  const id = `sp-${Math.random().toString(36).slice(2, 8)}`
  const fillPath =
    `M${pts[0][0].toFixed(1)},${pts[0][1].toFixed(1)}` +
    pts.slice(1).map(([x, y]) => `L${x.toFixed(1)},${y.toFixed(1)}`).join('') +
    `L${W},${H} L0,${H}Z`
  return (
    <svg width={W} height={H} style={{ display: 'block', verticalAlign: 'middle', overflow: 'visible' }}>
      <defs>
        <linearGradient id={id} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%"   stopColor={color} stopOpacity="0.25" />
          <stop offset="100%" stopColor={color} stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={fillPath} fill={`url(#${id})`} />
      <polyline points={linePts} fill="none" stroke={color} strokeWidth="1.4"
        strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  )
}
/* 鈹€鈹€ RSI cell: value + mini progress bar 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€ */
function RsiCell({ value, isActive, arrow, arrowColor, div }) {
  if (value == null) return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
      <span style={{ color: 'var(--dim)', fontSize: 12 }}>-</span>
    </div>
  )
  const color = getRsiColor(value)
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 3 }}>
        <span style={{ color, fontWeight: isActive ? 700 : 500, fontSize: 12, fontVariantNumeric: 'tabular-nums', lineHeight: 1 }}>
          {value.toFixed(1)}
        </span>
        {arrow && <span style={{ color: arrowColor, fontSize: 9, lineHeight: 1 }}>{arrow}</span>}
        {div === 'bullish' && <span style={{ color: '#3fb950', fontSize: 9 }} title="RSI看涨背离">↗</span>}
        {div === 'bearish' && <span style={{ color: '#f85149', fontSize: 9 }} title="RSI看跌背离">↘</span>}
      </div>
      <div style={{ width: 40, height: 2.5, background: 'var(--bg3)', borderRadius: 2, overflow: 'hidden' }}>
        <div style={{ width: `${value}%`, height: '100%', background: color, borderRadius: 2 }} />
      </div>
    </div>
  )
}

/* 鈹€鈹€ Change badge 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€ */
function ChangeBadge({ value }) {
  if (value == null) return <span style={{ color: 'var(--dim)', fontSize: 12 }}>-</span>
  const up = value > 0
  return (
    <span style={{
      display: 'inline-block',
      padding: '2px 6px',
      borderRadius: 4,
      fontSize: 11,
      fontWeight: 600,
      fontVariantNumeric: 'tabular-nums',
      background: up ? 'rgba(34,197,94,0.1)' : 'rgba(239,68,68,0.1)',
      color: up ? '#22c55e' : '#ef4444',
      border: `1px solid ${up ? 'rgba(34,197,94,0.2)' : 'rgba(239,68,68,0.2)'}`,
    }}>
      {up ? '+' : ''}{value.toFixed(2)}%
    </span>
  )
}

function VolumeSignalBadge({ signal, score }) {
  if (!signal) return <span style={{ color: 'var(--dim)', fontSize: 11 }}>-</span>
  const color = signal.direction === 'bullish' ? '#22c55e'
    : signal.direction === 'bearish' ? '#ef4444'
    : signal.direction === 'caution' ? '#f97316'
    : '#8b949e'
  return (
    <span title={`${SIGNAL_DESCRIPTIONS[signal.type] ?? '量价结构信号'} 评分 ${score ?? 0}，量能 ${signal.volumeRatio ?? '-'}x`}
      style={{
        display: 'inline-block',
        maxWidth: 84,
        padding: '1px 6px',
        borderRadius: 4,
        fontSize: 11,
        color,
        background: `${color}18`,
        whiteSpace: 'nowrap',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
      }}>
      {signal.label}
    </span>
  )
}

function getDataIssue(asset) {
  const turnover = getQuoteVolume(asset)
  if (!turnover) return '成交额缺失'
  if (asset.type === 'crypto' && turnover < 1_000_000) return '成交额偏低'
  if (asset.price == null) return '价格缺失'
  const rsiCount = TIMEFRAMES.filter(tf => asset.rsi?.[tf] != null).length
  if (rsiCount < 2) return 'K线数据不足'
  return null
}

/* 鈹€鈹€ CSV export 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€ */
function exportCsv(visible, timeframe) {
  const headers = ['#', '品种', '类型', '价格', '成交额', '24h%', ...TIMEFRAMES.map(tf => `RSI ${tf}`), '量价信号', '评分']
  const rows = visible.map((a, i) => [
    i + 1,
    a.symbol,
    a.type,
    a.price ?? '',
    getQuoteVolume(a) || '',
    a.change24h != null ? a.change24h.toFixed(2) : '',
    ...TIMEFRAMES.map(tf => a.rsi[tf] != null ? a.rsi[tf].toFixed(1) : ''),
    a.volumeSignal?.[timeframe]?.label ?? '',
    a.signalScore?.[timeframe] ?? '',
  ])
  const csv = [headers, ...rows].map(r => r.join(',')).join('\n')
  const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8' })
  const url  = URL.createObjectURL(blob)
  const a    = document.createElement('a')
  a.href = url
  a.download = `rsi-${new Date().toISOString().slice(0, 16).replace('T', '_')}.csv`
  a.click()
  URL.revokeObjectURL(url)
}

/* 鈹€鈹€ Main component 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€ */
export default function StatsTable() {
  const rsiOverbought = useSettingsStore(s => s.rsiOverbought)
  const rsiOversold   = useSettingsStore(s => s.rsiOversold)
  const groups        = useGroupsStore(s => s.groups)
  const groupFilter   = useGroupsStore(s => s.groupFilter)
  const assets        = useMarketStore(s => s.assets)
  const filter        = useMarketStore(s => s.filter)
  const liquidityLimit = useMarketStore(s => s.liquidityLimit)
  const timeframe     = useMarketStore(s => s.timeframe)
  const pinnedSymbols = useMarketStore(s => s.pinnedSymbols)
  const flashSymbol   = useMarketStore(s => s.flashSymbol)
  const prevRsi       = useMarketStore(s => s.prevRsi)
  const setHovered    = useMarketStore(s => s.setHovered)
  const setFlash      = useMarketStore(s => s.setFlash)
  const togglePin     = useMarketStore(s => s.togglePin)

  const [query,       setQuery]       = useState('')
  const [highlighted, setHighlighted] = useState(null)
  const [sortCol,     setSortCol]     = useState(null)
  const [sortDir,     setSortDir]     = useState(null)
  const [signalFilter, setSignalFilter] = useState('all')
  const [chartAsset,  setChartAsset]  = useState(null)

  const searchFocusTick = useMarketStore(s => s.searchFocusTick)
  const wrapperRef  = useRef(null)
  const searchRef   = useRef(null)
  const hoverTimer  = useRef(null)

  useEffect(() => {
    if (searchFocusTick > 0) searchRef.current?.focus()
  }, [searchFocusTick])

  const handleRowEnter = useCallback((symbol) => {
    if (hoverTimer.current) { clearTimeout(hoverTimer.current); hoverTimer.current = null }
    setHovered(symbol)
  }, [setHovered])

  const handleBodyLeave = useCallback(() => {
    hoverTimer.current = setTimeout(() => { setHovered(null); hoverTimer.current = null }, 1000)
  }, [setHovered])

  useEffect(() => () => { if (hoverTimer.current) clearTimeout(hoverTimer.current) }, [])

  const handleSort = useCallback((col) => {
    if (sortCol !== col) {
      setSortCol(col); setSortDir('desc')
    } else if (sortDir === 'desc') {
      setSortDir('asc')
    } else {
      setSortCol(null); setSortDir(null)
    }
  }, [sortCol, sortDir])

  const visible = useMemo(() => {
    const groupSet = groupFilter ? new Set(groups[groupFilter] ?? []) : null
    const base = applyLiquidityLimit((filter === 'all'    ? assets
      : filter === 'crypto'           ? assets.filter(a => a.type === 'crypto')
      : assets.filter(a => a.type !== 'crypto'))
      .filter(a => a.rsi[timeframe] != null)
      .filter(a => !groupSet || groupSet.has(a.apiSymbol))
      .filter(a => signalMatches(a.volumeSignal?.[timeframe], a.signalScore?.[timeframe], signalFilter)), liquidityLimit)

    let sorted
    if (sortCol && sortDir) {
      sorted = [...base].sort((a, b) => {
        const va = sortCol === 'turnover' ? (getQuoteVolume(a) ?? -Infinity)
                 : sortCol === '24h'      ? (a.change24h ?? -Infinity)
                 : sortCol === 'score'    ? getScore(a, rsiOverbought, rsiOversold, timeframe)
                 : sortCol === 'signal'   ? Math.abs(getScore(a, rsiOverbought, rsiOversold, timeframe))
                 : (a.rsi[sortCol] ?? -Infinity)
        const vb = sortCol === 'turnover' ? (getQuoteVolume(b) ?? -Infinity)
                 : sortCol === '24h'      ? (b.change24h ?? -Infinity)
                 : sortCol === 'score'    ? getScore(b, rsiOverbought, rsiOversold, timeframe)
                 : sortCol === 'signal'   ? Math.abs(getScore(b, rsiOverbought, rsiOversold, timeframe))
                 : (b.rsi[sortCol] ?? -Infinity)
        return sortDir === 'desc' ? vb - va : va - vb
      })
    } else {
      sorted = [...base].sort((a, b) => (b.rsi[timeframe] ?? 0) - (a.rsi[timeframe] ?? 0))
    }

    if (pinnedSymbols.size === 0) return sorted
    const pinned   = sorted.filter(a =>  pinnedSymbols.has(assetKey(a)) || pinnedSymbols.has(a.symbol))
    const unpinned = sorted.filter(a => !pinnedSymbols.has(assetKey(a)) && !pinnedSymbols.has(a.symbol))
    return [...pinned, ...unpinned]
  }, [assets, filter, timeframe, sortCol, sortDir, pinnedSymbols, groupFilter, groups, liquidityLimit, signalFilter, rsiOverbought, rsiOversold])

  const virtualizer = useVirtualizer({
    count: visible.length,
    getScrollElement: () => wrapperRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 8,
  })

  const scrollToIndex = useCallback((idx) => {
    if (idx < 0) return
    virtualizer.scrollToIndex(idx, { align: 'center' })
  }, [virtualizer])

  useEffect(() => {
    if (!flashSymbol?.symbol) return
    const idx = visible.findIndex(a => matchesAssetRef(a, flashSymbol.symbol))
    if (idx >= 0) { scrollToIndex(idx); setHighlighted(flashSymbol.symbol) }
  }, [flashSymbol])

  const doSearch = useCallback(() => {
    const q = query.trim().toUpperCase()
    if (!q) return
    let idx = visible.findIndex(a => a.symbol.toUpperCase() === q)
    if (idx < 0) idx = visible.findIndex(a => a.symbol.toUpperCase().includes(q))
    if (idx < 0) return
    scrollToIndex(idx)
    setHighlighted(visible[idx].symbol)
  }, [query, visible, scrollToIndex])

  const vItems  = virtualizer.getVirtualItems()
  const padTop  = vItems.length > 0 ? vItems[0].start : 0
  const padBot  = vItems.length > 0 ? virtualizer.getTotalSize() - vItems[vItems.length - 1].end : 0

  return (
    <div className="table-section">
      {chartAsset && <ChartModal asset={chartAsset} onClose={() => setChartAsset(null)} />}

      {/* 鈹€鈹€ Search bar 鈹€鈹€ */}
      <div className="table-search">
        <input
          ref={searchRef}
          type="search"
          className="search-input"
          placeholder="搜索品种... (Ctrl+F)"
          value={query}
          onChange={e => setQuery(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && doSearch()}
        />
        <button className="search-btn" onClick={doSearch}>确认</button>
        <button className="search-btn export-btn" onClick={() => exportCsv(visible, timeframe)} title="导出 CSV">导出 CSV</button>
        <div className="btn-group">
          {SIGNAL_FILTERS.map(f => (
            <button key={f.key} className={signalFilter === f.key ? 'active' : ''} onClick={() => setSignalFilter(f.key)}>
              {f.label}
            </button>
          ))}
        </div>
        <span style={{ fontSize: 11, color: 'var(--dim)', alignSelf: 'center', marginLeft: 4 }}>
          {visible.length} 个品种
        </span>
      </div>

      {/* 鈹€鈹€ Table 鈹€鈹€ */}
      <div className="table-wrapper" ref={wrapperRef}>
        <table className="stats-table">
          <thead>
            <tr>
              <th style={{ width: 32 }}>#</th>
              <th>品种</th>
              <th>价格</th>
              <th className="th-sort" onClick={() => handleSort('turnover')}>
                成交额 <SortIcon col="turnover" sortCol={sortCol} sortDir={sortDir} />
              </th>
              <th className="th-sort" onClick={() => handleSort('24h')}>
                24h% <SortIcon col="24h" sortCol={sortCol} sortDir={sortDir} />
              </th>
              {TIMEFRAMES.map(tf => (
                <th key={tf} className="th-sort" onClick={() => handleSort(tf)}>
                  RSI {tf} <SortIcon col={tf} sortCol={sortCol} sortDir={sortDir} />
                </th>
              ))}
              <th className="th-sort" onClick={() => handleSort('score')} title="量价结构优先的综合评分（-6 到 +6）">
                评分 <SortIcon col="score" sortCol={sortCol} sortDir={sortDir} />
              </th>
              <th className="th-sort" onClick={() => handleSort('signal')} style={{ width: 94 }}>
                量价 <SortIcon col="signal" sortCol={sortCol} sortDir={sortDir} />
              </th>
              <th style={{ width: 72 }}>走势</th>
            </tr>
          </thead>
          <tbody onMouseLeave={handleBodyLeave}>
            {padTop > 0 && <tr><td colSpan={11} style={{ height: padTop, padding: 0, border: 'none' }} /></tr>}
            {vItems.map(vItem => {
              const i = vItem.index
              const a = visible[i]
              const key = assetKey(a)
              const dataIssue = getDataIssue(a)
              const isPinned      = pinnedSymbols.has(key) || pinnedSymbols.has(a.symbol)
              const nextKey       = visible[i + 1] ? assetKey(visible[i + 1]) : ''
              const isPinBoundary = isPinned && (i === visible.length - 1 || (!pinnedSymbols.has(nextKey) && !pinnedSymbols.has(visible[i + 1]?.symbol)))

              return (
                <tr
                  key={key}
                  style={{ height: ROW_HEIGHT }}
                  className={[
                    highlighted === a.symbol || highlighted === key ? 'highlighted' : '',
                    isPinned      ? 'row-pinned'  : '',
                    isPinBoundary ? 'row-pin-end' : '',
                  ].filter(Boolean).join(' ')}
                  onMouseEnter={() => handleRowEnter(key)}
                  onClick={() => setFlash(key)}
                  onDoubleClick={() => setChartAsset(a)}
                >
                  {/* # */}
                  <td className="dim" style={{ fontSize: 11 }}>{i + 1}</td>

                  {/* 鍝佺 */}
                  <td>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                      <button
                        className={`pin-btn ${isPinned ? 'active' : ''}`}
                        title={isPinned ? '取消置顶' : '置顶'}
                        onClick={e => { e.stopPropagation(); togglePin(key) }}
                      >◆</button>
                      {/* Zone accent bar */}
                      <div style={{
                        width: 3, height: 22, borderRadius: 2, flexShrink: 0,
                        background: getRsiColor(a.rsi[timeframe]),
                        opacity: 0.8,
                      }} />
                      <span className={`badge badge-${a.type}`}>
                        {a.type === 'crypto' ? 'C' : a.type === 'tradfi' ? 'T' : 'S'}
                      </span>
                      <div style={{ display: 'flex', flexDirection: 'column', lineHeight: 1.2 }}>
                        <span style={{ fontWeight: 600, fontSize: 12 }}>
                          {a.symbol}
                          {dataIssue && (
                            <span className="data-issue-badge" title={dataIssue}>!</span>
                          )}
                        </span>
                      </div>
                    </div>
                  </td>

                  {/* 浠锋牸 */}
                  <td className="mono" style={{ fontSize: 12, color: 'var(--muted)' }}>
                    {formatPrice(a.price)}
                  </td>

                  <td className="mono" style={{ fontSize: 11, color: 'var(--dim)' }}>
                    {formatTurnover(getQuoteVolume(a))}
                  </td>

                  {/* 24h% */}
                  <td>
                    <ChangeBadge value={a.change24h} />
                  </td>

                  {/* RSI per timeframe */}
                  {TIMEFRAMES.map(tf => {
                    const cur   = a.rsi[tf]
                    const prev  = prevRsi[key]?.[tf]
                    const delta = (cur != null && prev != null) ? cur - prev : null
                    const arrow = delta == null ? '' : delta > 0.05 ? '↑' : delta < -0.05 ? '↓' : ''
                    const arrowColor = delta > 0.05 ? '#f97316' : '#38bdf8'
                    const div   = a.divergence?.[tf]
                    return (
                      <td key={tf}>
                        <RsiCell
                          value={cur}
                          isActive={tf === timeframe}
                          arrow={arrow}
                          arrowColor={arrowColor}
                          div={div}
                        />
                      </td>
                    )
                  })}

                  {/* 缁煎悎璇勫垎 */}
                  {(() => {
                    const s = getScore(a, rsiOverbought, rsiOversold, timeframe)
                    return (
                      <td key="score">
                        <span style={{
                          display: 'inline-block',
                          padding: '1px 6px',
                          borderRadius: 4,
                          fontSize: 11,
                          fontWeight: 700,
                          fontVariantNumeric: 'tabular-nums',
                          color: scoreColor(s),
                          background: `${scoreColor(s)}18`,
                        }}>
                          {s > 0 ? `+${s}` : s}
                        </span>
                      </td>
                    )
                  })()}

                  <td>
                    <VolumeSignalBadge signal={a.volumeSignal?.[timeframe]} score={a.signalScore?.[timeframe]} />
                  </td>

                  {/* 璧板娍 sparkline */}
                  <td style={{ padding: '6px 12px' }}>
                    <Sparkline closes={a.sparkline} />
                  </td>
                </tr>
              )
            })}
            {padBot > 0 && <tr><td colSpan={11} style={{ height: padBot, padding: 0, border: 'none' }} /></tr>}
          </tbody>
        </table>
      </div>
    </div>
  )
}
