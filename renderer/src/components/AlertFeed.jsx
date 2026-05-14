import { Fragment, useState, useMemo } from 'react'
import useAlertStore  from '../store/alertStore'
import useMarketStore from '../store/marketStore'
import ChartModal from './ChartModal'

const TYPE_FILTERS = [
  { key: 'all',        label: '全部' },
  { key: 'rsi',        label: 'RSI' },
  { key: 'price',      label: '价格' },
  { key: 'change',     label: '涨跌' },
  { key: 'divergence', label: '背离' },
  { key: 'structure',  label: '量价' },
]

function fmtTime(ts) {
  const d = new Date(ts)
  const time = d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' })
  const day  = String(d.getDate()).padStart(2, '0')
  const mon  = String(d.getMonth() + 1).padStart(2, '0')
  return `${time}  ${day}/${mon}`
}

function fmtPrice(v) {
  if (v >= 1000) return v.toLocaleString('en-US', { maximumFractionDigits: 2 })
  if (v >= 1)    return v.toFixed(4)
  return v.toPrecision(4)
}

function fmtDetail(item) {
  if (item.type === 'rsi') {
    const dir = item.condition === 'above' ? '超过' : '低于'
    return ` RSI(${item.timeframe}) ${dir} ${item.threshold}，当前 ${item.value.toFixed(1)}`
  }
  if (item.type === 'price') {
    const dir = item.condition === 'above' ? '突破' : '跌破'
    return ` 价格${dir} ${fmtPrice(item.threshold)}，当前 ${fmtPrice(item.value)}`
  }
  if (item.type === 'divergence') {
    const dir = item.condition === 'bull' ? '牛市背离' : '熊市背离'
    return ` (${item.timeframe}) 检测到 ${dir}`
  }
  if (item.type === 'structure') {
    const ratio = item.volumeRatio != null ? `，量能 ${item.volumeRatio}x` : ''
    const move = item.priceMovePct != null ? `，K线 ${item.priceMovePct > 0 ? '+' : ''}${item.priceMovePct}%` : ''
    return ` (${item.timeframe}) ${item.signal ?? '量价结构'}，评分 ${item.value}${ratio}${move}`
  }
  const dir = item.condition === 'above' ? '涨超' : '跌超'
  const mag = Math.abs(item.threshold)
  return ` 24h${dir} ${mag}%，当前 ${(item.value > 0 ? '+' : '') + item.value.toFixed(2)}%`
}

function levelLabel(item) {
  const level = item.level ?? (item.special ? 3 : 1)
  return `${level}级`
}

function itemColor(item) {
  if (item.type === 'rsi') {
    return item.condition === 'above' ? 'feed-orange' : 'feed-sky'
  }
  if (item.type === 'price') {
    return item.condition === 'above' ? 'feed-red' : 'feed-green'
  }
  if (item.type === 'divergence') {
    return item.condition === 'bull' ? 'feed-green' : 'feed-orange'
  }
  if (item.type === 'structure') {
    return item.condition === 'bullish' ? 'feed-green'
      : item.condition === 'bearish' ? 'feed-red'
      : 'feed-orange'
  }
  return item.value > 0 ? 'feed-green' : 'feed-red'
}

function exportFeedCsv(items, assets) {
  const rows = items.map(item => {
    const a = assets.find(x => x.symbol === item.symbol || x.apiSymbol === item.symbol)
    const current = a?.price ?? ''
    const move = item.price && a?.price ? ((a.price - item.price) / item.price).toFixed(2) : ''
    return [
      new Date(item.ts).toLocaleString('zh-CN'),
      item.symbol,
      item.type,
      item.timeframe ?? '',
      item.condition ?? '',
      item.threshold ?? '',
      item.value ?? '',
      item.price ?? '',
      current,
      move,
      item.outcomes?.['1h']?.changePct?.toFixed(2) ?? '',
      item.outcomes?.['4h']?.changePct?.toFixed(2) ?? '',
      item.outcomes?.['24h']?.changePct?.toFixed(2) ?? '',
    ]
  })
  const headers = ['时间', '品种', '类型', '周期', '条件', '阈值', '触发值', '触发价', '当前价', '当前涨跌%', '1h%', '4h%', '24h%']
  const csv = [headers, ...rows].map(r => r.map(v => `"${String(v).replaceAll('"', '""')}"`).join(',')).join('\n')
  const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = `alert-feed-${new Date().toISOString().slice(0, 10)}.csv`
  link.click()
  URL.revokeObjectURL(url)
}

