import { lazy, Suspense, useMemo, useState } from 'react'
import useMarketStore from '../store/marketStore'
import useAlertStore from '../store/alertStore'
import useWatchPoolStore from '../store/watchPoolStore'
import { formatPrice } from '../utils/rsi'
import { formatTurnover, getQuoteVolume } from '../utils/liquidity'

const ChartModal = lazy(() => import('./ChartModal'))

const FILTERS = [
  { key: 'all', label: '全部' },
  { key: 'deep', label: '深度低位' },
  { key: 'rebound', label: '回升确认' },
  { key: 'divergence', label: '底背离' },
  { key: 'cooldown', label: '观察池复看' },
]

function fmtPct(v) {
  if (v == null || Number.isNaN(v)) return '-'
  return `${v >= 0 ? '+' : ''}${Number(v).toFixed(2)}%`
}

function fmtRsi(v) {
  return v == null ? '-' : Number(v).toFixed(1)
}

function opportunityMeta(asset, watchItem) {
  const r4 = asset.rsi?.['4h']
  const r1 = asset.rsi?.['1d']
  const change = Math.abs(asset.change24h ?? 0)
  const score4 = asset.signalScore?.['4h'] ?? 0
  const score1 = asset.signalScore?.['1d'] ?? 0
  const div4 = asset.divergence?.['4h'] === 'bullish'
  const div1 = asset.divergence?.['1d'] === 'bullish'
  const vol4 = asset.volumeSignal?.['4h']?.direction === 'bullish'
  const vol1 = asset.volumeSignal?.['1d']?.direction === 'bullish'
  const calm = change <= 8
  const deep = calm && ((r4 != null && r4 <= 32) || (r1 != null && r1 <= 35))
  const low = calm && ((r4 != null && r4 <= 38) || (r1 != null && r1 <= 40))
  const rebound = calm && (
    ((r4 != null && r4 >= 34 && r4 <= 48) || (r1 != null && r1 >= 36 && r1 <= 50)) &&
    (score4 >= 1 || score1 >= 1 || vol4 || vol1 || div4 || div1)
  )
  const divergence = div4 || div1
  const cooling = !!watchItem && ['watch', 'interesting', 'unmarked'].includes(watchItem.status) && calm
  const priority =
    (deep ? 35 : low ? 18 : 0) +
    (rebound ? 28 : 0) +
    (divergence ? 24 : 0) +
    (cooling ? 12 : 0) +
    Math.min(12, Math.log10((getQuoteVolume(asset) || 0) / 1_000_000 + 1) * 5)

  const tags = []
  if (deep) tags.push('深度低位')
  else if (low) tags.push('慢速低位')
  if (rebound) tags.push('回升确认')
  if (divergence) tags.push('底背离')
  if (cooling) tags.push('观察池复看')

  const reason = tags.length
    ? `${tags.join(' / ')}；4h RSI ${fmtRsi(r4)}，1d RSI ${fmtRsi(r1)}，24H ${fmtPct(asset.change24h)}`
    : ''

  return { deep, low, rebound, divergence, cooling, priority, tags, reason }
}

