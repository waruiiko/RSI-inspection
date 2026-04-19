import { useState, useEffect, useMemo, useCallback } from 'react'
import useAlertStore  from '../store/alertStore'
import usePairsStore  from '../store/pairsStore'

const ALL_TF = ['15m', '1h', '4h', '1d']

const LIST_TABS = [
  { key: 'spot',    label: '现货'   },
  { key: 'futures', label: '合约'   },
  { key: 'tradfi',  label: 'TradFi' },
  { key: 'stock',   label: '美股'   },
]

export default function AlertPage() {
  const configs      = useAlertStore(s => s.configs)
  const upsert       = useAlertStore(s => s.upsert)
  const updateById   = useAlertStore(s => s.updateById)
  const remove       = useAlertStore(s => s.remove)
  const toggle       = useAlertStore(s => s.toggle)
  const addFeedItems = useAlertStore(s => s.addFeedItems)

  // ── Data ──────────────────────────────────────────────────
  const spotPairs    = usePairsStore(s => s.spot)
  const futuresPairs = usePairsStore(s => s.futures)
  const pairsLoading = usePairsStore(s => s.loading)
  const loadPairs    = usePairsStore(s => s.load)
  const [knownStocks,    setKnownStocks]    = useState([])
  const [trackedSymbols, setTrackedSymbols] = useState([])  // from ManagePage watchlist

  // ── UI state ──────────────────────────────────────────────
  const [activeList,  setActiveList]  = useState('spot')
  const [search,      setSearch]      = useState('')
  const [selected,    setSelected]    = useState(new Set())
  const [timeframes,    setTimeframes]    = useState(new Set(['1h', '4h', '1d']))
  const [requireAllTf, setRequireAllTf]  = useState(false)
  const [isSpecial,    setIsSpecial]     = useState(false)
  const [editingId,    setEditingId]     = useState(null)
  const [rsiAbove,     setRsiAbove]      = useState('')
  const [rsiBelow,     setRsiBelow]      = useState('')
  const [changeAbove,  setChangeAbove]   = useState('')
  const [changeBelow,  setChangeBelow]   = useState('')
  const [priceAbove,   setPriceAbove]    = useState('')
  const [priceBelow,   setPriceBelow]    = useState('')
  const [divBull,      setDivBull]       = useState(false)
  const [divBear,      setDivBear]       = useState(false)
  const [error,        setError]         = useState('')

  useEffect(() => {
    window.api.getAssetsConfig().then(cfg => {
      setKnownStocks(cfg.knownStocks || cfg.stocks || [])
      const syms = [
        ...(cfg.crypto || []).map(a => a.symbol),
        ...(cfg.stocks || []).map(a => a.symbol),
      ].filter(Boolean)
      setTrackedSymbols([...new Set(syms)])
    })
    loadPairs()
  }, [])

  // ── Derived list ──────────────────────────────────────────
  const currentSymbols = useMemo(() => {
    let items
    if      (activeList === 'spot')    items = spotPairs.map(p => p.symbol)
    else if (activeList === 'futures') items = futuresPairs.filter(p => p.contractType === 'PERPETUAL').map(p => p.symbol)
    else if (activeList === 'tradfi')  items = futuresPairs.filter(p => p.contractType === 'TRADIFI_PERPETUAL').map(p => p.symbol)
    else                               items = knownStocks.map(s => s.symbol)
    const q = search.trim().toUpperCase()
    return q ? items.filter(s => s.includes(q)) : items
  }, [spotPairs, futuresPairs, knownStocks, activeList, search])

  // ── Interactions ──────────────────────────────────────────
  const toggleSymbol = useCallback(sym => setSelected(prev => {
    const next = new Set(prev)
    next.has(sym) ? next.delete(sym) : next.add(sym)
    return next
  }), [])

  const toggleTf = tf => setTimeframes(prev => {
    const next = new Set(prev)
    if (next.has(tf)) { if (next.size > 1) next.delete(tf) }
    else next.add(tf)
    return next
  })

  const handleEdit = useCallback(c => {
    // Determine which tab this symbol belongs to
    const inSpot    = spotPairs.some(p => p.symbol === c.symbol)
    const inFutures = futuresPairs.some(p => p.contractType === 'PERPETUAL'        && p.symbol === c.symbol)
    const inTradfi  = futuresPairs.some(p => p.contractType === 'TRADIFI_PERPETUAL' && p.symbol === c.symbol)
    const inStock   = knownStocks.some(s => s.symbol === c.symbol)
    const tab = inSpot ? 'spot' : inFutures ? 'futures' : inTradfi ? 'tradfi' : inStock ? 'stock' : 'spot'

    setActiveList(tab)
    setSearch('')
    setSelected(new Set([c.symbol]))
    setEditingId(c.id)
    setIsSpecial(!!c.special)
    setTimeframes(new Set(c.timeframes ?? ['1h', '4h', '1d']))
    setRequireAllTf(c.requireAllTf ?? false)
    setRsiAbove(c.rsiAbove    != null ? String(c.rsiAbove)    : '')
    setRsiBelow(c.rsiBelow    != null ? String(c.rsiBelow)    : '')
    setChangeAbove(c.changeAbove != null ? String(c.changeAbove) : '')
    setChangeBelow(c.changeBelow != null ? String(c.changeBelow) : '')
    setPriceAbove(c.priceAbove  != null ? String(c.priceAbove)  : '')
    setPriceBelow(c.priceBelow  != null ? String(c.priceBelow)  : '')
    setDivBull(!!c.divBull)
    setDivBear(!!c.divBear)
    setError('')
  }, [spotPairs, futuresPairs, knownStocks])

  const handleSave = () => {
    if (selected.size === 0) { setError('请先勾选品种'); return }
    const hasRsi       = rsiAbove !== '' || rsiBelow !== ''
    const hasChange    = changeAbove !== '' || changeBelow !== ''
    const hasPrice     = priceAbove !== '' || priceBelow !== ''
    const hasDivergence = divBull || divBear
    if (!hasRsi && !hasChange && !hasPrice && !hasDivergence) { setError('至少设置一个条件'); return }

    const parse = v => v === '' ? null : parseFloat(v)
    const ra = parse(rsiAbove),   rb = parse(rsiBelow)
    const ca = parse(changeAbove), cb = parse(changeBelow)
    const pa = parse(priceAbove),  pb = parse(priceBelow)

    if (ra != null && (isNaN(ra) || ra < 0 || ra > 100)) { setError('RSI 超过：范围 0–100'); return }
    if (rb != null && (isNaN(rb) || rb < 0 || rb > 100)) { setError('RSI 低于：范围 0–100'); return }
    if (ca != null && (isNaN(ca) || ca <= 0))             { setError('涨幅请输入正数'); return }
    if (cb != null && (isNaN(cb) || cb <= 0))             { setError('跌幅请输入正数'); return }
    if (pa != null && (isNaN(pa) || pa <= 0))             { setError('价格突破：请输入正数'); return }
    if (pb != null && (isNaN(pb) || pb <= 0))             { setError('价格跌破：请输入正数'); return }

    setError('')
    const fields = {
      timeframes: [...timeframes],
      requireAllTf,
      special: isSpecial,
      rsiAbove: ra, rsiBelow: rb,
      changeAbove: ca, changeBelow: cb,
      priceAbove: pa, priceBelow: pb,
      divBull, divBear,
    }

    if (editingId) {
      updateById(editingId, fields)
      setEditingId(null)
    } else {
      upsert([...selected], fields)
    }
    setSelected(new Set())
    setIsSpecial(false)
  }

  const clearAll      = useAlertStore(s => s.clearAll)
  const setAllEnabled = useAlertStore(s => s.setAllEnabled)

  const testAlert = useCallback((c) => {
    const tf = (c.timeframes ?? ['1h'])[0]
    let item
    if (c.rsiAbove != null)
      item = { symbol: c.symbol, type: 'rsi', timeframe: tf, condition: 'above', threshold: c.rsiAbove, value: parseFloat((c.rsiAbove + 2.3).toFixed(1)), special: !!c.special }
    else if (c.rsiBelow != null)
      item = { symbol: c.symbol, type: 'rsi', timeframe: tf, condition: 'below', threshold: c.rsiBelow, value: parseFloat((c.rsiBelow - 2.3).toFixed(1)), special: !!c.special }
    else if (c.changeAbove != null)
      item = { symbol: c.symbol, type: 'change', condition: 'above', threshold: c.changeAbove, value: parseFloat((c.changeAbove + 1).toFixed(2)), special: !!c.special }
    else if (c.changeBelow != null)
      item = { symbol: c.symbol, type: 'change', condition: 'below', threshold: -c.changeBelow, value: -parseFloat((c.changeBelow + 1).toFixed(2)), special: !!c.special }
    else if (c.priceAbove != null)
      item = { symbol: c.symbol, type: 'price', condition: 'above', threshold: c.priceAbove, value: c.priceAbove * 1.01, special: !!c.special }
    else if (c.priceBelow != null)
      item = { symbol: c.symbol, type: 'price', condition: 'below', threshold: c.priceBelow, value: c.priceBelow * 0.99, special: !!c.special }
    else return
    addFeedItems([item])
    window.api.showNotificationBatch([item])
  }, [addFeedItems])

  const [pendingDelete, setPendingDelete] = useState(null)
  const [clearPending,  setClearPending]  = useState(false)
  const [rulesSearch,   setRulesSearch]   = useState('')

  const enabledCount = configs.filter(c => c.enabled).length
  const isEmpty      = !pairsLoading && currentSymbols.length === 0

  return (
    <div className="alert-page">
      <div className="manage-header">
        <span className="manage-title">提醒规则</span>
        <div className="manage-header-right">
          <span className="manage-summary">{enabledCount} 条启用 / 共 {configs.length} 条</span>
        </div>
      </div>

      <div className="manage-body">

        {/* ── Left: symbol picker ── */}
        <div className="manage-panel">
          <div className="panel-head">
            <div className="panel-head-left">
              <span className="panel-title">选择品种</span>
              {selected.size > 0 && <span className="panel-count">已选 {selected.size} 个</span>}
            </div>
            <div style={{ display: 'flex', gap: 6 }}>
              {trackedSymbols.length > 0 && (
                <button className="zone-btn" style={{ fontSize: 11, padding: '2px 8px' }}
                  title={`导入观察列表中的 ${trackedSymbols.length} 个品种`}
                  onClick={() => setSelected(new Set(trackedSymbols))}>
                  导入观察列表 ({trackedSymbols.length})
                </button>
              )}
              {selected.size > 0 && (
                <button className="zone-btn" style={{ fontSize: 11, padding: '2px 8px' }}
                  onClick={() => setSelected(new Set())}>清空</button>
              )}
            </div>
          </div>

          {/* Condition form — top */}
          <div className="alert-condition-form">
            <div className="alert-cond-row">
              <span className="alert-cond-label">时间框</span>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <div className="alert-tf-group">
                  {ALL_TF.map(tf => (
                    <button key={tf}
                      className={`alert-tf-btn ${timeframes.has(tf) ? 'active' : ''}`}
                      onClick={() => toggleTf(tf)}>
                      {tf}
                    </button>
                  ))}
                </div>
                {timeframes.size > 1 && (
                  <label className="alert-resonance-label" title="单个周期满足触发普通提醒；所选全部周期同时满足时额外触发特殊提醒（★）">
                    <input type="checkbox" checked={requireAllTf}
                      onChange={e => setRequireAllTf(e.target.checked)} />
                    <span>共振</span>
                  </label>
                )}
              </div>
            </div>

            <div className="alert-cond-row">
              <span className="alert-cond-label">RSI</span>
              <div className="alert-cond-inputs">
                <label className="alert-cond-input-wrap">
                  <span className="alert-cond-hint">超过</span>
                  <input className="alert-num-input" type="number" min="0" max="100"
                    placeholder="如 70" value={rsiAbove}
                    onChange={e => setRsiAbove(e.target.value)} />
                </label>
                <label className="alert-cond-input-wrap">
                  <span className="alert-cond-hint">低于</span>
                  <input className="alert-num-input" type="number" min="0" max="100"
                    placeholder="如 30" value={rsiBelow}
                    onChange={e => setRsiBelow(e.target.value)} />
                </label>
              </div>
            </div>

            <div className="alert-cond-row">
              <span className="alert-cond-label">涨跌幅</span>
              <div className="alert-cond-inputs">
                <label className="alert-cond-input-wrap">
                  <span className="alert-cond-hint" style={{ color: '#f85149' }}>涨超</span>
                  <input className="alert-num-input" type="number" min="0"
                    placeholder="如 5" value={changeAbove}
                    onChange={e => setChangeAbove(e.target.value)} />
                  <span className="alert-cond-unit">%</span>
                </label>
                <label className="alert-cond-input-wrap">
                  <span className="alert-cond-hint" style={{ color: '#3fb950' }}>跌超</span>
                  <input className="alert-num-input" type="number" min="0"
                    placeholder="如 5" value={changeBelow}
                    onChange={e => setChangeBelow(e.target.value)} />
                  <span className="alert-cond-unit">%</span>
                </label>
              </div>
            </div>

            {(selected.size <= 1 || editingId) && (
              <div className="alert-cond-row">
                <span className="alert-cond-label">价格</span>
                <div className="alert-cond-inputs">
                  <label className="alert-cond-input-wrap">
                    <span className="alert-cond-hint" style={{ color: '#f85149' }}>突破</span>
                    <input className="alert-num-input" type="number" min="0"
                      placeholder="如 50000" value={priceAbove}
                      onChange={e => setPriceAbove(e.target.value)} />
                  </label>
                  <label className="alert-cond-input-wrap">
                    <span className="alert-cond-hint" style={{ color: '#3fb950' }}>跌破</span>
                    <input className="alert-num-input" type="number" min="0"
                      placeholder="如 40000" value={priceBelow}
                      onChange={e => setPriceBelow(e.target.value)} />
                  </label>
                </div>
              </div>
            )}
            {selected.size > 1 && !editingId && (
              <div className="alert-cond-row">
                <span className="alert-cond-label" style={{ color: 'var(--dim)' }}>价格</span>
                <span style={{ fontSize: 11, color: 'var(--dim)' }}>批量模式下不支持价格提醒，请单独为每个品种设置</span>
              </div>
            )}

            <div className="alert-cond-row">
              <span className="alert-cond-label">背离</span>
              <div style={{ display: 'flex', gap: 14, alignItems: 'center' }}>
                <label style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 12, cursor: 'pointer' }}>
                  <input type="checkbox" checked={divBull} onChange={e => setDivBull(e.target.checked)} />
                  <span style={{ color: '#22c55e' }}>↗ 牛市背离</span>
                </label>
                <label style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 12, cursor: 'pointer' }}>
                  <input type="checkbox" checked={divBear} onChange={e => setDivBear(e.target.checked)} />
                  <span style={{ color: '#f97316' }}>↘ 熊市背离</span>
                </label>
              </div>
            </div>

            <div className="alert-form-actions">
              <button
                className={`special-toggle-btn ${isSpecial ? 'active' : ''}`}
                title={isSpecial ? '当前为特别提醒（叠加在普通提醒之上）' : '切换为特别提醒'}
                onClick={() => setIsSpecial(v => !v)}
              >
                ★ {isSpecial ? '特别提醒' : '普通提醒'}
              </button>
              <button className="save-btn" onClick={handleSave}
                disabled={!editingId && selected.size === 0}>
                {editingId ? '更新提醒' : selected.size > 1 ? `保存 (${selected.size} 个品种)` : '保存提醒'}
              </button>
              {editingId && (
                <button className="zone-btn" style={{ fontSize: 11 }}
                  onClick={() => { setEditingId(null); setSelected(new Set()); setIsSpecial(false) }}>
                  取消编辑
                </button>
              )}
              {error && <span className="alert-error">{error}</span>}
            </div>
          </div>

          {/* List tabs + search */}
          <div className="panel-search-wrap">
            <div className="market-toggle" style={{ marginBottom: 6 }}>
              {LIST_TABS.map(t => (
                <button key={t.key}
                  className={activeList === t.key ? 'active' : ''}
                  onClick={() => { setActiveList(t.key); setSearch('') }}>
                  {t.label}
                </button>
              ))}
            </div>
            <input
              type="search"
              className="search-input"
              style={{ maxWidth: '100%' }}
              placeholder="搜索品种…"
              value={search}
              onChange={e => setSearch(e.target.value)}
            />
          </div>

          <div className="pair-list">
            {pairsLoading
              ? <div className="pair-empty">加载中…</div>
              : isEmpty
                ? <div className="pair-empty">无匹配品种</div>
                : currentSymbols.map(sym => (
                  <div key={sym}
                    className={`pair-item ${selected.has(sym) ? 'on' : ''} ${configs.find(c => c.symbol === sym) ? 'has-alert' : ''}`}
                    onClick={() => toggleSymbol(sym)}>
                    <input type="checkbox" checked={selected.has(sym)}
                      onChange={() => toggleSymbol(sym)}
                      onClick={e => e.stopPropagation()} />
                    <span className="pair-symbol">{sym}</span>
                    {configs.find(c => c.symbol === sym) && (
                      <span className="alert-exists-badge">已设</span>
                    )}
                  </div>
                ))
            }
          </div>
        </div>

        {/* ── Right: existing rules ── */}
        <div className="manage-panel">
          <div className="panel-head">
            <span className="panel-title">已有规则</span>
            <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
              <span className="panel-count">{configs.length} 条</span>
              <input
                type="search"
                className="search-input"
                style={{ width: 120, maxWidth: 120 }}
                placeholder="搜索品种…"
                value={rulesSearch}
                onChange={e => setRulesSearch(e.target.value)}
              />
              {configs.length > 0 && (
                <>
                  <button className="zone-btn" style={{ fontSize: 11, padding: '2px 8px' }}
                    onClick={() => setAllEnabled(true)}>全部启用</button>
                  <button className="zone-btn" style={{ fontSize: 11, padding: '2px 8px' }}
                    onClick={() => setAllEnabled(false)}>全部禁用</button>
                </>
              )}
              {configs.length > 0 && !clearPending && (
                <button className="rule-del-btn" style={{ padding: '2px 8px' }}
                  onClick={() => setClearPending(true)}>清除全部</button>
              )}
              {clearPending && (
                <>
                  <span style={{ fontSize: 11, color: 'var(--muted)' }}>确认清除所有规则？</span>
                  <button className="rule-del-btn" style={{ padding: '2px 8px' }}
                    onClick={() => { clearAll(); setClearPending(false) }}>确认</button>
                  <button className="zone-btn" style={{ fontSize: 11, padding: '2px 8px' }}
                    onClick={() => setClearPending(false)}>取消</button>
                </>
              )}
            </div>
          </div>

          <div className="pair-list" style={{ marginTop: 0 }}>
            {configs.length === 0
              ? <div className="pair-empty">暂无规则，请在左侧添加</div>
              : (() => {
                const q = rulesSearch.trim().toUpperCase()
                const filtered = q ? configs.filter(c => c.symbol.toUpperCase().includes(q)) : configs
                if (filtered.length === 0) return <div className="pair-empty">无匹配规则</div>
                return (
                <table className="stats-table">
                  <thead>
                    <tr>
                      <th></th>
                      <th>品种</th>
                      <th style={{ width: 24 }}>★</th>
                      <th>时间框</th>
                      <th>共振</th>
                      <th>RSI↑</th>
                      <th>RSI↓</th>
                      <th>涨超</th>
                      <th>跌超</th>
                      <th>价↑</th>
                      <th>价↓</th>
                      <th>背离</th>
                      <th>触发</th>
                      <th>启用</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filtered.map(c => (
                      <tr key={c.id} className={c.enabled ? '' : 'rule-disabled'}>
                        <td style={{ whiteSpace: 'nowrap' }}>
                          <button className="rule-test-btn" onClick={() => testAlert(c)} title="模拟触发一次提醒">测试</button>
                          <button className="rule-edit-btn" style={{ marginLeft: 4 }} onClick={() => { handleEdit(c); setPendingDelete(null) }}>编辑</button>
                          {pendingDelete === c.id ? (
                            <>
                              <button className="rule-del-btn" style={{ marginLeft: 4 }}
                                onClick={() => { remove(c.id); setPendingDelete(null) }}>确认</button>
                              <button className="zone-btn" style={{ fontSize: 11, padding: '2px 6px', marginLeft: 3 }}
                                onClick={() => setPendingDelete(null)}>取消</button>
                            </>
                          ) : (
                            <button className="rule-del-btn" style={{ marginLeft: 4 }}
                              onClick={() => setPendingDelete(c.id)}>删除</button>
                          )}
                        </td>
                        <td>
                          <strong>{c.symbol}</strong>
                        </td>
                        <td style={{ textAlign: 'center', color: c.special ? '#f59e0b' : 'transparent', fontSize: 12 }}>
                          ★
                        </td>
                        <td>
                          <div className="tf-tags">
                            {(c.timeframes ?? []).map(tf => (
                              <span key={tf} className="tf-tag">{tf}</span>
                            ))}
                          </div>
                        </td>
                        <td style={{ color: c.requireAllTf ? '#f59e0b' : 'var(--dim)', fontSize: 11 }}>
                          {c.requireAllTf ? '是' : '—'}
                        </td>
                        <td className="mono" style={{ color: '#ef4444' }}>{c.rsiAbove    ?? '—'}</td>
                        <td className="mono" style={{ color: '#22c55e' }}>{c.rsiBelow    ?? '—'}</td>
                        <td className="mono" style={{ color: '#f85149' }}>{c.changeAbove != null ? `+${c.changeAbove}%` : '—'}</td>
                        <td className="mono" style={{ color: '#3fb950' }}>{c.changeBelow != null ? `-${c.changeBelow}%` : '—'}</td>
                        <td className="mono" style={{ color: '#f85149' }}>{c.priceAbove  != null ? c.priceAbove  : '—'}</td>
                        <td className="mono" style={{ color: '#3fb950' }}>{c.priceBelow  != null ? c.priceBelow  : '—'}</td>
                        <td className="mono" style={{ fontSize: 11 }}>
                          {c.divBull && <span style={{ color: '#22c55e' }}>↗</span>}
                          {c.divBear && <span style={{ color: '#f97316' }}>↘</span>}
                          {!c.divBull && !c.divBear && <span style={{ color: 'var(--dim)' }}>—</span>}
                        </td>
                        <td className="mono" style={{ fontSize: 11, color: 'var(--muted)', whiteSpace: 'nowrap' }}>
                          {c.fireCount > 0
                            ? <span title={c.lastFiredAt ? `最后: ${new Date(c.lastFiredAt).toLocaleString('zh-CN')}` : ''}>
                                {c.fireCount} 次
                              </span>
                            : <span style={{ color: 'var(--dim)' }}>—</span>
                          }
                        </td>
                        <td>
                          <label className="toggle-switch">
                            <input type="checkbox" checked={c.enabled} onChange={() => toggle(c.id)} />
                            <span className="toggle-track" />
                          </label>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                )
              })()
            }
          </div>
        </div>

      </div>
    </div>
  )
}
