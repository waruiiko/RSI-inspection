import { lazy, Suspense, useMemo, useState } from 'react'
import useWatchPoolStore from '../store/watchPoolStore'
import useMarketStore from '../store/marketStore'
import useSettingsStore from '../store/settingsStore'
import useAlertStore from '../store/alertStore'
const ChartModal = lazy(() => import('./ChartModal'))

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

function getReviewHint(item, asset) {
  if (!asset) return null
  const ageH = (Date.now() - (item.firstSeenAt ?? item.lastSeenAt ?? Date.now())) / 36e5
  const move = Math.abs(asset.change24h ?? 0)
  const rsi4h = asset.rsi?.['4h']
  const rsi1d = asset.rsi?.['1d']
  const cooled = ageH >= 36 && move <= 6
  const normalized = (rsi4h != null && rsi4h >= 38 && rsi4h <= 58) || (rsi1d != null && rsi1d >= 38 && rsi1d <= 58)
  if (cooled && normalized) return { tone: 'green', label: '可复看', detail: '波动已收敛，RSI 回到可重新观察区间。' }
  if (ageH < 36) return { tone: 'muted', label: '冷却中', detail: '进入观察池时间还短，先不急着复看。' }
  if (!cooled) return { tone: 'orange', label: '仍波动', detail: '24H 波动仍较大，继续冷却。' }
  return { tone: 'blue', label: '待结构', detail: '波动已收敛，但 RSI/结构还没有明显回到复看区。' }
}

export default function WatchPoolPage() {
  const items = useWatchPoolStore(s => s.items)
  const setStatus = useWatchPoolStore(s => s.setStatus)
  const setNote = useWatchPoolStore(s => s.setNote)
  const remove = useWatchPoolStore(s => s.remove)
  const clear = useWatchPoolStore(s => s.clear)
  const cleanup = useWatchPoolStore(s => s.cleanup)
  const assets = useMarketStore(s => s.assets)
  const upsertAlert = useAlertStore(s => s.upsert)
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

  const convertToRule = (item) => {
    upsertAlert([item.symbol], {
      timeframes: ['1h', '4h'],
      requireAllTf: false,
      alertLevel: item.status === 'interesting' ? 2 : 1,
      special: item.status === 'interesting',
      rsiAbove: null,
      rsiBelow: 40,
      changeAbove: null,
      changeBelow: null,
      priceAbove: null,
      priceBelow: null,
      divBull: true,
      divBear: false,
      volumeSignal: true,
      strategies: ['volume_divergence', 'breakout'],
      strategy: null,
      minScore: 2,
    })
    setStatus(item.symbol, 'watch')
  }

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
          const hint = getReviewHint(item, asset)
          const ageDays = Math.max(0, Math.ceil(((item.lastSeenAt ?? item.firstSeenAt ?? Date.now()) + retentionDays * 864e5 - Date.now()) / 864e5))
          return (
            <div key={item.id} className={`watch-row watch-status-${item.status}`}>
              <div>
                <button className="symbol-link-btn" onClick={() => asset && setChartAsset(asset)}>{item.symbol}</button>
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
                {hint && (
                  <span className={`rule-chip ${hint.tone}`} title={hint.detail}>
                    {hint.label}
                  </span>
                )}
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
                <button className="zone-btn" onClick={() => convertToRule(item)}>转规则</button>
                <button className="zone-btn" onClick={() => asset && setChartAsset(asset)} disabled={!asset}>K线</button>
                <button className="rule-del-btn" onClick={() => remove(item.symbol)}>移除</button>
              </div>
            </div>
          )
        })}
      </div>

      {chartAsset && (
        <Suspense fallback={null}>
          <ChartModal asset={chartAsset} onClose={() => setChartAsset(null)} />
        </Suspense>
      )}
    </div>
  )
}
