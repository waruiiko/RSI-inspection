import { useEffect, useMemo, useState } from 'react'
import useMarketStore from '../store/marketStore'
import { COMPANY_EVENTS_CACHE_KEY, eventGuard } from '../utils/companyEvents'

function fmtTime(value) { return value ? new Date(value).toLocaleString('zh-CN') : '-' }

export default function CompanyEventsPage() {
  const assets = useMarketStore(state => state.assets)
  const defaultSymbols = useMemo(() => assets.filter(item => item.type === 'stock').slice(0, 20).map(item => item.symbol).join(', '), [assets])
  const [symbols, setSymbols] = useState('')
  const [userAgent, setUserAgent] = useState(() => localStorage.getItem('rsi:secUserAgent') || '')
  const [alphaVantageKey, setAlphaVantageKey] = useState(() => localStorage.getItem('rsi:alphaVantageKey') || '')
  const [events, setEvents] = useState([])
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState('')
  const [filter, setFilter] = useState('all')
  useEffect(() => {
    window.api.loadOperationalData('companyEvents').then(items => {
      const next = Array.isArray(items) ? items : []
      setEvents(next); localStorage.setItem(COMPANY_EVENTS_CACHE_KEY, JSON.stringify(next))
    }).catch(() => {})
  }, [])
  const requestedSymbols = () => (symbols || defaultSymbols).split(/[\s,;]+/).filter(Boolean)
  const sync = async () => {
    setBusy(true); setStatus('')
    try {
      localStorage.setItem('rsi:secUserAgent', userAgent)
      const result = await window.api.syncSecCompanyEvents({ symbols: requestedSymbols(), userAgent, days: 90 })
      setEvents(result.events ?? [])
      localStorage.setItem(COMPANY_EVENTS_CACHE_KEY, JSON.stringify(result.events ?? []))
      setStatus(`新增/更新 ${result.added ?? 0} 条${result.missing?.length ? ` · 未匹配 ${result.missing.join(', ')}` : ''}`)
    } catch (error) { setStatus(error.message) }
    finally { setBusy(false) }
  }
  const syncEarnings = async () => {
    setBusy(true); setStatus('')
    try {
      localStorage.setItem('rsi:alphaVantageKey', alphaVantageKey)
      const result = await window.api.syncEarningsCalendar({ symbols: requestedSymbols(), apiKey: alphaVantageKey })
      setEvents(result.events ?? [])
      localStorage.setItem(COMPANY_EVENTS_CACHE_KEY, JSON.stringify(result.events ?? []))
      setStatus(`财报日历新增/更新 ${result.added ?? 0} 条`)
    } catch (error) { setStatus(error.message) }
    finally { setBusy(false) }
  }
  const rows = events.filter(item => filter === 'all' || item.eventType === filter)
  return <div className="company-events-page">
    <header><div><h2>公司重要事件</h2><p>第一阶段记录 SEC 正式披露，只做风险提示，不改变 Signal Hunter 入场资格。</p></div></header>
    <section className="company-events-sync"><input className="search-input" placeholder={`代码，最多20个；默认 ${defaultSymbols}`} value={symbols} onChange={event => setSymbols(event.target.value)} /><input className="search-input" placeholder="SEC User-Agent，例如 YourName your@email.com" value={userAgent} onChange={event => setUserAgent(event.target.value)} /><button className="zone-btn" disabled={busy || !userAgent.includes('@')} onClick={sync}>{busy ? '同步中' : '同步 SEC'}</button></section>
    <section className="company-events-sync company-events-calendar-sync"><input className="search-input" placeholder="Alpha Vantage API Key" type="password" value={alphaVantageKey} onChange={event => setAlphaVantageKey(event.target.value)} /><span>同步未来三个月财报日期；API Key 仅保存在本机。</span><button className="zone-btn" disabled={busy || !alphaVantageKey} onClick={syncEarnings}>{busy ? '同步中' : '同步财报日历'}</button></section>
    {status && <div className="company-events-status">{status}</div>}
    <nav>{['all', 'material_filing', 'financial_filing', 'earnings', 'split', 'dividend'].map(key => <button key={key} className={`feed-type-btn ${filter === key ? 'active' : ''}`} onClick={() => setFilter(key)}>{({ all: '全部', material_filing: '重大披露', financial_filing: '定期报告', earnings: '财报日历', split: '拆股', dividend: '分红' })[key]}</button>)}</nav>
    <div className="company-events-list">{rows.map(item => { const guard = eventGuard(item); return <article key={item.id} className={`${item.severity} ${guard.active ? 'active' : ''}`}><div><b>{item.symbol}</b><span>{item.form ?? item.eventType}</span></div><div><strong>{item.title}</strong><span>{item.details}</span></div><div><span>{fmtTime(item.effectiveAt ?? item.announcedAt)}</span><em>{guard.blocking ? '阻断级事件' : guard.active ? '风险窗口' : item.source.toUpperCase()}</em>{item.url && <button className="feed-type-btn" onClick={() => window.api.openExternal(item.url)}>查看原文</button>}</div></article> })}</div>
  </div>
}
