import { lazy, Suspense, useMemo, useState } from 'react'
import useMarketStore from '../store/marketStore'
import useAlertStore from '../store/alertStore'
import useWatchPoolStore from '../store/watchPoolStore'
import useSignalTrailStore from '../store/signalTrailStore'
import useSignalReviewStore from '../store/signalReviewStore'
import { formatPrice } from '../utils/rsi'

const ChartModal = lazy(() => import('./ChartModal'))

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

  const matches = useMemo(() => {
    const q = query.trim().toUpperCase()
    if (!q) return assets.slice(0, 12)
    return assets.filter(asset => `${asset.symbol} ${asset.apiSymbol ?? ''} ${asset.name ?? ''}`.toUpperCase().includes(q)).slice(0, 12)
  }, [assets, query])
  const selected = assets.find(asset => `${asset.source}:${asset.apiSymbol ?? asset.symbol}` === selectedKey) ?? matches[0] ?? null
  const symbol = String(selected?.symbol ?? '').toUpperCase()
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
          <select value={selectedKey} onChange={e => setSelectedKey(e.target.value)}>
            {matches.map(asset => <option key={`${asset.source}:${asset.apiSymbol ?? asset.symbol}`} value={`${asset.source}:${asset.apiSymbol ?? asset.symbol}`}>{asset.symbol} {asset.name ?? ''}</option>)}
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
