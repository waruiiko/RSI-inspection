import { useState, useMemo } from 'react'
import useAlertStore  from '../store/alertStore'
import useMarketStore from '../store/marketStore'

const TYPE_FILTERS = [
  { key: 'all',        label: '全部' },
  { key: 'rsi',        label: 'RSI' },
  { key: 'price',      label: '价格' },
  { key: 'change',     label: '涨跌' },
  { key: 'divergence', label: '背离' },
]

function fmtTime(ts) {
  const d = new Date(ts)
  const time = d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' })
  const day  = String(d.getDate()).padStart(2, '0')
  const mon  = String(d.getMonth() + 1).padStart(2, '0')
  const yr   = d.getFullYear()
  return `${time} ${day}/${mon}/${yr}`
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
  const dir = item.condition === 'above' ? '涨超' : '跌超'
  const mag = Math.abs(item.threshold)
  return ` 24h${dir} ${mag}%，当前 ${(item.value > 0 ? '+' : '') + item.value.toFixed(2)}%`
}

function itemColor(item) {
  if (item.type === 'rsi') {
    if (item.condition === 'above') return 'feed-orange'
    return 'feed-sky'
  }
  if (item.type === 'price') {
    return item.condition === 'above' ? 'feed-red' : 'feed-green'
  }
  if (item.type === 'divergence') {
    return item.condition === 'bull' ? 'feed-green' : 'feed-orange'
  }
  return item.value > 0 ? 'feed-green' : 'feed-red'
}

export default function AlertFeed() {
  const feed      = useAlertStore(s => s.feed)
  const clearFeed = useAlertStore(s => s.clearFeed)
  const setFlash  = useMarketStore(s => s.setFlash)

  const [typeFilter,   setTypeFilter]   = useState('all')
  const [symbolFilter, setSymbolFilter] = useState('')

  const visible = useMemo(() => {
    const q = symbolFilter.trim().toUpperCase()
    return feed.filter(item => {
      if (typeFilter !== 'all' && item.type !== typeFilter) return false
      if (q && !item.symbol.toUpperCase().includes(q)) return false
      return true
    })
  }, [feed, typeFilter, symbolFilter])

  return (
    <div className="alert-feed">
      <div className="feed-head">
        <span className="feed-title">提醒记录</span>
        {feed.length > 0 && (
          <button className="feed-clear-btn" onClick={clearFeed}>清除</button>
        )}
      </div>

      {feed.length > 0 && (
        <div className="feed-filters">
          <div className="feed-type-btns">
            {TYPE_FILTERS.map(f => (
              <button key={f.key}
                className={`feed-type-btn ${typeFilter === f.key ? 'active' : ''}`}
                onClick={() => setTypeFilter(f.key)}>
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

      <div className="feed-list">
        {feed.length === 0
          ? <div className="feed-empty">暂无提醒</div>
          : visible.length === 0
            ? <div className="feed-empty">无匹配记录</div>
            : visible.map(item => (
              <div key={item.id} className={`feed-item ${itemColor(item)} ${item.special ? 'feed-special' : ''}`}>
                <span className="feed-time">{fmtTime(item.ts)}</span>
                <span className="feed-msg">
                  {item.special && <span className="feed-star">★</span>}
                  <span className="feed-symbol" onClick={() => setFlash(item.symbol)}>{item.symbol}</span>
                  {fmtDetail(item)}
                </span>
              </div>
            ))
        }
      </div>
    </div>
  )
}
