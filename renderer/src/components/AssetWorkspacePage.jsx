import { lazy, Suspense, useMemo, useState } from 'react'
import useMarketStore from '../store/marketStore'
import useAlertStore from '../store/alertStore'
import useWatchPoolStore from '../store/watchPoolStore'
import useSignalTrailStore from '../store/signalTrailStore'
import useSignalReviewStore from '../store/signalReviewStore'
import { formatPrice } from '../utils/rsi'
import { assetKey, sameUnderlying, underlyingSymbol, venueLabel } from '../utils/assetKey'
import { buildCrossMarketIndex, crossMarketContext, tradfiSubtype, universeTier } from '../utils/crossMarket'
import { COMPANY_EVENTS_CACHE_KEY, eventsForAsset } from '../utils/companyEvents'

const ChartModal = lazy(() => import('./ChartModal'))

function workspaceKey(asset) {
  return assetKey(asset)
}

function fmtPct(value) {
  return Number.isFinite(value) ? `${value >= 0 ? '+' : ''}${value.toFixed(2)}%` : '-'
}

function fmtTime(value) {
  return value ? new Date(value).toLocaleString('zh-CN') : '-'
}

export default function AssetWorkspacePage() {
  const assets = useMarketStore(s => s.assets)
  const feed = useAlertStore(s => s.feed)
  const rules = useAlertStore(s => s.configs)
  const watchItems = useWatchPoolStore(s => s.items)
  const setWatchNote = useWatchPoolStore(s => s.setNote)
  const addWatch = useWatchPoolStore(s => s.addOrUpdate)
  const trail = useSignalTrailStore(s => s.items)
  const reviews = useSignalReviewStore(s => s.items)
  const trades = useSignalReviewStore(s => s.tradeLogs)
  const [query, setQuery] = useState('')
  const [selectedKey, setSelectedKey] = useState('')
  const [chartOpen, setChartOpen] = useState(false)
  const crossMarketIndex = useMemo(() => buildCrossMarketIndex(assets), [assets])

  const matches = useMemo(() => {
    const q = query.trim().toUpperCase()
    return assets
      .filter(asset => !q || `${asset.symbol} ${asset.apiSymbol ?? ''} ${asset.name ?? ''}`.toUpperCase().includes(q))
      .sort((a, b) => String(a.symbol).localeCompare(String(b.symbol)))
  }, [assets, query])
  const selectedByKey = assets.find(asset => workspaceKey(asset) === selectedKey)
  const selected = selectedByKey && matches.some(asset => workspaceKey(asset) === selectedKey) ? selectedByKey : matches[0] ?? null
  const effectiveSelectedKey = selected ? workspaceKey(selected) : ''
  const symbol = String(selected?.symbol ?? '').toUpperCase()
  const siblingInstruments = selected ? assets.filter(asset => sameUnderlying(asset, selected)) : []
  const crossMarket = selected ? crossMarketContext(selected, assets, new Date(), crossMarketIndex) : null
  const companyEvents = useMemo(() => { try { return JSON.parse(localStorage.getItem(COMPANY_EVENTS_CACHE_KEY) || '[]') } catch { return [] } }, [selected])
  const selectedEvents = selected ? eventsForAsset(companyEvents, selected).slice(0, 3) : []
  const relatedFeed = feed.filter(item => String(item.symbol ?? '').toUpperCase() === symbol).slice(0, 8)
  const relatedReviews = reviews.filter(item => String(item.symbol ?? '').toUpperCase() === symbol).slice(0, 6)
  const relatedTrades = trades.filter(item => String(item.symbol ?? '').toUpperCase() === symbol).slice(0, 6)
  const relatedTrail = trail.find(item => String(item.symbol ?? '').toUpperCase() === symbol)
  const watch = watchItems.find(item => String(item.symbol ?? '').toUpperCase() === symbol)
  const relatedRules = rules.filter(item => String(item.symbol ?? '').toUpperCase() === symbol)
  const signal = selected?.signalHunter

  return (
    <div className="asset-workspace-page">
      <header className="asset-workspace-head">
        <div><h2>标的工作台</h2><p>把行情、SH计划、资金结构、提醒、观察备注与历史结果放在同一视图。</p></div>
        <div className="asset-workspace-search">
          <input className="search-input" placeholder="搜索 BTC / AAPL / 合约代码..." value={query} onChange={e => setQuery(e.target.value)} />
          <select value={effectiveSelectedKey} onChange={e => setSelectedKey(e.target.value)} disabled={!matches.length}>
            {matches.map(asset => <option key={workspaceKey(asset)} value={workspaceKey(asset)}>{asset.symbol} · {venueLabel(asset)}{asset.name ? ` · ${asset.name}` : ''}</option>)}
          </select>
        </div>
      </header>
      {!selected ? <div className="pair-empty">暂无可用标的，请先刷新市场数据。</div> : <>
        <section className="asset-workspace-summary">
          <div><span>标的</span><b>{selected.symbol}</b><em>{selected.name ?? selected.apiSymbol}</em></div>
          <div><span>价格 / 24H</span><b>{formatPrice(selected.price)}</b><em className={(selected.change24h ?? 0) >= 0 ? 'pos' : 'neg'}>{fmtPct(selected.change24h)}</em></div>
          <div><span>RSI 1H / 4H / 1D</span><b>{selected.rsi?.['1h']?.toFixed?.(1) ?? '-'} / {selected.rsi?.['4h']?.toFixed?.(1) ?? '-'} / {selected.rsi?.['1d']?.toFixed?.(1) ?? '-'}</b><em>{selected.marketSession ?? 'continuous'}</em></div>
          <div><span>资金结构</span><b>{selected.derivatives?.label ?? '无衍生品快照'}</b><em>OI4H {fmtPct(selected.derivatives?.oiChange4h)}</em></div>
          <button className="zone-btn" onClick={() => setChartOpen(true)}>打开K线</button>
        </section>
        {siblingInstruments.length > 1 && <section className="asset-workspace-venues">
          <div><b>{underlyingSymbol(selected)} 跨市场 · {crossMarket.confirmation === 'confirmed' ? '同向确认' : crossMarket.confirmation === 'diverged' ? '方向背离' : '等待双边确认'}</b><span>
            {Number.isFinite(crossMarket.basisPct) ? `合约基差 ${crossMarket.basisPct >= 0 ? '+' : ''}${crossMarket.basisPct.toFixed(2)}% · ` : ''}
            {crossMarket.phase === 'regular' ? '美股常规时段，现货为价格锚' : `${crossMarket.phase}，合约信号需现货开盘复核`}
          </span></div>
          {siblingInstruments.map(asset => <button
            key={workspaceKey(asset)}
            className={`feed-type-btn ${workspaceKey(asset) === effectiveSelectedKey ? 'active' : ''}`}
            onClick={() => setSelectedKey(workspaceKey(asset))}
          >{venueLabel(asset)} · {formatPrice(asset.price)}</button>)}
        </section>}
        {selected.type === 'tradfi' && <div className="asset-workspace-classification">标的池：{universeTier(selected, assets, crossMarketIndex) === 'dual_core' ? '双市场核心池' : 'TradFi 独有池'} · 分类：{({ equity_perp: '股票合约', etf_perp: 'ETF 合约', commodity_perp: '商品合约', index_perp: '指数合约' })[tradfiSubtype(selected)]}</div>}
        {!!selectedEvents.length && <div className="asset-workspace-events"><b>公司事件</b>{selectedEvents.map(item => <span key={item.id}>{item.form ?? item.eventType} · {new Date(item.effectiveAt ?? item.announcedAt).toLocaleDateString('zh-CN')}{item.guard.active ? ' · 当前风险窗口' : ''}</span>)}</div>}
        <div className="asset-workspace-grid">
          <section><h3>Signal Hunter 计划</h3>{signal ? <div className="asset-plan"><b>{signal.status} · {signal.side === 'short' ? '做空' : '做多'} · {signal.timeframe}</b><span>入场 {formatPrice(signal.entryPrice)} · 失效 {formatPrice(signal.stopLoss)}</span><span>目标 {(signal.targets ?? [signal.tp1, signal.tp2, signal.tp3]).filter(Number.isFinite).map(formatPrice).join(' / ') || '-'}</span><span>评分 {signal.score?.total ?? '-'} · {signal.setupLabel ?? signal.setup}</span></div> : <em>当前没有 SH 计划</em>}</section>
          <section><h3>提醒与观察</h3><div className="asset-kv"><span>规则</span><b>{relatedRules.length} 条</b><span>最近事件</span><b>{relatedFeed.length} 条</b><span>观察状态</span><b>{watch?.status ?? '未加入'}</b></div>{watch ? <input className="search-input" value={watch.note ?? ''} placeholder="观察备注" onChange={e => setWatchNote(symbol, e.target.value)} /> : <button className="zone-btn" onClick={() => addWatch({ symbol, source: 'workspace', reason: '从标的工作台加入', ts: Date.now(), snapshot: { price: selected.price, rsi: selected.rsi } })}>加入观察池</button>}</section>
          <section><h3>历史信号</h3><div className="asset-kv"><span>复盘样本</span><b>{relatedReviews.length}</b><span>已完成交易</span><b>{relatedTrades.length}</b><span>资金轨迹</span><b>{relatedTrail?.stage ?? '-'}</b></div>{relatedTrades.slice(0, 3).map(item => <p key={item.id}>{fmtTime(item.closedAt)} · {item.resultLabel} · {Number.isFinite(item.rMultiple) ? `${item.rMultiple >= 0 ? '+' : ''}${item.rMultiple}R` : '-'}</p>)}</section>
          <section><h3>最近事件</h3>{relatedFeed.length ? relatedFeed.slice(0, 5).map(item => <p key={item.id}><b>{fmtTime(item.ts)}</b> {item.reason ?? item.condition ?? item.type}</p>) : <em>暂无提醒事件</em>}</section>
        </div>
      </>}
      {chartOpen && selected && <Suspense fallback={null}><ChartModal asset={selected} onClose={() => setChartOpen(false)} /></Suspense>}
    </div>
  )
}