export default function AlertFeed() {
  const feed      = useAlertStore(s => s.feed)
  const clearFeed = useAlertStore(s => s.clearFeed)
  const setFlash  = useMarketStore(s => s.setFlash)
  const assets    = useMarketStore(s => s.assets)

  const [typeFilter,   setTypeFilter]   = useState('all')
  const [symbolFilter, setSymbolFilter] = useState('')
  const [selectedItem, setSelectedItem] = useState(null)
  const [chartAsset, setChartAsset] = useState(null)

  const visible = useMemo(() => {
    const q = symbolFilter.trim().toUpperCase()
    return feed.filter(item => {
      if (typeFilter !== 'all' && item.type !== typeFilter) return false
      if (q && !item.symbol.toUpperCase().includes(q)) return false
      return true
    })
  }, [feed, typeFilter, symbolFilter])

  const reviewAsset = selectedItem
    ? assets.find(a => a.symbol === selectedItem.symbol || a.apiSymbol === selectedItem.symbol)
    : null
  const currentMove = selectedItem?.price && reviewAsset?.price
    ? ((reviewAsset.price - selectedItem.price) / selectedItem.price) * 100
    : null

  const perf = useMemo(() => {
    const rows = []
    for (const item of feed) {
      const a = assets.find(x => x.symbol === item.symbol || x.apiSymbol === item.symbol)
      if (!a?.price || !item.price) continue
      const move = ((a.price - item.price) / item.price) * 100
      const expectedUp = item.type === 'rsi'
        ? item.condition === 'below'
        : item.type === 'price'
          ? item.condition === 'above'
          : item.type === 'divergence'
            ? item.condition === 'bull'
            : (item.value ?? 0) > 0
      rows.push({ move, hit: expectedUp ? move > 0 : move < 0 })
    }
    const hit = rows.filter(r => r.hit).length
    return { total: rows.length, hit, rate: rows.length ? Math.round(hit / rows.length * 100) : null }
  }, [feed, assets])

  return (
    <div className="alert-feed">
      {/* Head */}
      <div className="feed-head">
        <span className="feed-title">提醒记录</span>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          {feed.length > 0 && (
            <span style={{ fontSize: 10, color: 'var(--dim)', fontVariantNumeric: 'tabular-nums' }}>
              {feed.length} 条{perf.total ? ` · 命中 ${perf.rate}%` : ''}
            </span>
          )}
          {feed.length > 0 && (
            <button className="feed-clear-btn" onClick={clearFeed}>清除</button>
          )}
          {feed.length > 0 && (
            <button className="feed-clear-btn" onClick={() => exportFeedCsv(visible, assets)}>导出</button>
          )}
        </div>
      </div>

      {/* Filters */}
      {feed.length > 0 && (
        <div className="feed-filters">
          <div className="feed-type-btns">
            {TYPE_FILTERS.map(f => (
              <button
                key={f.key}
                className={`feed-type-btn ${typeFilter === f.key ? 'active' : ''}`}
                onClick={() => setTypeFilter(f.key)}
              >
                {f.label}
              </button>
            ))}
          </div>
          <input
            type="search"
            className="feed-sym-search"
            placeholder="品种…"
            value={symbolFilter}
            onChange={e => setSymbolFilter(e.target.value)}
          />
        </div>
      )}

      {/* List */}
      <div className="feed-list">
        {feed.length === 0
          ? <div className="feed-empty">暂无提醒</div>
          : visible.length === 0
            ? <div className="feed-empty">无匹配记录</div>
            : visible.map(item => (
              <div
                key={item.id}
                className={`feed-item ${itemColor(item)} ${item.level >= 2 || item.special ? 'feed-special' : ''}`}
                onClick={() => setSelectedItem(item)}
              >
                <span className="feed-time">{fmtTime(item.ts)}</span>
                <span className="feed-msg">
                  <span className="feed-star">{levelLabel(item)}</span>
                  <span
                    className="feed-symbol"
                    onClick={e => { e.stopPropagation(); setFlash(item.symbol) }}
                  >
                    {item.symbol}
                  </span>
                  {fmtDetail(item)}
                </span>
              </div>
            ))
        }
      </div>

      {selectedItem && (
        <div className="review-overlay" onClick={() => setSelectedItem(null)}>
          <div className="review-panel" onClick={e => e.stopPropagation()}>
            <div className="review-head">
              <strong>{selectedItem.symbol} 提醒复盘</strong>
              <button className="chart-modal-close" onClick={() => setSelectedItem(null)}>×</button>
            </div>
            <div className="review-grid">
              <span>触发时间</span><b>{new Date(selectedItem.ts).toLocaleString('zh-CN')}</b>
              <span>提醒内容</span><b>{fmtDetail(selectedItem)}</b>
              <span>触发价格</span><b>{selectedItem.price ? fmtPrice(selectedItem.price) : '-'}</b>
              <span>当前价格</span><b>{reviewAsset?.price ? fmtPrice(reviewAsset.price) : '-'}</b>
              <span>触发后变化</span>
              <b style={{ color: currentMove == null ? 'var(--muted)' : currentMove >= 0 ? '#22c55e' : '#ef4444' }}>
                {currentMove == null ? '-' : `${currentMove >= 0 ? '+' : ''}${currentMove.toFixed(2)}%`}
              </b>
              {['1h', '4h', '24h'].map(key => {
                const outcome = selectedItem.outcomes?.[key]
                return (
                  <Fragment key={key}>
                    <span>{key}结果</span>
                    <b style={{
                      color: outcome == null ? 'var(--muted)' : outcome.changePct >= 0 ? '#22c55e' : '#ef4444',
                    }}>
                      {outcome == null ? '等待记录' : `${outcome.changePct >= 0 ? '+' : ''}${outcome.changePct.toFixed(2)}%`}
                    </b>
                  </Fragment>
                )
              })}
            </div>
            <div className="review-actions">
              <button className="zone-btn" onClick={() => setFlash(selectedItem.symbol)}>在首页定位</button>
              <button className="zone-btn" disabled={!reviewAsset} onClick={() => reviewAsset && setChartAsset(reviewAsset)}>
                打开K线并查看标记
              </button>
            </div>
          </div>
        </div>
      )}

      {chartAsset && <ChartModal asset={chartAsset} alertItem={selectedItem} onClose={() => setChartAsset(null)} />}
    </div>
  )
}
