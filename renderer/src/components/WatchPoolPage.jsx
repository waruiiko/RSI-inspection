import { useMemo, useState } from 'react'
import useWatchPoolStore from '../store/watchPoolStore'
import useMarketStore from '../store/marketStore'
import useSettingsStore from '../store/settingsStore'
import ChartModal from './ChartModal'

const STATUS_LABELS = {
  unmarked: '未标记',
  watch: '继续观察',
  interesting: '有兴趣',
}

function fmtTime(ts) {
  if (!ts) return '-'
  return new Date(ts).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
}

function fmtPct(v) {
  if (v == null || Number.isNaN(v)) return '-'
  return `${v >= 0 ? '+' : ''}${Number(v).toFixed(2)}%`
}

function fmtPrice(v) {
  if (v == null || Number.isNaN(v)) return '-'
  if (v >= 1000) return v.toLocaleString('en-US', { maximumFractionDigits: 2 })
  if (v >= 1) return Number(v).toFixed(4)
  return Number(v).toPrecision(4)
}

export default function WatchPoolPage() {
  const items = useWatchPoolStore(s => s.items)
  const setStatus = useWatchPoolStore(s => s.setStatus)
  const setNote = useWatchPoolStore(s => s.setNote)
  const remove = useWatchPoolStore(s => s.remove)
  const clear = useWatchPoolStore(s => s.clear)
  const cleanup = useWatchPoolStore(s => s.cleanup)
  const assets = useMarketStore(s => s.assets)
  const setFlash = useMarketStore(s => s.setFlash)
  const retentionDays = useSettingsStore(s => s.watchPoolRetentionDays)
  const [filter, setFilter] = useState('active')
  const [query, setQuery] = useState('')
  const [chartAsset, setChartAsset] = useState(null)

  const visible = useMemo(() => {
    const q = query.trim().toUpperCase()
    return items
      .filter(item => filter === 'all' || (filter === 'active' ? item.status !== 'ignore' : item.status === filter))
      .filter(item => !q || item.symbol.includes(q))
      .sort((a, b) => (b.lastSeenAt ?? 0) - (a.lastSeenAt ?? 0))
  }, [items, filter, query])

  const enriched = visible.map(item => ({
    ...item,
    asset: assets.find(a => a.symbol === item.symbol || a.apiSymbol === item.symbol),
  }))

  return (
    <div className="watch-pool-page">
      <div className="manage-header">
        <div>
          <span className="manage-title">观察池</span>
          <span className="panel-count" style={{ marginLeft: 10 }}>
            剧烈波动先冷却，未标记 {retentionDays} 天后自动剔除
          </span>
        </div>
        <div className="manage-header-right">
          <button className="zone-btn" onClick={() => cleanup(retentionDays)}>清理过期</button>
          <button className="rule-del-btn" onClick={clear} disabled={!items.length}>清空</button>
        </div>
      </div>

      <div className="watch-pool-tools">
        <div className="feed-type-btns">
          {[
            ['active', '全部'],
            ['unmarked', '未标记'],
            ['watch', '继续观察'],
            ['interesting', '有兴趣'],
          ].map(([key, label]) => (
            <button key={key} className={`feed-type-btn ${filter === key ? 'active' : ''}`} onClick={() => setFilter(key)}>
              {label}
            </button>
          ))}
        </div>
        <input
          type="search"
          className="search-input"
          placeholder="搜索品种..."
          value={query}
          onChange={e => setQuery(e.target.value)}
        />
        <span className="panel-count">{visible.length} / {items.length}</span>
      </div>

      <div className="watch-pool-table">
        <div className="watch-row watch-head">
          <span>品种</span>
          <span>进入原因</span>
          <span>当前</span>
          <span>RSI 4H / 1D</span>
          <span>状态</span>
          <span>操作</span>
        </div>
        {enriched.length === 0 ? (
          <div className="pair-empty">暂无观察池记录</div>
        ) : enriched.map(item => {
          const asset = item.asset
          const ageDays = Math.max(0, Math.ceil(((item.lastSeenAt ?? item.firstSeenAt ?? Date.now()) + retentionDays * 864e5 - Date.now()) / 864e5))
          return (
            <div key={item.id} className={`watch-row watch-status-${item.status}`}>
              <div>
                <b>{item.symbol}</b>
                <em>{fmtTime(item.lastSeenAt)}</em>
              </div>
              <div className="watch-reason">
                <span>{item.reason || item.reasons?.[0] || '-'}</span>
                {item.status === 'unmarked' && <em>{ageDays} 天后清理</em>}
              </div>
              <div>
                <span>{fmtPrice(asset?.price ?? item.snapshot?.price)}</span>
                <em className={(asset?.change24h ?? item.snapshot?.change24h ?? 0) >= 0 ? 'up' : 'down'}>
                  {fmtPct(asset?.change24h ?? item.snapshot?.change24h)}
                </em>
              </div>
              <div>
                <span>{asset?.rsi?.['4h']?.toFixed?.(1) ?? item.snapshot?.rsi?.['4h']?.toFixed?.(1) ?? '-'}</span>
                <em>{asset?.rsi?.['1d']?.toFixed?.(1) ?? item.snapshot?.rsi?.['1d']?.toFixed?.(1) ?? '-'}</em>
              </div>
              <div>
                <span className={`rule-chip ${item.status === 'interesting' ? 'orange' : item.status === 'watch' ? 'blue' : 'muted'}`}>
                  {STATUS_LABELS[item.status] ?? item.status}
                </span>
                <input
                  className="watch-note"
                  placeholder="备注..."
                  value={item.note ?? ''}
                  onChange={e => setNote(item.symbol, e.target.value)}
                />
              </div>
              <div className="watch-actions">
                <button className="zone-btn" onClick={() => setStatus(item.symbol, 'watch')}>继续观察</button>
                <button className="zone-btn" onClick={() => setStatus(item.symbol, 'interesting')}>有兴趣</button>
                <button className="zone-btn" onClick={() => { setFlash(item.symbol); if (asset) setChartAsset(asset) }}>K线</button>
                <button className="rule-del-btn" onClick={() => remove(item.symbol)}>移除</button>
              </div>
            </div>
          )
        })}
      </div>

      {chartAsset && <ChartModal asset={chartAsset} onClose={() => setChartAsset(null)} />}
    </div>
  )
}
