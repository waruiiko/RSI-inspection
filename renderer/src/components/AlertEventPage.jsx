import { lazy, Suspense, useMemo, useState } from 'react'
import useAlertStore from '../store/alertStore'
import useMarketStore from '../store/marketStore'
import useWatchPoolStore from '../store/watchPoolStore'
import { formatPrice } from '../utils/rsi'

const ChartModal = lazy(() => import('./ChartModal'))

const AI_EVENT_TYPES = new Set(['signal_hunter_ai', 'ai', 'market_report', 'watch_pool'])
const SH_AI_PINNED_KEY = 'rsi:signalHunter:pinned'

const STATUS_FILTERS = [
  { key: 'pending', label: '待处理' },
  { key: 'done', label: '已处理' },
  { key: 'ignored', label: '忽略' },
  { key: 'all', label: '全部' },
]

const SOURCE_FILTERS = [
  { key: 'all', label: '全部来源' },
  { key: 'pinned', label: '关注动态' },
  { key: 'signal_hunter_ai', label: 'Signal Hunter AI' },
  { key: 'ai', label: 'AI复盘' },
  { key: 'risk', label: '风险变化' },
  { key: 'system', label: '系统状态' },
]

const QUICK_FILTERS = [
  { key: 'all', label: '全部事件' },
  { key: 'fresh', label: '新鲜' },
  { key: 'stale', label: '接近过期' },
  { key: 'expired', label: '已过期' },
  { key: 'risk', label: '风险优先' },
  { key: 'focus', label: '重点机会' },
]

const GROUP_DEFS = [
  { key: 'risk', label: '风险优先', hint: '先排除风险、失效、反向变化' },
  { key: 'focus', label: '重点机会', hint: '值得复核的 SH / AI 重点事件' },
  { key: 'pinned', label: '关注动态', hint: '来自关注标的或钉住信号' },
  { key: 'watch', label: '普通观察', hint: '暂时保持观察，等待下一轮确认' },
  { key: 'archive', label: '已处理归档', hint: '已处理或忽略的事件' },
]

function fmtTime(ts) {
  if (!ts) return '-'
  return new Date(ts).toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })
}

function eventStatus(item) {
  return item.eventStatus ?? 'pending'
}

function eventSource(item) {
  if (item.type === 'signal_hunter_ai') return 'signal_hunter_ai'
  if (item.type === 'market_report') return 'system'
  if (item.condition === 'risk' || item.type === 'risk') return 'risk'
  return 'ai'
}

function eventPinnedKey(item) {
  return [item?.symbol ?? '', item?.side ?? '', item?.timeframe ?? ''].join('|')
}

function loadPinnedKeys() {
  try {
    return new Set(JSON.parse(localStorage.getItem(SH_AI_PINNED_KEY) || '[]'))
  } catch {
    return new Set()
  }
}

function sourceLabel(source) {
  return SOURCE_FILTERS.find(item => item.key === source)?.label ?? source
}

function eventTone(item) {
  if (eventStatus(item) === 'ignored') return 'muted'
  if (item.condition === 'risk' || item.status === 'risk') return 'risk'
  if (item.condition === 'focus' || item.status === 'triggered') return 'focus'
  if (item.type === 'market_report') return 'system'
  return 'watch'
}

function eventFreshness(item) {
  const ts = item.ts ?? item.createdAt ?? 0
  if (!ts) return { key: 'unknown', label: '未知时效', hours: null }
  const hours = (Date.now() - ts) / 36e5
  if (hours >= 24) return { key: 'expired', label: '已过期', hours }
  if (hours >= 8) return { key: 'stale', label: '接近过期', hours }
  return { key: 'fresh', label: '新鲜', hours }
}

function freshnessText(item) {
  const fresh = eventFreshness(item)
  if (fresh.hours == null) return fresh.label
  if (fresh.hours < 1) return '1小时内'
  return `${Math.floor(fresh.hours)}小时前 · ${fresh.label}`
}

function eventGroup(item, pinnedKeys) {
  const status = eventStatus(item)
  if (status === 'done' || status === 'ignored') return 'archive'
  const tone = eventTone(item)
  if (tone === 'risk' || eventFreshness(item).key === 'expired') return 'risk'
  if (tone === 'focus') return 'focus'
  if (pinnedKeys.has(eventPinnedKey(item))) return 'pinned'
  return 'watch'
}

