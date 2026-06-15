import { useState, useEffect, useCallback, useMemo } from 'react'
import usePairsStore  from '../store/pairsStore'
import useGroupsStore from '../store/groupsStore'
import useMarketStore from '../store/marketStore'
import useAiRunLogStore from '../store/aiRunLogStore'
import { getQuoteVolume } from '../utils/liquidity'
import { CORE_CRYPTO_SYMBOLS, STOCK_UNIVERSES, stockUniverseEntries } from '../utils/stockUniverse'

function uniqByApiSymbol(items) {
  const seen = new Set()
  const out = []
  for (const item of items) {
    if (!item?.apiSymbol || seen.has(item.apiSymbol)) continue
    seen.add(item.apiSymbol)
    out.push(item)
  }
  return out
}

function countPlan(plan) {
  const actions = Array.isArray(plan?.actions) ? plan.actions : []
  const groups = Array.isArray(plan?.groups) ? plan.groups : []
  return {
    actions: actions.length,
    symbols: actions.reduce((n, a) => n + (Array.isArray(a.apiSymbols) ? a.apiSymbols.length : 0), 0),
    groups: groups.length,
  }
}

function mergeKnownStocks(prev, incoming) {
  const bySymbol = new Map(prev.map(item => [item.apiSymbol, item]))
  for (const item of incoming) {
    bySymbol.set(item.apiSymbol, { ...bySymbol.get(item.apiSymbol), ...item })
  }
  return Array.from(bySymbol.values()).sort((a, b) => a.symbol.localeCompare(b.symbol))
}

