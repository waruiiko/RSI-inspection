import { useMemo, useState } from 'react'
import useMarketStore from '../store/marketStore'
import { venueLabel } from '../utils/assetKey'
import { buildCrossMarketIndex, CROSS_MARKET_MAPPING_KEY, mappingDecision, tradfiSubtype } from '../utils/crossMarket'

function loadDecisions() {
  try { return JSON.parse(localStorage.getItem(CROSS_MARKET_MAPPING_KEY) || '{}') }
  catch { return {} }
}

export default function CrossMarketAuditPage() {
  const assets = useMarketStore(state => state.assets)
  const [decisions, setDecisions] = useState(loadDecisions)
  const [filter, setFilter] = useState('all')
  const groups = useMemo(() => [...buildCrossMarketIndex(assets)].map(([key, instruments]) => {
    const cash = instruments.filter(item => item.type === 'stock')
    const perp = instruments.filter(item => item.type === 'tradfi')
    const state = cash.length && perp.length ? cash.length === 1 && perp.length === 1 ? 'paired' : 'conflict' : 'unpaired'
    return { key, instruments, cash, perp, state, decision: decisions[key] ?? mappingDecision(key) }
  }).filter(group => group.cash.length || group.perp.length).filter(group => filter === 'all' || group.state === filter), [assets, decisions, filter])
  const decide = (key, value) => {
    const next = { ...decisions }
    if (value === 'auto') delete next[key]
    else next[key] = value
    setDecisions(next)
    localStorage.setItem(CROSS_MARKET_MAPPING_KEY, JSON.stringify(next))
  }
  return <div className="cross-market-audit-page">
    <header><div><h2>跨市场映射审核</h2><p>审核美股现货与 Binance TradFi 合约的自动配对；排除后不参与基差和跨市场确认。</p></div><div>{['all', 'paired', 'conflict', 'unpaired'].map(key => <button key={key} className={`feed-type-btn ${filter === key ? 'active' : ''}`} onClick={() => setFilter(key)}>{({ all: '全部', paired: '已配对', conflict: '冲突', unpaired: '未配对' })[key]}</button>)}</div></header>
    <div className="cross-market-audit-list">{groups.map(group => <article key={group.key} className={group.state}><div><b>{group.key.replace(/^equity:/, '')}</b><span>{({ paired: '自动配对', conflict: '一对多冲突', unpaired: '单市场' })[group.state]}</span></div><div className="cross-market-instruments">{group.instruments.map(asset => <span key={`${asset.source}:${asset.apiSymbol}`}>{venueLabel(asset)} · {asset.apiSymbol}{asset.type === 'tradfi' ? ` · ${tradfiSubtype(asset)}` : ''}</span>)}</div><div><button className={`feed-type-btn ${group.decision === 'confirmed' ? 'active' : ''}`} disabled={group.state !== 'paired'} onClick={() => decide(group.key, 'confirmed')}>确认</button><button className={`feed-type-btn ${group.decision === 'excluded' ? 'active' : ''}`} onClick={() => decide(group.key, 'excluded')}>排除</button><button className="feed-type-btn" onClick={() => decide(group.key, 'auto')}>恢复自动</button></div></article>)}</div>
  </div>
}