function eventTitle(item) {
  if (item.type === 'signal_hunter_ai') {
    const status = item.status ? ` · ${item.status}` : ''
    return `${item.symbol} · SH AI${status}`
  }
  if (item.type === 'market_report') return item.signal ?? '系统状态'
  return `${item.symbol ?? 'AI'} · ${item.signal ?? item.type ?? '事件'}`
}

function eventReason(item) {
  return item.reason || item.risk || item.nextCheck || item.signal || '等待复核'
}

function eventNextStep(item) {
  if (eventStatus(item) === 'done') return '已处理，等待下一轮变化'
  if (eventStatus(item) === 'ignored') return '已忽略'
  if (item.condition === 'risk' || item.status === 'risk') return item.risk ? `先排除风险：${item.risk}` : '先排除风险'
  if (item.condition === 'focus' || item.status === 'triggered') return item.nextCheck || '打开 SH / K线复核确认'
  return item.nextCheck || '保持观察'
}

function isLegacyRuleEvent(item) {
  return !AI_EVENT_TYPES.has(item.type)
}

function visibleBySource(item, sourceFilter, pinnedKeys) {
  if (sourceFilter === 'all') return true
  if (sourceFilter === 'pinned') return pinnedKeys.has(eventPinnedKey(item))
  return eventSource(item) === sourceFilter
}

function visibleByQuickFilter(item, quickFilter, pinnedKeys) {
  if (quickFilter === 'all') return true
  if (quickFilter === 'fresh' || quickFilter === 'stale' || quickFilter === 'expired') {
    return eventFreshness(item).key === quickFilter
  }
  if (quickFilter === 'risk') return eventGroup(item, pinnedKeys) === 'risk'
  if (quickFilter === 'focus') return eventGroup(item, pinnedKeys) === 'focus'
  return true
}

function findAsset(assets, symbol) {
  const key = String(symbol ?? '').toUpperCase()
  return assets.find(asset => String(asset.symbol).toUpperCase() === key || String(asset.apiSymbol).toUpperCase() === key) ?? null
}

async function copyText(text) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text)
    return
  }
  const ta = document.createElement('textarea')
  ta.value = text
  ta.style.position = 'fixed'
  ta.style.opacity = '0'
  document.body.appendChild(ta)
  ta.select()
  document.execCommand('copy')
  document.body.removeChild(ta)
}

function eventSummaryText(item) {
  return [
    `${eventTitle(item)}`,
    `原因：${eventReason(item)}`,
    `下一步：${eventNextStep(item)}`,
    `来源：${sourceLabel(eventSource(item))}`,
    `时效：${freshnessText(item)}`,
    item.score != null ? `评分：${item.score}` : '',
    item.value != null ? `价格/数值：${formatPrice(item.value)}` : '',
  ].filter(Boolean).join('\n')
}

