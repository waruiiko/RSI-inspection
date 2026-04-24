import { useState, useEffect, useCallback, useMemo } from 'react'
import usePairsStore  from '../store/pairsStore'
import useGroupsStore from '../store/groupsStore'

export default function ManagePage({ onSaved }) {
  // ── Config ─────────────────────────────────────────────────
  const [trackedCrypto,  setTrackedCrypto]  = useState(new Set()) // Set<apiSymbol>
  const [trackedStocks,  setTrackedStocks]  = useState(new Set()) // Set<apiSymbol>
  const [knownStocks,    setKnownStocks]    = useState([])        // all validated stocks
  const [saving,         setSaving]         = useState(false)

  // ── Binance panel ──────────────────────────────────────────
  const spotPairs    = usePairsStore(s => s.spot)
  const futuresPairs = usePairsStore(s => s.futures)
  const pairsLoading = usePairsStore(s => s.loading)
  const loadPairs    = usePairsStore(s => s.load)
  const [cryptoSearch,   setCryptoSearch]   = useState('')
  const [cryptoMarket,   setCryptoMarket]   = useState('spot') // 'spot' | 'futures' | 'tradifi'

  // ── Stock panel ────────────────────────────────────────────
  const [stockInput,     setStockInput]     = useState('')
  const [stockSearch,    setStockSearch]    = useState('')
  const [validating,     setValidating]     = useState(false)
  const [validateResult, setValidateResult] = useState(null)

  // ── Load on mount ──────────────────────────────────────────
  useEffect(() => {
    window.api.getAssetsConfig().then(cfg => {
      setTrackedCrypto(new Set((cfg.crypto  || []).map(a => a.apiSymbol)))
      setTrackedStocks(new Set((cfg.stocks  || []).map(a => a.apiSymbol)))
      setKnownStocks(cfg.knownStocks || cfg.stocks || [])
    })
    loadPairs()
  }, [])

  // ── Derived ────────────────────────────────────────────────
  const activePairs = cryptoMarket === 'spot'
    ? spotPairs
    : cryptoMarket === 'futures'
      ? futuresPairs.filter(p => p.contractType === 'PERPETUAL')
      : futuresPairs.filter(p => p.contractType === 'TRADIFI_PERPETUAL')
  const filteredPairs = useMemo(() => {
    const q = cryptoSearch.toUpperCase()
    return q ? activePairs.filter(p => p.symbol.includes(q) || p.apiSymbol.includes(q)) : activePairs
  }, [activePairs, cryptoSearch])

  // ── Crypto toggle ──────────────────────────────────────────
  const toggleCrypto = useCallback((pair) => {
    setTrackedCrypto(prev => {
      const next = new Set(prev)
      next.has(pair.apiSymbol) ? next.delete(pair.apiSymbol) : next.add(pair.apiSymbol)
      return next
    })
  }, [])

  const allFilteredCryptoSelected = filteredPairs.length > 0 && filteredPairs.every(p => trackedCrypto.has(p.apiSymbol))
  const toggleAllCrypto = useCallback(() => {
    setTrackedCrypto(prev => {
      const next = new Set(prev)
      const allSel = filteredPairs.every(p => next.has(p.apiSymbol))
      filteredPairs.forEach(p => allSel ? next.delete(p.apiSymbol) : next.add(p.apiSymbol))
      return next
    })
  }, [filteredPairs])

  // ── Stock toggle ───────────────────────────────────────────
  const toggleStock = useCallback((apiSymbol) => {
    setTrackedStocks(prev => {
      const next = new Set(prev)
      next.has(apiSymbol) ? next.delete(apiSymbol) : next.add(apiSymbol)
      return next
    })
  }, [])

  const filteredStocks = useMemo(() => {
    const q = stockSearch.trim().toUpperCase()
    return q ? knownStocks.filter(s => s.symbol.toUpperCase().includes(q) || (s.name ?? '').toUpperCase().includes(q)) : knownStocks
  }, [knownStocks, stockSearch])

  const allFilteredStocksSelected = filteredStocks.length > 0 && filteredStocks.every(s => trackedStocks.has(s.apiSymbol))
  const toggleAllStocks = useCallback(() => {
    setTrackedStocks(prev => {
      const next = new Set(prev)
      const allSel = filteredStocks.every(s => next.has(s.apiSymbol))
      filteredStocks.forEach(s => allSel ? next.delete(s.apiSymbol) : next.add(s.apiSymbol))
      return next
    })
  }, [filteredStocks])

  // ── Stock validate & add ───────────────────────────────────
  const handleValidate = useCallback(async () => {
    const ticker = stockInput.trim().toUpperCase()
    if (!ticker) return
    setValidating(true)
    setValidateResult(null)
    const result = await window.api.validateStock(ticker)
    setValidateResult({ ...result, ticker })
    setValidating(false)
  }, [stockInput])

  const addStock = useCallback(() => {
    if (!validateResult?.valid) return
    const { ticker, name } = validateResult
    if (!knownStocks.some(s => s.apiSymbol === ticker)) {
      const entry = { symbol: ticker, apiSymbol: ticker, type: 'stock', source: 'yahoo', name }
      setKnownStocks(prev => [...prev, entry])
    }
    setTrackedStocks(prev => new Set([...prev, ticker]))
    setStockInput('')
    setValidateResult(null)
  }, [validateResult, knownStocks])

  // ── Save ───────────────────────────────────────────────────
  const handleSave = useCallback(async () => {
    setSaving(true)
    const allPairs  = [...spotPairs, ...futuresPairs]
    const futuresSet    = new Set(futuresPairs.map(f => f.apiSymbol))
    const tradifiSet    = new Set(futuresPairs.filter(f => f.contractType === 'TRADIFI_PERPETUAL').map(f => f.apiSymbol))
    const cryptoArr = allPairs
      .filter(p => trackedCrypto.has(p.apiSymbol))
      .map(p => ({
        symbol:    p.symbol,
        apiSymbol: p.apiSymbol,
        type:      tradifiSet.has(p.apiSymbol) ? 'tradfi' : 'crypto',
        source:    futuresSet.has(p.apiSymbol) ? 'binance-futures' : 'binance',
      }))
    const stocksArr = knownStocks
      .filter(s => trackedStocks.has(s.apiSymbol))
      .map(({ symbol, apiSymbol, type, source }) => ({ symbol, apiSymbol, type, source }))

    await window.api.saveAssetsConfig({
      crypto:      cryptoArr,
      stocks:      stocksArr,
      knownStocks: knownStocks.map(({ symbol, apiSymbol, type, source, name }) =>
        ({ symbol, apiSymbol, type, source, name })),
    })
    setSaving(false)
    onSaved()
  }, [spotPairs, futuresPairs, trackedCrypto, trackedStocks, knownStocks, onSaved])

  // ── Groups ─────────────────────────────────────────────────
  const groups      = useGroupsStore(s => s.groups)
  const createGroup = useGroupsStore(s => s.createGroup)
  const deleteGroup = useGroupsStore(s => s.deleteGroup)
  const setMembers  = useGroupsStore(s => s.setMembers)
  const loadGroups  = useGroupsStore(s => s.load)
  const [activeGroup,  setActiveGroup]  = useState(null)
  const [newGroupName, setNewGroupName] = useState('')

  useEffect(() => { loadGroups() }, [])

  // All tracked symbols (for group membership picker)
  const allTracked = useMemo(() => {
    const cryptoSymbols = [...spotPairs, ...futuresPairs]
      .filter(p => trackedCrypto.has(p.apiSymbol))
      .map(p => ({ symbol: p.symbol, apiSymbol: p.apiSymbol }))
    const stockSymbols = knownStocks
      .filter(s => trackedStocks.has(s.apiSymbol))
      .map(s => ({ symbol: s.symbol, apiSymbol: s.apiSymbol }))
    return [...cryptoSymbols, ...stockSymbols]
  }, [spotPairs, futuresPairs, trackedCrypto, knownStocks, trackedStocks])

  const groupMembers = activeGroup ? new Set(groups[activeGroup] ?? []) : new Set()

  const toggleMember = (apiSymbol) => {
    if (!activeGroup) return
    const next = new Set(groupMembers)
    next.has(apiSymbol) ? next.delete(apiSymbol) : next.add(apiSymbol)
    setMembers(activeGroup, [...next])
  }

  const handleCreateGroup = () => {
    const name = newGroupName.trim()
    if (!name) return
    createGroup(name)
    setActiveGroup(name)
    setNewGroupName('')
  }

  const totalSelected = trackedCrypto.size + trackedStocks.size

  return (
    <div className="manage-page">
      <div className="manage-header">
        <span className="manage-title">管理品种</span>
        <div className="manage-header-right">
          <span className="manage-summary">已选 {totalSelected} 个品种</span>
          <button className="save-btn" onClick={handleSave} disabled={saving}>
            {saving ? '保存中…' : '保存并应用'}
          </button>
        </div>
      </div>

      <div className="manage-body">
        {/* ── Left: Crypto ── */}
        <div className="manage-panel">
          <div className="panel-head">
            <div className="panel-head-left">
              <span className="panel-title">加密货币</span>
              <div className="market-toggle">
                <button className={cryptoMarket === 'spot'    ? 'active' : ''} onClick={() => setCryptoMarket('spot')}>现货</button>
                <button className={cryptoMarket === 'futures' ? 'active' : ''} onClick={() => setCryptoMarket('futures')}>合约</button>
                <button className={cryptoMarket === 'tradifi' ? 'active' : ''} onClick={() => setCryptoMarket('tradifi')}>TradFi</button>
              </div>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span className="panel-count">
                {pairsLoading ? '加载中…' : `已选 ${trackedCrypto.size} / 共 ${activePairs.length}`}
              </span>
              {!pairsLoading && filteredPairs.length > 0 && (
                <button className="zone-btn" style={{ fontSize: 11, padding: '2px 8px' }} onClick={toggleAllCrypto}>
                  {allFilteredCryptoSelected ? '取消全选' : '全选'}
                </button>
              )}
            </div>
          </div>

          <div className="panel-search-wrap">
            <input
              type="search"
              className="search-input"
              placeholder="搜索交易对…"
              value={cryptoSearch}
              onChange={e => setCryptoSearch(e.target.value)}
            />
          </div>

          <div className="pair-list">
            {filteredPairs.map(pair => {
              const on = trackedCrypto.has(pair.apiSymbol)
              return (
                <label key={pair.apiSymbol} className={`pair-item ${on ? 'on' : ''}`}>
                  <input type="checkbox" checked={on} onChange={() => toggleCrypto(pair)} />
                  <span className="pair-symbol">{pair.symbol}</span>
                  <span className="pair-api">{pair.apiSymbol}</span>
                </label>
              )
            })}
            {!pairsLoading && filteredPairs.length === 0 && (
              <div className="pair-empty">无匹配结果</div>
            )}
          </div>
        </div>

        {/* ── Right: Stocks ── */}
        <div className="manage-panel">
          <div className="panel-head">
            <span className="panel-title">美股</span>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span className="panel-count">{trackedStocks.size} / {knownStocks.length}</span>
              {filteredStocks.length > 0 && (
                <button className="zone-btn" style={{ fontSize: 11, padding: '2px 8px' }} onClick={toggleAllStocks}>
                  {allFilteredStocksSelected ? '取消全选' : '全选'}
                </button>
              )}
            </div>
          </div>

          {knownStocks.length > 0 && (
            <div className="panel-search-wrap">
              <input
                type="search"
                className="search-input"
                placeholder="搜索股票…"
                value={stockSearch}
                onChange={e => setStockSearch(e.target.value)}
              />
            </div>
          )}

          <div className="pair-list">
            {knownStocks.length === 0 && (
              <div className="pair-empty">请在下方验证并添加股票</div>
            )}
            {filteredStocks.map(s => {
              const on = trackedStocks.has(s.apiSymbol)
              return (
                <label key={s.apiSymbol} className={`pair-item ${on ? 'on' : ''}`}>
                  <input type="checkbox" checked={on} onChange={() => toggleStock(s.apiSymbol)} />
                  <span className="pair-symbol">{s.symbol}</span>
                  {s.name && <span className="pair-api">{s.name}</span>}
                </label>
              )
            })}
            {knownStocks.length > 0 && stockSearch.trim() && filteredStocks.length === 0 && (
              <div className="pair-empty">无匹配结果</div>
            )}
          </div>

          <div className="stock-validate">
            <div className="validate-label">验证新品种</div>
            <div className="validate-row">
              <input
                className="search-input"
                placeholder="输入 Ticker，如 TSM"
                value={stockInput}
                onChange={e => { setStockInput(e.target.value); setValidateResult(null) }}
                onKeyDown={e => e.key === 'Enter' && handleValidate()}
              />
              <button
                className="search-btn"
                onClick={handleValidate}
                disabled={validating || !stockInput.trim()}
              >
                {validating ? '查询中…' : '验证'}
              </button>
            </div>

            {validateResult && (
              <div className={`validate-result ${validateResult.valid ? 'valid' : 'invalid'}`}>
                {validateResult.valid ? (
                  <>
                    <span className="vr-check">✓</span>
                    <span className="vr-name">{validateResult.name}</span>
                    <span className="vr-price">${validateResult.price?.toFixed(2)}</span>
                    <button
                      className="add-btn"
                      onClick={addStock}
                      disabled={knownStocks.some(s => s.apiSymbol === validateResult.ticker)}
                    >
                      {knownStocks.some(s => s.apiSymbol === validateResult.ticker) ? '已存在' : '+ 添加'}
                    </button>
                  </>
                ) : (
                  <>
                    <span className="vr-x">✗</span>
                    <span className="vr-error">未找到 {validateResult.ticker}</span>
                  </>
                )}
              </div>
            )}
          </div>
        </div>
        {/* ── Groups ── */}
        <div className="manage-panel">
          <div className="panel-head">
            <span className="panel-title">分组管理</span>
            <span className="panel-count">{Object.keys(groups).length} 个分组</span>
          </div>

          {/* Create new group */}
          <div className="validate-row" style={{ marginBottom: 8 }}>
            <input className="search-input" placeholder="新建分组名称…"
              value={newGroupName}
              onChange={e => setNewGroupName(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && handleCreateGroup()} />
            <button className="search-btn" onClick={handleCreateGroup}
              disabled={!newGroupName.trim() || !!groups[newGroupName.trim()]}>
              新建
            </button>
          </div>

          {/* Group selector */}
          {Object.keys(groups).length > 0 && (
            <div className="market-toggle" style={{ marginBottom: 8, flexWrap: 'wrap', gap: 4 }}>
              {Object.keys(groups).map(name => (
                <button key={name}
                  className={activeGroup === name ? 'active' : ''}
                  onClick={() => setActiveGroup(name)}>
                  {name} ({(groups[name] ?? []).length})
                </button>
              ))}
            </div>
          )}

          {/* Member picker */}
          {activeGroup && (
            <>
              <div className="panel-head" style={{ marginBottom: 4 }}>
                <span className="panel-title" style={{ fontSize: 11 }}>「{activeGroup}」成员</span>
                <button className="rule-del-btn" style={{ fontSize: 11, padding: '2px 8px' }}
                  onClick={() => { deleteGroup(activeGroup); setActiveGroup(null) }}>
                  删除分组
                </button>
              </div>
              <div className="pair-list">
                {allTracked.length === 0
                  ? <div className="pair-empty">请先在左侧两个面板勾选品种并保存</div>
                  : allTracked.map(({ symbol, apiSymbol }) => (
                    <label key={apiSymbol} className={`pair-item ${groupMembers.has(apiSymbol) ? 'on' : ''}`}>
                      <input type="checkbox"
                        checked={groupMembers.has(apiSymbol)}
                        onChange={() => toggleMember(apiSymbol)} />
                      <span className="pair-symbol">{symbol}</span>
                    </label>
                  ))
                }
              </div>
            </>
          )}

          {Object.keys(groups).length === 0 && (
            <div className="pair-empty">新建分组后可将品种归组，在主界面按组筛选</div>
          )}
        </div>

      </div>
    </div>
  )
}