export default function OpportunityPage() {
  const assets = useMarketStore(s => s.assets)
  const feed = useAlertStore(s => s.feed)
  const addWatch = useWatchPoolStore(s => s.addOrUpdate)
  const watchItems = useWatchPoolStore(s => s.items)
  const [filter, setFilter] = useState('all')
  const [query, setQuery] = useState('')
  const [chartAsset, setChartAsset] = useState(null)

  const rows = useMemo(() => {
    const watchMap = new Map(watchItems.map(i => [String(i.symbol).toUpperCase(), i]))
    const q = query.trim().toUpperCase()
    return assets
      .filter(a => a.type === 'crypto' || a.type === 'tradfi')
      .map(asset => ({
        asset,
        watchItem: watchMap.get(String(asset.symbol).toUpperCase()),
        meta: opportunityMeta(asset, watchMap.get(String(asset.symbol).toUpperCase())),
      }))
      .filter(row => row.meta.priority >= 18)
      .filter(row => {
        if (filter === 'deep') return row.meta.deep || row.meta.low
        if (filter === 'rebound') return row.meta.rebound
        if (filter === 'divergence') return row.meta.divergence
        if (filter === 'cooldown') return row.meta.cooling
        return true
      })
      .filter(row => !q || row.asset.symbol.toUpperCase().includes(q))
      .sort((a, b) => b.meta.priority - a.meta.priority)
      .slice(0, 80)
  }, [assets, watchItems, filter, query])

  const recentSymbols = useMemo(() => {
    const cutoff = Date.now() - 24 * 60 * 60 * 1000
    return new Set(feed.filter(i => i.ts >= cutoff).map(i => String(i.symbol).toUpperCase()))
  }, [feed])

  const addToWatch = (row) => {
    addWatch({
      symbol: row.asset.symbol,
      source: 'opportunity',
      reason: row.meta.reason,
      ts: Date.now(),
      snapshot: {
        price: row.asset.price,
        change24h: row.asset.change24h,
        rsi: row.asset.rsi,
        signalScore: row.asset.signalScore,
      },
    })
  }

  return (
    <div className="page opportunity-page">
      <div className="opp-hero">
        <div className="opp-title">
          <h2>中线机会</h2>
          <p>聚焦 4h / 1d 慢速低位、回升确认、底背离和观察池冷却后的复看机会。</p>
        </div>
        <div className="opp-summary compact">
          <b>{rows.length}</b>
          <span>个候选</span>
        </div>
        <div className="opp-controls">
          <div className="feed-type-btns">
            {FILTERS.map(f => (
              <button key={f.key} className={`feed-type-btn ${filter === f.key ? 'active' : ''}`} onClick={() => setFilter(f.key)}>
                {f.label}
              </button>
            ))}
          </div>
          <input
            type="search"
            className="search-input opp-search"
            placeholder="搜索品种..."
            value={query}
            onChange={e => setQuery(e.target.value)}
          />
        </div>
      </div>

      <div className="opp-table-wrap">
        <table className="opp-table">
          <thead>
            <tr>
              <th>品种</th>
              <th>价格</th>
              <th>24H</th>
              <th>RSI 4H</th>
              <th>RSI 1D</th>
              <th>量能</th>
              <th>机会</th>
              <th>最近提醒</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr><td colSpan="9" className="opp-empty">暂无符合条件的中线候选</td></tr>
            ) : rows.map(row => (
              <tr key={row.asset.symbol} onDoubleClick={() => setChartAsset(row.asset)}>
                <td>
                  <button className="symbol-link-btn" onClick={() => setChartAsset(row.asset)}>
                    {row.asset.symbol}
                  </button>
                </td>
                <td>{formatPrice(row.asset.price)}</td>
                <td className={(row.asset.change24h ?? 0) >= 0 ? 'opp-up' : 'opp-down'}>{fmtPct(row.asset.change24h)}</td>
                <td>{fmtRsi(row.asset.rsi?.['4h'])}</td>
                <td>{fmtRsi(row.asset.rsi?.['1d'])}</td>
                <td>{formatTurnover(getQuoteVolume(row.asset))}</td>
                <td>
                  <div className="opp-tags">
                    {row.meta.tags.map(tag => <span key={tag}>{tag}</span>)}
                  </div>
                  <small>{row.meta.reason}</small>
                </td>
                <td>{recentSymbols.has(row.asset.symbol.toUpperCase()) ? '24h内有记录' : '-'}</td>
                <td>
                  <div className="opp-actions">
                    <button className="zone-btn" onClick={() => setChartAsset(row.asset)}>K线</button>
                    <button className="zone-btn" onClick={() => addToWatch(row)}>加入观察</button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {chartAsset && (
        <Suspense fallback={null}>
          <ChartModal asset={chartAsset} onClose={() => setChartAsset(null)} />
        </Suspense>
      )}
    </div>
  )
}
