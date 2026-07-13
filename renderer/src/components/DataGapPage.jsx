import { useEffect, useMemo, useState } from 'react'
import useMarketStore from '../store/marketStore'
import { underlyingKey } from '../utils/assetKey'

const TIMEFRAMES = [['15m', 45 * 60e3], ['1h', 3 * 60 * 60e3], ['4h', 10 * 60 * 60e3], ['1d', 72 * 60 * 60e3]]

function candleTime(candle) {
  const value = Number(candle?.closeTime ?? candle?.time)
  return Number.isFinite(value) ? (value < 10_000_000_000 ? value * 1000 : value) : null
}

function candleState(asset, timeframe, maxAge, now) {
  const candles = asset.reviewCandlesByTf?.[timeframe] ?? []
  const latest = candleTime(candles.at(-1))
  if (!latest) return { tone: 'missing', label: '缺失', detail: `${timeframe} 没有闭合K线` }
  const age = now - latest
  if (age <= maxAge) return { tone: 'ok', label: '正常', detail: `${candles.length}根 · ${new Date(latest).toLocaleString('zh-CN')}` }
  if (asset.source === 'yahoo' && asset.marketSession !== 'regular') return { tone: 'paused', label: '休市', detail: `${asset.marketSession ?? 'closed'} · 最后 ${new Date(latest).toLocaleString('zh-CN')}` }
  return { tone: 'stale', label: '陈旧', detail: `已 ${Math.round(age / 60000)} 分钟未更新` }
}

function availability(value, label, notApplicable = false) {
  if (notApplicable) return { tone: 'na', label: '-', detail: `${label}不适用于该市场` }
  return value != null ? { tone: 'ok', label: '正常', detail: `${label}可用` } : { tone: 'missing', label: '缺失', detail: `${label}没有返回数据` }
}

function buildRow(asset, events, now) {
  const futures = asset.source === 'binance-futures'
  const stockLike = asset.type === 'stock' || asset.type === 'tradfi'
  const eventCount = events.filter(event => event.underlyingKey === underlyingKey(asset)).length
  const states = {
    ...Object.fromEntries(TIMEFRAMES.map(([tf, age]) => [tf, candleState(asset, tf, age, now)])),
    oi: availability(asset.derivatives?.oiValue, 'OI', !futures),
    funding: availability(asset.derivatives?.fundingRate, '资金费率', !futures),
    book: availability(asset.liquidity?.spreadPct, '实时盘口', asset.source === 'yahoo'),
    events: stockLike ? (eventCount ? { tone: 'ok', label: `${eventCount}条`, detail: `事件库已有 ${eventCount} 条记录` } : { tone: 'missing', label: '未覆盖', detail: '事件库尚无该标的记录' }) : { tone: 'na', label: '-', detail: '公司事件不适用于该市场' },
  }
  return { asset, states, issueCount: Object.values(states).filter(state => state.tone === 'missing' || state.tone === 'stale').length }
}

export default function DataGapPage() {
  const assets = useMarketStore(state => state.assets)
  const [events, setEvents] = useState([])
  const [onlyIssues, setOnlyIssues] = useState(true)
  const [market, setMarket] = useState('all')
  const [query, setQuery] = useState('')
  const [expanded, setExpanded] = useState(null)
  useEffect(() => { window.api?.loadOperationalData?.('companyEvents').then(value => setEvents(Array.isArray(value) ? value : [])).catch(() => {}) }, [])
  const rows = useMemo(() => {
    const q = query.trim().toUpperCase()
    return assets.map(asset => buildRow(asset, events, Date.now()))
      .filter(row => market === 'all' || row.asset.type === market)
      .filter(row => !onlyIssues || row.issueCount > 0)
      .filter(row => !q || [row.asset.symbol, row.asset.apiSymbol, row.asset.name].some(value => String(value ?? '').toUpperCase().includes(q)))
      .sort((a, b) => b.issueCount - a.issueCount || String(a.asset.symbol).localeCompare(String(b.asset.symbol)))
  }, [assets, events, market, onlyIssues, query])
  return <div className="data-gap-page">
    <header><div><h2>数据缺口热力图</h2><p>区分真实缺失、数据陈旧、美股休市和不适用项目；仅用于诊断，不改变Signal Hunter结果。</p></div><div><b>{rows.length}</b><span>标的</span><b>{rows.reduce((sum, row) => sum + row.issueCount, 0)}</b><span>缺口</span></div></header>
    <section className="data-gap-controls"><input className="search-input" placeholder="搜索标的" value={query} onChange={event => setQuery(event.target.value)} />{['all', 'crypto', 'stock', 'tradfi'].map(key => <button key={key} className={`feed-type-btn ${market === key ? 'active' : ''}`} onClick={() => setMarket(key)}>{({ all: '全部', crypto: '加密', stock: '美股', tradfi: 'TradFi' })[key]}</button>)}<button className={`feed-type-btn ${onlyIssues ? 'active' : ''}`} onClick={() => setOnlyIssues(value => !value)}>{onlyIssues ? '仅看异常' : '显示全部'}</button></section>
    <div className="data-gap-grid"><div className="data-gap-head"><span>标的</span>{TIMEFRAMES.map(([tf]) => <span key={tf}>{tf}</span>)}<span>OI</span><span>费率</span><span>盘口</span><span>事件库</span></div>
      {rows.map(row => <div className="data-gap-row-wrap" key={`${row.asset.source}:${row.asset.apiSymbol ?? row.asset.symbol}`}><button className="data-gap-row" onClick={() => setExpanded(value => value === row.asset.symbol ? null : row.asset.symbol)}><span className="data-gap-symbol"><b>{row.asset.symbol}</b><small>{row.asset.source} · {row.issueCount}缺口</small></span>{[...TIMEFRAMES.map(([tf]) => tf), 'oi', 'funding', 'book', 'events'].map(key => { const state = row.states[key]; return <span key={key} className={`data-gap-cell ${state.tone}`} title={state.detail}>{state.label}</span> })}</button>{expanded === row.asset.symbol && <div className="data-gap-details">{Object.entries(row.states).map(([key, state]) => <div key={key}><b>{key}</b><span className={state.tone}>{state.label}</span><em>{state.detail}</em></div>)}{row.asset.dataQuality?.issues?.map(issue => <div key={issue}><b>质量闸门</b><span className="missing">阻断</span><em>{issue}</em></div>)}</div>}</div>)}
      {!rows.length && <div className="signal-review-empty">当前筛选范围没有数据缺口。</div>}
    </div>
  </div>
}
