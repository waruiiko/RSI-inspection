import { useState, useRef, useEffect, useCallback, useMemo } from 'react'
import useMarketStore   from '../store/marketStore'
import { ALL_ZONES }   from '../store/marketStore'
import useSettingsStore from '../store/settingsStore'
import { isUSMarketOpen } from '../utils/marketHours'
import { getRsiZone }  from '../utils/rsi'
import useGroupsStore from '../store/groupsStore'

const FILTERS = [
  { value: 'all',    label: '全部' },
  { value: 'crypto', label: '加密' },
  { value: 'other',  label: '其他' },
]

const TIMEFRAMES = ['15m', '1h', '4h', '1d']

const ZONE_DEFS = [
  { key: 'overbought', label: '超买', color: '#ef4444' },
  { key: 'strong',     label: '强势', color: '#f97316' },
  { key: 'neutral',    label: '中性', color: '#9ca3af' },
  { key: 'weak',       label: '弱势', color: '#4ade80' },
  { key: 'oversold',   label: '超卖', color: '#22c55e' },
]

function ZoneFilter() {
  const rsiZones   = useMarketStore(s => s.rsiZones)
  const setRsiZones = useMarketStore(s => s.setRsiZones)
  const [open, setOpen] = useState(false)
  const ref = useRef(null)

  useEffect(() => {
    const handler = e => { if (ref.current && !ref.current.contains(e.target)) setOpen(false) }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [])

  const toggle = key => {
    const next = rsiZones.includes(key)
      ? rsiZones.filter(z => z !== key)
      : [...rsiZones, key]
    if (next.length > 0) setRsiZones(next)  // keep at least one
  }

  const allOn  = rsiZones.length === ALL_ZONES.length
  const btnLabel = allOn
    ? '全部区间'
    : ZONE_DEFS.filter(z => rsiZones.includes(z.key)).map(z => z.label).join(', ')

  return (
    <div className="zone-filter" ref={ref}>
      <button
        className={`zone-btn ${!allOn ? 'filtered' : ''}`}
        onClick={() => setOpen(o => !o)}
      >
        {btnLabel} <span className="zone-caret">▾</span>
      </button>
      {open && (
        <div className="zone-dropdown">
          {ZONE_DEFS.map(z => (
            <label key={z.key} className="zone-option">
              <input
                type="checkbox"
                checked={rsiZones.includes(z.key)}
                onChange={() => toggle(z.key)}
              />
              <span style={{ color: z.color }}>{z.label}</span>
            </label>
          ))}
          <div className="zone-actions">
            <button onClick={() => setRsiZones(ALL_ZONES)}>全选</button>
            <button onClick={() => setRsiZones([rsiZones[0] ?? 'overbought'])}>清除</button>
          </div>
        </div>
      )}
    </div>
  )
}

const ZONE_COLORS = {
  overbought: '#ef4444',
  strong:     '#f97316',
  neutral:    '#6b7280',
  weak:       '#4ade80',
  oversold:   '#22c55e',
}
const ZONE_LABELS = { overbought: '超买', strong: '强势', neutral: '中性', weak: '弱势', oversold: '超卖' }

function SentimentBar({ assets, timeframe }) {
  const counts = useMemo(() => {
    const valid = assets.filter(a => a.rsi[timeframe] != null)
    if (!valid.length) return null
    const tally = { overbought: 0, strong: 0, neutral: 0, weak: 0, oversold: 0 }
    for (const a of valid) { const z = getRsiZone(a.rsi[timeframe]); if (z) tally[z]++ }
    return { tally, total: valid.length }
  }, [assets, timeframe])

  if (!counts) return null
  const { tally, total } = counts

  return (
    <div className="sentiment-bar-wrap" title="市场情绪分布">
      <div className="sentiment-bar">
        {Object.entries(tally).map(([zone, n]) => n > 0 && (
          <div key={zone}
            style={{ flex: n, background: ZONE_COLORS[zone], minWidth: 2 }}
            title={`${ZONE_LABELS[zone]} ${n} (${((n/total)*100).toFixed(0)}%)`}
          />
        ))}
      </div>
      <div className="sentiment-labels">
        {Object.entries(tally).map(([zone, n]) => n > 0 && (
          <span key={zone} style={{ color: ZONE_COLORS[zone] }}>
            {ZONE_LABELS[zone]}&nbsp;{((n/total)*100).toFixed(0)}%
          </span>
        ))}
      </div>
    </div>
  )
}

function GroupFilter() {
  const groups      = useGroupsStore(s => s.groups)
  const groupFilter = useGroupsStore(s => s.groupFilter)
  const setFilter   = useGroupsStore(s => s.setGroupFilter)
  const names = Object.keys(groups)
  if (!names.length) return null
  return (
    <div className="btn-group">
      <button className={!groupFilter ? 'active' : ''} onClick={() => setFilter(null)}>全部分组</button>
      {names.map(n => (
        <button key={n} className={groupFilter === n ? 'active' : ''} onClick={() => setFilter(n)}>{n}</button>
      ))}
    </div>
  )
}

export default function Toolbar({ activeTab, setActiveTab }) {
  const filter       = useMarketStore(s => s.filter)
  const assets       = useMarketStore(s => s.assets)
  const timeframe    = useMarketStore(s => s.timeframe)
  const layout       = useMarketStore(s => s.layout)
  const updatedAt    = useMarketStore(s => s.updatedAt)
  const loading      = useMarketStore(s => s.loading)
  const error        = useMarketStore(s => s.error)
  const assetCount   = useMarketStore(s => s.assets.length)
  const setFilter    = useMarketStore(s => s.setFilter)
  const setTimeframe = useMarketStore(s => s.setTimeframe)
  const setLayout    = useMarketStore(s => s.setLayout)
  const fetchData    = useMarketStore(s => s.fetchData)
  const refreshInterval = useSettingsStore(s => s.refreshInterval)

  const [now, setNow] = useState(Date.now())
  const [usMarketOpen, setUsMarketOpen] = useState(() => isUSMarketOpen())
  useEffect(() => {
    const t = setInterval(() => {
      setNow(Date.now())
      setUsMarketOpen(isUSMarketOpen())
    }, 1000)
    return () => clearInterval(t)
  }, [])

  const timeStr = updatedAt
    ? new Date(updatedAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' })
    : null

  const countdownStr = (() => {
    if (!updatedAt || loading) return null
    const rem = Math.max(0, Math.floor((updatedAt + refreshInterval * 60 * 1000 - now) / 1000))
    const m = String(Math.floor(rem / 60)).padStart(2, '0')
    const s = String(rem % 60).padStart(2, '0')
    return `${m}:${s}`
  })()

  return (
    <div className="toolbar">
      {/* Row 1: title + tabs (always visible) */}
      <div className="toolbar-row toolbar-top">
        <h1 className="toolbar-title">市场 RSI 热力图</h1>
        <div className="tab-group">
          <button className={activeTab === 'market'   ? 'active' : ''} onClick={() => setActiveTab('market')}>市场</button>
          <button className={activeTab === 'manage'   ? 'active' : ''} onClick={() => setActiveTab('manage')}>管理品种</button>
          <button className={activeTab === 'alerts'   ? 'active' : ''} onClick={() => setActiveTab('alerts')}>提醒</button>
          <button className={activeTab === 'settings' ? 'active' : ''} onClick={() => setActiveTab('settings')}>设置</button>
        </div>
      </div>

      {/* Row 2: market controls (wraps when narrow) */}
      {activeTab === 'market' && (
        <div className="toolbar-row toolbar-controls">
          <ZoneFilter />
          <GroupFilter />

          <div className="btn-group">
            {FILTERS.map(f => (
              <button key={f.value} className={filter === f.value ? 'active' : ''} onClick={() => setFilter(f.value)}>
                {f.label}
              </button>
            ))}
          </div>

          <div className="btn-group">
            {TIMEFRAMES.map(tf => (
              <button key={tf} className={timeframe === tf ? 'active' : ''} onClick={() => setTimeframe(tf)}>
                {tf}
              </button>
            ))}
          </div>

          <div className="btn-group">
            <button className={layout === 'sorted' ? 'active' : ''} onClick={() => setLayout('sorted')} title="按RSI排列">⋮⋮</button>
            <button className={layout === 'random' ? 'active' : ''} onClick={() => setLayout('random')} title="随机排列">⁂</button>
          </div>

          <button className="refresh-btn" onClick={fetchData} disabled={loading} title="刷新">
            {loading ? '…' : '↻'}
          </button>

          <span className={`market-status ${usMarketOpen ? 'open' : 'closed'}`}
            title={usMarketOpen ? '美股交易中' : '美股休市'}>
            <span className="market-status-dot" />
            美股
          </span>

          <SentimentBar assets={assets} timeframe={timeframe} />

          {error && !loading && (
            <span className="conn-error" title={error}>⚠ 数据获取失败</span>
          )}
          {loading && assetCount > 0 && <span className="updated-at">加载中 {assetCount}…</span>}
          {!loading && timeStr && (
            <span className="updated-at">更新于 {timeStr}{countdownStr && `　下次 ${countdownStr}`}</span>
          )}
        </div>
      )}
    </div>
  )
}