export default function AlertEventPage({ onNavigate }) {
  const feed = useAlertStore(s => s.feed)
  const configs = useAlertStore(s => s.configs)
  const updateFeed = useAlertStore(s => s.updateFeed)
  const clearFeed = useAlertStore(s => s.clearFeed)
  const assets = useMarketStore(s => s.assets)
  const setFlash = useMarketStore(s => s.setFlash)
  const addWatchPool = useWatchPoolStore(s => s.addOrUpdate)

  const [statusFilter, setStatusFilter] = useState('pending')
  const [sourceFilter, setSourceFilter] = useState('all')
  const [quickFilter, setQuickFilter] = useState('all')
  const [collapsedGroups, setCollapsedGroups] = useState(() => new Set(['archive']))
  const [query, setQuery] = useState('')
  const [selectedItem, setSelectedItem] = useState(null)
  const [chartAsset, setChartAsset] = useState(null)
  const [message, setMessage] = useState('')
  const [pinnedKeys] = useState(() => loadPinnedKeys())

  const aiEvents = useMemo(() => feed.filter(item => AI_EVENT_TYPES.has(item.type)), [feed])
  const legacyEvents = useMemo(() => feed.filter(isLegacyRuleEvent), [feed])
  const visibleEvents = useMemo(() => {
    const q = query.trim().toUpperCase()
    return aiEvents.filter(item => {
      if (statusFilter !== 'all' && eventStatus(item) !== statusFilter) return false
      if (!visibleBySource(item, sourceFilter, pinnedKeys)) return false
      if (!visibleByQuickFilter(item, quickFilter, pinnedKeys)) return false
      if (q && !String(item.symbol ?? item.signal ?? '').toUpperCase().includes(q)) return false
      return true
    })
  }, [aiEvents, statusFilter, sourceFilter, quickFilter, query, pinnedKeys])

  const stats = useMemo(() => ({
    pending: aiEvents.filter(item => eventStatus(item) === 'pending').length,
    risk: aiEvents.filter(item => eventTone(item) === 'risk').length,
    focus: aiEvents.filter(item => eventTone(item) === 'focus').length,
    pinned: aiEvents.filter(item => pinnedKeys.has(eventPinnedKey(item))).length,
    legacy: legacyEvents.length,
    expired: aiEvents.filter(item => eventFreshness(item).key === 'expired').length,
    fresh: aiEvents.filter(item => eventFreshness(item).key === 'fresh').length,
  }), [aiEvents, legacyEvents.length, pinnedKeys])

  const groupedEvents = useMemo(() => {
    const groups = GROUP_DEFS.map(group => ({ ...group, items: [] }))
    const byKey = new Map(groups.map(group => [group.key, group]))
    for (const item of visibleEvents) {
      const key = eventGroup(item, pinnedKeys)
      ;(byKey.get(key) ?? byKey.get('watch')).items.push(item)
    }
    return groups.filter(group => group.items.length)
  }, [visibleEvents, pinnedKeys])

  const toggleGroup = (key) => {
    setCollapsedGroups(prev => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  const updateEventStatus = (item, status) => {
    updateFeed(items => items.map(row => row.id === item.id
      ? { ...row, eventStatus: status, eventStatusAt: Date.now() }
      : row))
    setSelectedItem(current => current?.id === item.id
      ? { ...current, eventStatus: status, eventStatusAt: Date.now() }
      : current)
  }

  const markVisible = (status) => {
    const ids = new Set(visibleEvents.map(item => item.id))
    updateFeed(items => items.map(row => ids.has(row.id)
      ? { ...row, eventStatus: status, eventStatusAt: Date.now() }
      : row))
  }

  const ignoreLowScore = () => {
    updateFeed(items => items.map(item => visibleEvents.some(row => row.id === item.id) && Number(item.score ?? 99) < 70
      ? { ...item, eventStatus: 'ignored', eventStatusAt: Date.now() }
      : item))
    setMessage('已忽略当前视图中评分低于 70 的事件。')
  }

  const ignoreExpired = () => {
    updateFeed(items => items.map(item => eventFreshness(item).key === 'expired'
      ? { ...item, eventStatus: 'ignored', eventStatusAt: Date.now() }
      : item))
    setMessage('已忽略全部过期事件。')
  }

  const keepLatestPerSymbol = () => {
    const latestIds = new Set()
    const sorted = [...visibleEvents].sort((a, b) => (b.ts ?? 0) - (a.ts ?? 0))
    const seen = new Set()
    for (const item of sorted) {
      const key = String(item.symbol ?? item.signal ?? item.id).toUpperCase()
      if (seen.has(key)) continue
      seen.add(key)
      latestIds.add(item.id)
    }
    updateFeed(items => items.map(item => visibleEvents.some(row => row.id === item.id) && !latestIds.has(item.id)
      ? { ...item, eventStatus: 'ignored', eventStatusAt: Date.now() }
      : item))
    setMessage('已保留当前视图中每个标的最新一条，其余已忽略。')
  }

  const openChart = (item) => {
    const asset = findAsset(assets, item.symbol)
    if (asset) setChartAsset(asset)
  }

  const openMarket = (item) => {
    if (!item.symbol) return
    setFlash(item.symbol)
    onNavigate?.('market')
  }

  const openSignalHunter = (item) => {
    if (item.symbol) setFlash(item.symbol)
    onNavigate?.('signal-hunter')
  }

  const addToWatchPool = (item) => {
    if (!item.symbol) return
    const asset = findAsset(assets, item.symbol)
    addWatchPool({
      symbol: item.symbol,
      source: 'ai-event',
      reason: eventReason(item),
      ts: Date.now(),
      snapshot: asset ? {
        price: asset.price,
        change24h: asset.change24h,
        rsi: asset.rsi,
        signalHunter: asset.signalHunter,
      } : item,
    })
    setMessage(`${item.symbol} 已加入观察池。`)
  }

  const copyEvent = async (item) => {
    await copyText(eventSummaryText(item))
    setMessage('已复制提醒摘要。')
  }

  return (
    <div className="alert-page ai-event-page">
      <div className="ai-event-head">
        <div>
          <h2>AI事件中心</h2>
          <p>这里集中处理 AI / SH 事件；规则配置请到“提醒设置”。</p>
        </div>
        <div className="ai-event-summary">
          <button className={statusFilter === 'pending' ? 'active' : ''} onClick={() => setStatusFilter('pending')}><b>{stats.pending}</b><span>待处理</span></button>
          <button className={quickFilter === 'focus' ? 'active' : ''} onClick={() => setQuickFilter('focus')}><b>{stats.focus}</b><span>重点</span></button>
          <button className={quickFilter === 'risk' ? 'active' : ''} onClick={() => setQuickFilter('risk')}><b>{stats.risk}</b><span>风险</span></button>
          <button className={quickFilter === 'expired' ? 'active' : ''} onClick={() => setQuickFilter('expired')}><b>{stats.expired}</b><span>过期</span></button>
          <button className={sourceFilter === 'pinned' ? 'active' : ''} onClick={() => setSourceFilter('pinned')}><b>{stats.pinned}</b><span>关注动态</span></button>
        </div>
      </div>

      <div className="ai-event-toolbar">
        <div className="feed-type-btns">
          {QUICK_FILTERS.map(item => (
            <button key={item.key} className={`feed-type-btn ${quickFilter === item.key ? 'active' : ''}`} onClick={() => setQuickFilter(item.key)}>
              {item.label}
            </button>
          ))}
        </div>
        <div className="feed-type-btns">
          {STATUS_FILTERS.map(item => (
            <button key={item.key} className={`feed-type-btn ${statusFilter === item.key ? 'active' : ''}`} onClick={() => setStatusFilter(item.key)}>
              {item.label}
            </button>
          ))}
        </div>
        <div className="feed-type-btns">
          {SOURCE_FILTERS.map(item => (
            <button key={item.key} className={`feed-type-btn ${sourceFilter === item.key ? 'active' : ''}`} onClick={() => setSourceFilter(item.key)}>
              {item.label}
            </button>
          ))}
        </div>
        <input className="search-input ai-event-search" type="search" placeholder="搜索标的/事件..." value={query} onChange={e => setQuery(e.target.value)} />
        <button className="feed-type-btn" disabled={!visibleEvents.length} onClick={() => markVisible('done')}>当前视图已处理</button>
        <button className="feed-type-btn" disabled={!visibleEvents.length} onClick={() => markVisible('ignored')}>当前视图忽略</button>
        <button className="feed-type-btn" disabled={!visibleEvents.some(item => Number(item.score ?? 99) < 70)} onClick={ignoreLowScore}>低分忽略</button>
        <button className="feed-type-btn" disabled={!aiEvents.some(item => eventFreshness(item).key === 'expired')} onClick={ignoreExpired}>忽略过期</button>
        <button className="feed-type-btn" disabled={visibleEvents.length < 2} onClick={keepLatestPerSymbol}>每标的留最新</button>
        <button className="feed-type-btn" disabled={!feed.length} onClick={clearFeed}>清空记录</button>
        {message && <span className="ai-event-message">{message}</span>}
      </div>

      <div className="ai-event-list">
        {!visibleEvents.length ? (
          <div className="ai-event-empty">
            <b>{aiEvents.length ? '当前筛选下没有事件' : '暂无 AI 事件'}</b>
            <span>{aiEvents.length ? '可以放宽筛选，或去 Signal Hunter 重新跑一轮 AI 识别。' : '等待 SH 页面下一轮 AI 识别后，这里会显示重点、风险、变化和系统状态。'}</span>
            <div>
              <button className="zone-btn" onClick={() => { setQuickFilter('all'); setStatusFilter('all'); setSourceFilter('all'); setQuery('') }}>重置筛选</button>
              <button className="zone-btn" onClick={() => onNavigate?.('signal-hunter')}>去 Signal Hunter</button>
              <button className="zone-btn" onClick={() => onNavigate?.('alert-settings')}>去提醒设置</button>
            </div>
          </div>
        ) : groupedEvents.map(group => {
          const collapsed = collapsedGroups.has(group.key)
          return (
            <section key={group.key} className={`ai-event-group ai-event-group-${group.key}`}>
              <button type="button" className="ai-event-group-head" onClick={() => toggleGroup(group.key)}>
                <span>{collapsed ? '▶' : '▼'}</span>
                <strong>{group.label}</strong>
                <em>{group.hint}</em>
                <b>{group.items.length}</b>
              </button>
              {!collapsed && group.items.map(item => (
          <button type="button" key={item.id} className={`ai-event-card ${eventTone(item)} ${eventStatus(item)}`} onClick={() => setSelectedItem(item)}>
            <div className="ai-event-card-main">
              <div className="ai-event-title-row">
                <strong>{eventTitle(item)}</strong>
                {pinnedKeys.has(eventPinnedKey(item)) && <span className="ai-event-pinned">关注</span>}
                <span>{sourceLabel(eventSource(item))}</span>
                <span>{fmtTime(item.ts)}</span>
              </div>
              <p>{eventReason(item)}</p>
            </div>
            <div className="ai-event-card-insight">
              <div>
                <b>下一步</b>
                <span>{eventNextStep(item)}</span>
              </div>
              <div>
                <b>风险/状态</b>
                <span>{item.risk || item.status || item.condition || '等待复核'}</span>
              </div>
              <div>
                <b>来源</b>
                <span>{sourceLabel(eventSource(item))} · {freshnessText(item)}</span>
              </div>
            </div>
            <div className="ai-event-card-side">
              {item.score != null && <span>评分 {item.score}</span>}
              {item.timeframe && <span>{item.timeframe}</span>}
              {item.value != null && <span>{formatPrice(item.value)}</span>}
              <span className={`ai-event-freshness ${eventFreshness(item).key}`}>{eventFreshness(item).label}</span>
              <span className={`ai-event-status ${eventStatus(item)}`}>{STATUS_FILTERS.find(s => s.key === eventStatus(item))?.label ?? '待处理'}</span>
              <div className="ai-event-card-actions">
                <button onClick={e => { e.stopPropagation(); openMarket(item) }}>首页</button>
                <button onClick={e => { e.stopPropagation(); openSignalHunter(item) }}>SH</button>
                <button disabled={!item.symbol} onClick={e => { e.stopPropagation(); addToWatchPool(item) }}>观察池</button>
                <button onClick={e => { e.stopPropagation(); copyEvent(item) }}>复制</button>
              </div>
            </div>
          </button>
              ))}
            </section>
          )
        })}
      </div>

      {selectedItem && (
        <div className="review-overlay" onClick={() => setSelectedItem(null)}>
          <div className="review-panel ai-event-detail" onClick={e => e.stopPropagation()}>
            <div className="review-head">
              <strong>{eventTitle(selectedItem)}</strong>
              <button className="chart-modal-close" onClick={() => setSelectedItem(null)}>×</button>
            </div>
            <div className="ai-event-detail-grid">
              <span>提醒原因</span><b>{eventReason(selectedItem)}</b>
              <span>上一轮/当前</span><b>{selectedItem.status || selectedItem.condition || '-'}</b>
              <span>下一步</span><b>{eventNextStep(selectedItem)}</b>
              <span>风险</span><b>{selectedItem.risk || '-'}</b>
              <span>时间</span><b>{fmtTime(selectedItem.ts)}</b>
              <span>价格</span><b>{selectedItem.value != null ? formatPrice(selectedItem.value) : '-'}</b>
            </div>
            <div className="review-actions">
              <button className="zone-btn" onClick={() => openMarket(selectedItem)}>跳转首页定位</button>
              <button className="zone-btn" onClick={() => openSignalHunter(selectedItem)}>去 Signal Hunter</button>
              <button className="zone-btn" disabled={!selectedItem.symbol} onClick={() => addToWatchPool(selectedItem)}>加入观察池</button>
              <button className="zone-btn" onClick={() => copyEvent(selectedItem)}>复制摘要</button>
              <button className="zone-btn" disabled={!findAsset(assets, selectedItem.symbol)} onClick={() => openChart(selectedItem)}>打开K线</button>
              <button className="zone-btn" onClick={() => updateEventStatus(selectedItem, 'done')}>已处理</button>
              <button className="zone-btn" onClick={() => updateEventStatus(selectedItem, 'ignored')}>忽略</button>
              <button className="zone-btn" onClick={() => updateEventStatus(selectedItem, 'pending')}>重新待处理</button>
            </div>
          </div>
        </div>
      )}

      {chartAsset && (
        <Suspense fallback={null}>
          <ChartModal asset={chartAsset} alertItem={selectedItem} onClose={() => setChartAsset(null)} />
        </Suspense>
      )}
    </div>
  )
}