export default function ManagePage({ onSaved, aiRequest }) {
  // ── Config ─────────────────────────────────────────────────
  const [trackedCrypto,  setTrackedCrypto]  = useState(new Set()) // Set<apiSymbol>
  const [trackedStocks,  setTrackedStocks]  = useState(new Set()) // Set<apiSymbol>
  const [knownStocks,    setKnownStocks]    = useState([])        // all validated stocks
  const [saving,         setSaving]         = useState(false)
  const [configMeta,     setConfigMeta]     = useState({})
  const marketAssets = useMarketStore(s => s.assets)

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
  const [aiInstruction,  setAiInstruction]  = useState('只保留成交额较高、近期有信号或资金结构较强的品种，低流动性和噪音品种先移除')
  const [aiBusy,         setAiBusy]         = useState(false)
  const [aiPlan,         setAiPlan]         = useState(null)
  const [aiPlanDir,      setAiPlanDir]      = useState('')
  const [aiError,        setAiError]        = useState('')
  const [aiUndo,         setAiUndo]         = useState(null)
  const addAiRunLog = useAiRunLogStore(s => s.add)

  // ── Load on mount ──────────────────────────────────────────
  useEffect(() => {
    window.api.getAssetsConfig().then(cfg => {
      setConfigMeta(cfg)
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

  const importStockUniverse = useCallback((keys) => {
    const incoming = stockUniverseEntries(Array.isArray(keys) ? keys : [keys])
    const symbols = incoming.map(item => item.apiSymbol)
    setKnownStocks(prev => mergeKnownStocks(prev, incoming))
    setTrackedStocks(prev => new Set([...prev, ...symbols]))
  }, [])

  const keepCoreCryptoOnly = useCallback(() => {
    const bySymbol = new Map()
    for (const pair of [...futuresPairs, ...spotPairs]) {
      if (!CORE_CRYPTO_SYMBOLS.has(pair.symbol)) continue
      if (pair.contractType === 'TRADIFI_PERPETUAL') continue
      bySymbol.set(pair.symbol, pair.apiSymbol)
    }
    setTrackedCrypto(new Set(bySymbol.values()))
  }, [spotPairs, futuresPairs])

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

    const currentCfg = await window.api.getAssetsConfig()
    await window.api.saveAssetsConfig({
      ...currentCfg,
      crypto:      cryptoArr,
      stocks:      stocksArr,
      knownStocks: knownStocks.map(({ symbol, apiSymbol, type, source, name }) =>
        ({ symbol, apiSymbol, type, source, name })),
    })
    setSaving(false)
    setConfigMeta(currentCfg)
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
  const [groupSearch,  setGroupSearch]  = useState('')

  useEffect(() => { loadGroups() }, [])

  useEffect(() => {
    if (!aiRequest?.instruction) return
    if (pairsLoading || (!spotPairs.length && !futuresPairs.length)) return
    setAiInstruction(aiRequest.instruction)
    generateAiPlan(aiRequest.instruction)
  }, [aiRequest?.id, pairsLoading, spotPairs.length, futuresPairs.length])

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
  const filteredTracked = useMemo(() => {
    const q = groupSearch.trim().toUpperCase()
    return q ? allTracked.filter(a => a.symbol.toUpperCase().includes(q) || a.apiSymbol.toUpperCase().includes(q)) : allTracked
  }, [allTracked, groupSearch])

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

  const createPresetGroup = (name, members) => {
    if (!members.length) return
    createGroup(name)
    setMembers(name, members)
    setActiveGroup(name)
  }

  const marketSnapshotByKey = useMemo(() => {
    const map = new Map()
    marketAssets.forEach(a => {
      const snap = {
        symbol: a.symbol,
        apiSymbol: a.apiSymbol,
        source: a.source,
        type: a.type,
        price: a.price,
        change24h: a.change24h,
        quoteVolume24h: getQuoteVolume(a),
        rsi: a.rsi,
        signalScore: a.signalScore,
        volumeSignal: a.volumeSignal,
        derivatives: a.derivatives,
      }
      if (a.apiSymbol) map.set(a.apiSymbol, snap)
      if (a.symbol) map.set(a.symbol, snap)
    })
    return map
  }, [marketAssets])

  const buildManageAiContext = () => {
    const allCrypto = uniqByApiSymbol([...spotPairs, ...futuresPairs])
    return {
      createdAt: new Date().toISOString(),
      current: {
        trackedCrypto: [...trackedCrypto],
        trackedStocks: [...trackedStocks],
        groups,
      },
      availableCrypto: allCrypto.map(p => ({
        symbol: p.symbol,
        apiSymbol: p.apiSymbol,
        contractType: p.contractType ?? 'SPOT',
        tracked: trackedCrypto.has(p.apiSymbol),
        market: marketSnapshotByKey.get(p.apiSymbol) ?? marketSnapshotByKey.get(p.symbol) ?? null,
      })),
      knownStocks: knownStocks.map(s => ({
        symbol: s.symbol,
        apiSymbol: s.apiSymbol,
        name: s.name,
        tracked: trackedStocks.has(s.apiSymbol),
        market: marketSnapshotByKey.get(s.apiSymbol) ?? marketSnapshotByKey.get(s.symbol) ?? null,
      })),
      rules: {
        confirmationRequired: true,
        allowedTargets: ['crypto', 'stocks'],
        allowedModes: ['add', 'remove', 'set'],
        note: 'AI only returns a plan; the app applies it after user confirmation.',
      },
    }
  }

  const generateAiPlan = async (instruction = aiInstruction) => {
    const text = instruction.trim()
    if (!text || aiBusy) return
    const startedAt = Date.now()
    setAiBusy(true)
    setAiError('')
    setAiPlan(null)
    try {
      const res = await window.api.runCodexManagePlan({
        scope: 'manage',
        instruction: text,
        context: buildManageAiContext(),
      })
      if (res.ok && res.plan) {
        setAiPlan(res.plan)
        setAiPlanDir(res.planDir || '')
        addAiRunLog({
          type: 'manage-plan',
          mode: 'manual',
          ok: true,
          inputCount: trackedCrypto.size + trackedStocks.size,
          outputCount: countPlan(res.plan).actions,
          elapsedMs: Date.now() - startedAt,
          path: res.planDir,
        })
      } else {
        setAiError(res.parseError || res.stderr || res.stdout || 'AI 没有返回可用预案')
        setAiPlanDir(res.planDir || '')
        addAiRunLog({
          type: 'manage-plan',
          mode: 'manual',
          ok: false,
          inputCount: trackedCrypto.size + trackedStocks.size,
          outputCount: 0,
          elapsedMs: Date.now() - startedAt,
          error: res.parseError || res.stderr || res.stdout || 'AI 没有返回可用预案',
          path: res.planDir,
        })
      }
    } catch (err) {
      setAiError(err.message || String(err))
      addAiRunLog({
        type: 'manage-plan',
        mode: 'manual',
        ok: false,
        inputCount: trackedCrypto.size + trackedStocks.size,
        outputCount: 0,
        elapsedMs: Date.now() - startedAt,
        error: err.message || String(err),
      })
    } finally {
      setAiBusy(false)
    }
  }

  const applyAiPlan = () => {
    if (!aiPlan) return
    setAiUndo({
      trackedCrypto: [...trackedCrypto],
      trackedStocks: [...trackedStocks],
      groups: { ...groups },
    })
    const cryptoAllowed = new Set([...spotPairs, ...futuresPairs].map(p => p.apiSymbol))
    const stockAllowed = new Set(knownStocks.map(s => s.apiSymbol))
    const clean = (items, allowed) => (Array.isArray(items) ? items : [])
      .map(s => String(s || '').trim())
      .filter(s => s && allowed.has(s))

    for (const action of Array.isArray(aiPlan.actions) ? aiPlan.actions : []) {
      const target = action.target === 'stocks' ? 'stocks' : 'crypto'
      const allowed = target === 'stocks' ? stockAllowed : cryptoAllowed
      const symbols = clean(action.apiSymbols, allowed)
      if (target === 'stocks') {
        setTrackedStocks(prev => {
          const next = action.mode === 'set' ? new Set() : new Set(prev)
          if (action.mode === 'remove') symbols.forEach(s => next.delete(s))
          else symbols.forEach(s => next.add(s))
          return next
        })
      } else {
        setTrackedCrypto(prev => {
          const next = action.mode === 'set' ? new Set() : new Set(prev)
          if (action.mode === 'remove') symbols.forEach(s => next.delete(s))
          else symbols.forEach(s => next.add(s))
          return next
        })
      }
    }

    for (const group of Array.isArray(aiPlan.groups) ? aiPlan.groups : []) {
      const name = String(group.name || '').trim()
      if (!name) continue
      const allowed = new Set([...cryptoAllowed, ...stockAllowed])
      const symbols = clean(group.apiSymbols, allowed)
      const prev = group.mode === 'add' ? new Set(groups[name] ?? []) : new Set()
      symbols.forEach(s => prev.add(s))
      setMembers(name, [...prev])
      setActiveGroup(name)
    }
  }

  const undoAiPlan = () => {
    if (!aiUndo) return
    setTrackedCrypto(new Set(aiUndo.trackedCrypto))
    setTrackedStocks(new Set(aiUndo.trackedStocks))
    Object.keys(groups).forEach(name => {
      if (!Object.prototype.hasOwnProperty.call(aiUndo.groups, name)) deleteGroup(name)
    })
    Object.entries(aiUndo.groups).forEach(([name, members]) => setMembers(name, members))
    setAiUndo(null)
  }

  const totalSelected = trackedCrypto.size + trackedStocks.size
  const aiPlanCount = countPlan(aiPlan)
  const aiPlanDiff = useMemo(() => {
    if (!aiPlan) return null
    const cryptoAllowed = new Set([...spotPairs, ...futuresPairs].map(p => p.apiSymbol))
    const stockAllowed = new Set(knownStocks.map(s => s.apiSymbol))
    const curCrypto = new Set(trackedCrypto)
    const curStocks = new Set(trackedStocks)
    let add = 0, remove = 0, replace = 0, unchanged = 0, skipped = 0
    for (const action of Array.isArray(aiPlan.actions) ? aiPlan.actions : []) {
      const target = action.target === 'stocks' ? 'stocks' : 'crypto'
      const current = target === 'stocks' ? curStocks : curCrypto
      const allowed = target === 'stocks' ? stockAllowed : cryptoAllowed
      const symbols = (Array.isArray(action.apiSymbols) ? action.apiSymbols : []).filter(s => allowed.has(s))
      skipped += Math.max(0, (action.apiSymbols?.length ?? 0) - symbols.length)
      if (action.mode === 'set') {
        const next = new Set(symbols)
        replace += symbols.length
        current.forEach(s => { if (!next.has(s)) remove++ })
        symbols.forEach(s => { if (!current.has(s)) add++; else unchanged++ })
      } else if (action.mode === 'remove') {
        symbols.forEach(s => current.has(s) ? remove++ : unchanged++)
      } else {
        symbols.forEach(s => current.has(s) ? unchanged++ : add++)
      }
    }
    return { add, remove, replace, unchanged, skipped }
  }, [aiPlan, spotPairs, futuresPairs, knownStocks, trackedCrypto, trackedStocks])
  const tradfiAutoAdded = Array.isArray(configMeta.tradfiAutoAdded) ? configMeta.tradfiAutoAdded : []

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
              {!pairsLoading && (
                <button className="zone-btn" style={{ fontSize: 11, padding: '2px 8px' }} onClick={keepCoreCryptoOnly}>
                  Core 15
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
              <button className="zone-btn" style={{ fontSize: 11, padding: '2px 8px' }} onClick={() => importStockUniverse(Object.keys(STOCK_UNIVERSES))}>
                Import All
              </button>
            </div>
          </div>

          <div className="stock-preset-row">
            {Object.entries(STOCK_UNIVERSES).map(([key, preset]) => (
              <button key={key} className="feed-type-btn" onClick={() => importStockUniverse(key)}>
                + {preset.label}
              </button>
            ))}
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

          <div style={{ display: 'flex', gap: 6, marginBottom: 8, flexWrap: 'wrap' }}>
            <button className="zone-btn" style={{ fontSize: 11, padding: '2px 8px' }}
              onClick={() => createPresetGroup('加密货币', allTracked.filter(a => !knownStocks.some(s => s.apiSymbol === a.apiSymbol)).map(a => a.apiSymbol))}>
              生成加密货币组
            </button>
            <button className="zone-btn" style={{ fontSize: 11, padding: '2px 8px' }}
              onClick={() => createPresetGroup('美股', allTracked.filter(a => knownStocks.some(s => s.apiSymbol === a.apiSymbol)).map(a => a.apiSymbol))}>
              生成美股组
            </button>
          </div>

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
              <input
                type="search"
                className="search-input"
                style={{ marginBottom: 6 }}
                placeholder="搜索分组成员..."
                value={groupSearch}
                onChange={e => setGroupSearch(e.target.value)}
              />
              <div className="pair-list">
                {allTracked.length === 0
                  ? <div className="pair-empty">请先在左侧两个面板勾选品种并保存</div>
                  : filteredTracked.map(({ symbol, apiSymbol }) => (
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
      {tradfiAutoAdded.length > 0 && (
        <div className="tradfi-center">
          <div>
            <b>TradFi 新标的中心</b>
            <span>最近自动加入 {tradfiAutoAdded.length} 个 Binance 美股合约标的，并已补最高级别提醒</span>
          </div>
          <div className="tradfi-center-list">
            {tradfiAutoAdded.slice(-8).reverse().map(item => (
              <span key={`${item.apiSymbol}-${item.addedAt}`} className="rule-chip blue">
                {item.symbol} · {new Date(item.addedAt).toLocaleDateString('zh-CN')}
              </span>
            ))}
          </div>
        </div>
      )}
      <div className="manage-ai-panel">
        <div className="panel-head">
          <div>
            <span className="panel-title">AI 批量助手</span>
            <span className="panel-count" style={{ marginLeft: 8 }}>生成预案后需手动应用，不会自动修改配置</span>
          </div>
          <div className="manage-ai-actions">
            {aiPlanDir && <button className="zone-btn" onClick={() => window.api.openPath(aiPlanDir)}>打开预案目录</button>}
            <button className="zone-btn" disabled={aiBusy || !aiInstruction.trim()} onClick={() => generateAiPlan()}>
              {aiBusy ? '生成中...' : '生成 AI 预案'}
            </button>
            <button className="save-btn" disabled={!aiPlan} onClick={applyAiPlan}>应用预案</button>
            <button className="zone-btn" disabled={!aiUndo} onClick={undoAiPlan}>撤销应用</button>
          </div>
        </div>
        <div className="manage-ai-input-row">
          <textarea
            value={aiInstruction}
            onChange={e => setAiInstruction(e.target.value)}
            placeholder="例如：只保留成交额 Top 100 的合约，并把 AI 候选池里值得观察的品种加入“重点观察”分组"
          />
          <div className="manage-ai-presets">
            <button className="feed-type-btn" onClick={() => setAiInstruction('只保留成交额 Top 100 的加密货币，移除低流动性和无有效市场数据的品种')}>Top 100</button>
            <button className="feed-type-btn" onClick={() => setAiInstruction('把评分较高、资金结构较强或近期有放量信号的品种加入“重点观察”分组，不改变当前跟踪列表')}>重点分组</button>
            <button className="feed-type-btn" onClick={() => setAiInstruction('移除长时间无成交额、价格数据缺失或信号噪音明显的品种，保留主流和近期活跃品种')}>清理噪音</button>
          </div>
        </div>
        {aiError && <div className="manage-ai-error">{aiError}</div>}
        {aiPlan && (
          <div className="manage-ai-plan">
            <div className="manage-ai-summary">
              <b>{aiPlan.summary || 'AI 批量操作预案'}</b>
              <span>{aiPlanCount.actions} 个动作 · {aiPlanCount.symbols} 个标的 · {aiPlanCount.groups} 个分组</span>
              {aiPlanDiff && (
                <span>新增 {aiPlanDiff.add} · 移除 {aiPlanDiff.remove} · 不变 {aiPlanDiff.unchanged} · 跳过 {aiPlanDiff.skipped}</span>
              )}
              {aiPlan.risk && <em>{aiPlan.risk}</em>}
            </div>
            <div className="manage-ai-plan-list">
              {(aiPlan.actions ?? []).map((a, i) => (
                <div key={`a-${i}`} className="manage-ai-plan-row">
                  <strong>{a.target === 'stocks' ? '美股' : '加密'} · {a.mode}</strong>
                  <span>{(a.apiSymbols ?? []).slice(0, 10).join(', ')}{(a.apiSymbols ?? []).length > 10 ? ` 等 ${(a.apiSymbols ?? []).length} 个` : ''}</span>
                  <em>{a.reason}</em>
                </div>
              ))}
              {(aiPlan.groups ?? []).map((g, i) => (
                <div key={`g-${i}`} className="manage-ai-plan-row">
                  <strong>分组 · {g.name} · {g.mode}</strong>
                  <span>{(g.apiSymbols ?? []).slice(0, 10).join(', ')}{(g.apiSymbols ?? []).length > 10 ? ` 等 ${(g.apiSymbols ?? []).length} 个` : ''}</span>
                  <em>{g.reason}</em>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
