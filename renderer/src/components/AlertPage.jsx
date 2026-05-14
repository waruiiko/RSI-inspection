import { useState, useEffect, useMemo, useCallback } from 'react'
import useAlertStore  from '../store/alertStore'
import usePairsStore  from '../store/pairsStore'
import useMarketStore from '../store/marketStore'
import useGroupsStore from '../store/groupsStore'
import { applyLiquidityLimit } from '../utils/liquidity'

const ALL_TF = ['15m', '1h', '4h', '1d']
const STRATEGIES = [
  { key: 'breakout', label: '放量突破', score: 4 },
  { key: 'breakdown', label: '放量破位', score: 4 },
  { key: 'volume_divergence', label: '量价背离', score: 3 },
]
const DEFAULT_STRATEGIES = ['breakout', 'breakdown', 'volume_divergence']
const RULE_TEMPLATES = [
  { name: 'RSI超卖反弹', timeframes: ['1h', '4h'], customMode: true, rsiBelow: '30', alertLevel: 2, divBull: true },
  { name: '多周期共振', timeframes: ['1h', '4h', '1d'], customMode: true, rsiBelow: '35', requireAllTf: true, alertLevel: 3 },
  { name: '熊市背离', timeframes: ['1h', '4h'], customMode: true, divBear: true, alertLevel: 2 },
  { name: '量价突破', timeframes: ['4h', '1d'], customMode: false, strategies: ['breakout'], minScore: 4, alertLevel: 2 },
]
const ALERT_LEVELS = [
  { value: 1, label: '一级提醒' },
  { value: 2, label: '二级提醒' },
  { value: 3, label: '三级提醒' },
]

const LIST_TABS = [
  { key: 'spot',    label: '现货'   },
  { key: 'futures', label: '合约'   },
  { key: 'tradfi',  label: 'TradFi' },
  { key: 'stock',   label: '美股'   },
]

function getRuleStrategies(rule) {
  if (Array.isArray(rule.strategies)) return rule.strategies
  if (rule.strategy) return [rule.strategy]
  return rule.volumeSignal ? DEFAULT_STRATEGIES : []
}

function getStrategyLabels(rule) {
  return getRuleStrategies(rule).map(k => STRATEGIES.find(s => s.key === k)?.label ?? k)
}

function getConditionTags(rule) {
  const tags = []
  if (rule.rsiAbove != null) tags.push({ label: `RSI > ${rule.rsiAbove}`, tone: 'red' })
  if (rule.rsiBelow != null) tags.push({ label: `RSI < ${rule.rsiBelow}`, tone: 'green' })
  if (rule.changeAbove != null) tags.push({ label: `涨超 ${rule.changeAbove}%`, tone: 'red' })
  if (rule.changeBelow != null) tags.push({ label: `跌超 ${rule.changeBelow}%`, tone: 'green' })
  if (rule.priceAbove != null) tags.push({ label: `突破 ${rule.priceAbove}`, tone: 'red' })
  if (rule.priceBelow != null) tags.push({ label: `跌破 ${rule.priceBelow}`, tone: 'green' })
  if (rule.divBull) tags.push({ label: '看涨背离', tone: 'green' })
  if (rule.divBear) tags.push({ label: '看跌背离', tone: 'orange' })
  if (rule.volumeSignal && getStrategyLabels(rule).length === 0) tags.push({ label: '量价结构', tone: 'blue' })
  return tags
}

function getLevelLabel(rule) {
  const level = rule.alertLevel ?? (rule.special ? 3 : 1)
  return ALERT_LEVELS.find(l => l.value === level)?.label ?? '一级提醒'
}

function describeRule(rule, selectedSize = 1) {
  const scope = rule.followTop ? `成交额 Top${rule.followTopLimit ?? 50}` : selectedSize > 1 ? `${selectedSize} 个品种` : rule.symbol
  const parts = [
    scope,
    (rule.timeframes ?? []).join('/'),
    getStrategyLabels(rule).join('/') || (rule.volumeSignal ? '量价结构' : ''),
    rule.minScore != null ? `评分 >= ${rule.minScore}` : '',
    rule.requireAllTf ? '共振' : '',
    getLevelLabel(rule),
    ...getConditionTags(rule).map(t => t.label),
  ].filter(Boolean)
  return parts.join(' · ')
}

export default function AlertPage() {
  const configs      = useAlertStore(s => s.configs)
  const upsert       = useAlertStore(s => s.upsert)
  const updateById   = useAlertStore(s => s.updateById)
  const remove       = useAlertStore(s => s.remove)
  const toggle       = useAlertStore(s => s.toggle)
  const addFeedItems = useAlertStore(s => s.addFeedItems)
  const bulkSetTimeframes = useAlertStore(s => s.bulkSetTimeframes)

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
  const [alertLevel,   setAlertLevel]    = useState(1)
  const [followTop,    setFollowTop]     = useState(false)
  const [editingId,    setEditingId]     = useState(null)
  const [rsiAbove,     setRsiAbove]      = useState('')
  const [rsiBelow,     setRsiBelow]      = useState('')
  const [changeAbove,  setChangeAbove]   = useState('')
  const [changeBelow,  setChangeBelow]   = useState('')
  const [priceAbove,   setPriceAbove]    = useState('')
  const [priceBelow,   setPriceBelow]    = useState('')
  const [divBull,      setDivBull]       = useState(false)
  const [divBear,      setDivBear]       = useState(false)
  const [volumeSignal, setVolumeSignal]  = useState(false)
  const [strategies,   setStrategies]    = useState(DEFAULT_STRATEGIES)
  const [customMode,   setCustomMode]    = useState(false)
  const [minScore,     setMinScore]      = useState(3)
  const [priceMode,    setPriceMode]     = useState('absolute')  // 'absolute' | 'pct'
  const [error,        setError]         = useState('')

  const assets = useMarketStore(s => s.assets)
  const groups = useGroupsStore(s => s.groups)

  const applyTemplate = (tpl) => {
    setTimeframes(new Set(tpl.timeframes))
    setRequireAllTf(!!tpl.requireAllTf)
    setAlertLevel(tpl.alertLevel ?? 1)
    setCustomMode(!!tpl.customMode)
    setRsiAbove(tpl.rsiAbove ?? '')
    setRsiBelow(tpl.rsiBelow ?? '')
    setChangeAbove(tpl.changeAbove ?? '')
    setChangeBelow(tpl.changeBelow ?? '')
    setPriceAbove('')
    setPriceBelow('')
    setDivBull(!!tpl.divBull)
    setDivBear(!!tpl.divBear)
    setVolumeSignal(!tpl.customMode)
    setStrategies(tpl.strategies ?? DEFAULT_STRATEGIES)
    setMinScore(tpl.minScore ?? 3)
  }

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

  const selectGroup = (name) => {
    const members = new Set(groups[name] ?? [])
    const allPairs = [...spotPairs, ...futuresPairs]
    const symbols = [
      ...allPairs.filter(p => members.has(p.apiSymbol)).map(p => p.symbol),
      ...knownStocks.filter(s => members.has(s.apiSymbol)).map(s => s.symbol),
    ]
    setSelected(new Set(symbols))
    setError(symbols.length ? '' : '该分组没有可用成员，请先在品种管理里保存分组')
  }

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

  const toggleStrategy = key => {
    setStrategies(prev => prev.includes(key)
      ? prev.filter(s => s !== key)
      : [...prev, key])
  }

  const selectTop50Alerts = () => {
    const candidates = assets
      .filter(a => a.type === 'crypto' || a.type === 'tradfi')
      .filter(a => a.rsi?.['4h'] != null || a.rsi?.['1d'] != null)
    const top = applyLiquidityLimit(candidates, 50).map(a => a.symbol)
    setSelected(new Set(top))
    setTimeframes(new Set(['4h', '1d']))
    setRequireAllTf(false)
    setCustomMode(false)
    setStrategies(DEFAULT_STRATEGIES)
    setMinScore(4)
    setAlertLevel(2)
    setFollowTop(true)
    setError(top.length ? '' : '当前没有可用于 Top50 的市场数据，请先刷新')
  }

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
    setAlertLevel(c.alertLevel ?? (c.special ? 3 : 1))
    setFollowTop(!!c.followTop)
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
    setVolumeSignal(!!c.volumeSignal)
    setStrategies(getRuleStrategies(c))
    setCustomMode(!c.volumeSignal && !c.strategy && !c.strategies)
    setMinScore(c.minScore ?? 3)
    setPriceMode('absolute')
    setError('')
  }, [spotPairs, futuresPairs, knownStocks])

  const handleCopy = useCallback(c => {
    handleEdit(c)
    setEditingId(null)
    setError('已复制到左侧表单，选择品种后保存即可生成新规则')
  }, [handleEdit])

  const handleSave = () => {
    if (selected.size === 0) { setError('请先勾选品种'); return }
    const hasRsi       = rsiAbove !== '' || rsiBelow !== ''
    const hasChange    = changeAbove !== '' || changeBelow !== ''
    const hasPrice     = priceAbove !== '' || priceBelow !== ''
    const hasDivergence = divBull || divBear
    const useStrategy = !customMode
    if (useStrategy && strategies.length === 0) { setError('至少选择一个策略'); return }
    if (!useStrategy && !hasRsi && !hasChange && !hasPrice && !hasDivergence && !volumeSignal) { setError('至少设置一个条件'); return }

    const parse = v => v === '' ? null : parseFloat(v)
    const ra = parse(rsiAbove),   rb = parse(rsiBelow)
    const ca = parse(changeAbove), cb = parse(changeBelow)
    let   pa = parse(priceAbove),  pb = parse(priceBelow)

    if (ra != null && (isNaN(ra) || ra < 0 || ra > 100)) { setError('RSI 超过：范围 0–100'); return }
    if (rb != null && (isNaN(rb) || rb < 0 || rb > 100)) { setError('RSI 低于：范围 0–100'); return }
    if (ca != null && (isNaN(ca) || ca <= 0))             { setError('涨幅请输入正数'); return }
    if (cb != null && (isNaN(cb) || cb <= 0))             { setError('跌幅请输入正数'); return }

    // Resolve % mode to absolute price
    if (priceMode === 'pct') {
      const sym = [...selected][0]
      const currentPrice = assets.find(a => a.symbol === sym)?.price
      if ((pa != null || pb != null) && !currentPrice) { setError('找不到该品种的当前价格，无法换算'); return }
      if (pa != null) pa = parseFloat((currentPrice * (1 + pa / 100)).toPrecision(6))
      if (pb != null) pb = parseFloat((currentPrice * (1 - pb / 100)).toPrecision(6))
    }

    if (pa != null && (isNaN(pa) || pa <= 0))             { setError('价格突破：请输入正数'); return }
    if (pb != null && (isNaN(pb) || pb <= 0))             { setError('价格跌破：请输入正数'); return }

    setError('')
    const fields = {
      timeframes: [...timeframes],
      requireAllTf,
      alertLevel,
      special: alertLevel >= 2,
      followTop,
      followTopLimit: followTop ? 50 : null,
      rsiAbove: ra, rsiBelow: rb,
      changeAbove: ca, changeBelow: cb,
      priceAbove: pa, priceBelow: pb,
      divBull, divBear,
      volumeSignal: useStrategy ? true : volumeSignal,
      strategies: useStrategy ? strategies : null,
      strategy: useStrategy && strategies.length === 1 ? strategies[0] : null,
      minScore: useStrategy ? minScore : null,
    }

    if (editingId) {
      updateById(editingId, fields)
      setEditingId(null)
    } else {
      upsert([...selected], fields)
    }
    setSelected(new Set())
    setAlertLevel(1)
    setFollowTop(false)
    setVolumeSignal(false)
    setStrategies(DEFAULT_STRATEGIES)
    setCustomMode(false)
    setMinScore(3)
  }

  const clearAll      = useAlertStore(s => s.clearAll)
  const setAllEnabled = useAlertStore(s => s.setAllEnabled)

  const testAlert = useCallback((c) => {
    const tf = (c.timeframes ?? ['1h'])[0]
    let item
    if (c.rsiAbove != null)
      item = { symbol: c.symbol, type: 'rsi', timeframe: tf, condition: 'above', threshold: c.rsiAbove, value: parseFloat((c.rsiAbove + 2.3).toFixed(1)), level: c.alertLevel ?? (c.special ? 3 : 1), special: !!c.special }
    else if (c.rsiBelow != null)
      item = { symbol: c.symbol, type: 'rsi', timeframe: tf, condition: 'below', threshold: c.rsiBelow, value: parseFloat((c.rsiBelow - 2.3).toFixed(1)), level: c.alertLevel ?? (c.special ? 3 : 1), special: !!c.special }
    else if (c.changeAbove != null)
      item = { symbol: c.symbol, type: 'change', condition: 'above', threshold: c.changeAbove, value: parseFloat((c.changeAbove + 1).toFixed(2)), level: c.alertLevel ?? (c.special ? 3 : 1), special: !!c.special }
    else if (c.changeBelow != null)
      item = { symbol: c.symbol, type: 'change', condition: 'below', threshold: -c.changeBelow, value: -parseFloat((c.changeBelow + 1).toFixed(2)), level: c.alertLevel ?? (c.special ? 3 : 1), special: !!c.special }
    else if (c.priceAbove != null)
      item = { symbol: c.symbol, type: 'price', condition: 'above', threshold: c.priceAbove, value: c.priceAbove * 1.01, level: c.alertLevel ?? (c.special ? 3 : 1), special: !!c.special }
    else if (c.priceBelow != null)
      item = { symbol: c.symbol, type: 'price', condition: 'below', threshold: c.priceBelow, value: c.priceBelow * 0.99, level: c.alertLevel ?? (c.special ? 3 : 1), special: !!c.special }
    else if (c.volumeSignal)
      item = { symbol: c.symbol, type: 'structure', timeframe: tf, condition: 'bullish', signal: '放量突破', value: 4, volumeRatio: 1.8, priceMovePct: 2.4, level: c.alertLevel ?? (c.special ? 3 : 1), special: !!c.special }
    else return
    addFeedItems([item])
    window.api.showNotificationBatch([item])
  }, [addFeedItems])

  const [pendingDelete, setPendingDelete] = useState(null)
  const [clearPending,  setClearPending]  = useState(false)
  const [rulesSearch,   setRulesSearch]   = useState('')

  const enabledCount = configs.filter(c => c.enabled).length
  const isEmpty      = !pairsLoading && currentSymbols.length === 0
  const draftRule = useMemo(() => ({
    symbol: [...selected][0] ?? '未选品种',
    timeframes: [...timeframes],
    requireAllTf,
    alertLevel,
    special: alertLevel >= 2,
    followTop,
    followTopLimit: 50,
    rsiAbove: rsiAbove === '' ? null : rsiAbove,
    rsiBelow: rsiBelow === '' ? null : rsiBelow,
    changeAbove: changeAbove === '' ? null : changeAbove,
    changeBelow: changeBelow === '' ? null : changeBelow,
    priceAbove: priceAbove === '' ? null : priceAbove,
    priceBelow: priceBelow === '' ? null : priceBelow,
    divBull,
    divBear,
    volumeSignal: customMode ? volumeSignal : true,
    strategies: customMode ? null : strategies,
    minScore: customMode ? null : minScore,
  }), [selected, timeframes, requireAllTf, alertLevel, followTop, rsiAbove, rsiBelow, changeAbove, changeBelow, priceAbove, priceBelow, divBull, divBear, volumeSignal, customMode, strategies, minScore])

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
              {assets.length > 0 && (
                <button className="zone-btn" style={{ fontSize: 11, padding: '2px 8px' }}
                  title="按24h成交额选择当前市场 Top50，并使用4h/1d量价策略"
                  onClick={selectTop50Alerts}>
                  Top50提醒
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
              <span className="alert-cond-label">模板</span>
              <div className="alert-tf-group">
                {RULE_TEMPLATES.map(tpl => (
                  <button key={tpl.name} className="alert-tf-btn" onClick={() => applyTemplate(tpl)}>
                    {tpl.name}
                  </button>
                ))}
              </div>
            </div>

            {Object.keys(groups).length > 0 && (
              <div className="alert-cond-row">
                <span className="alert-cond-label">分组</span>
                <div className="alert-tf-group">
                  {Object.keys(groups).map(name => (
                    <button key={name} className="alert-tf-btn" onClick={() => selectGroup(name)}>
                      {name} ({groups[name]?.length ?? 0})
                    </button>
                  ))}
                </div>
              </div>
            )}

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
                  <label className="alert-resonance-label" title="要求所选周期同时满足规则后才提醒">
                    <input type="checkbox" checked={requireAllTf}
                      onChange={e => setRequireAllTf(e.target.checked)} />
                    <span>共振</span>
                  </label>
                )}
              </div>
            </div>

            <div className="alert-cond-row">
              <span className="alert-cond-label">等级</span>
              <div className="alert-tf-group">
                {ALERT_LEVELS.map(level => (
                  <button key={level.value}
                    className={`alert-tf-btn ${alertLevel === level.value ? 'active' : ''}`}
                    onClick={() => setAlertLevel(level.value)}>
                    {level.label}
                  </button>
                ))}
              </div>
            </div>

            <div className="alert-cond-row">
              <span className="alert-cond-label">策略</span>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                <div className="alert-tf-group">
                  {STRATEGIES.map(s => (
                    <button key={s.key}
                      className={`alert-tf-btn ${!customMode && strategies.includes(s.key) ? 'active' : ''}`}
                      onClick={() => { setCustomMode(false); toggleStrategy(s.key); setMinScore(Math.max(minScore, s.score)) }}>
                      {s.label}
                    </button>
                  ))}
                  <button
                    className={`alert-tf-btn ${customMode ? 'active' : ''}`}
                    onClick={() => setCustomMode(true)}>
                    自定义
                  </button>
                </div>
                {!customMode && (
                  <label style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 12 }}>
                    <span style={{ color: 'var(--dim)' }}>最低评分</span>
                    <input className="alert-num-input" type="number" min="1" max="6"
                      style={{ width: 54 }} value={minScore}
                      onChange={e => setMinScore(Number(e.target.value) || 3)} />
                  </label>
                )}
              </div>
            </div>

            {customMode && (
            <>
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

            {(selected.size <= 1 || editingId) && (() => {
              const sym = [...selected][0]
              const currentPrice = sym ? assets.find(a => a.symbol === sym)?.price : null
              const isPct = priceMode === 'pct'
              const previewAbove = isPct && currentPrice && priceAbove !== ''
                ? parseFloat((currentPrice * (1 + parseFloat(priceAbove) / 100)).toPrecision(6))
                : null
              const previewBelow = isPct && currentPrice && priceBelow !== ''
                ? parseFloat((currentPrice * (1 - parseFloat(priceBelow) / 100)).toPrecision(6))
                : null
              return (
                <div className="alert-cond-row">
                  <span className="alert-cond-label">价格</span>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 2 }}>
                      <button
                        className={`zone-btn ${!isPct ? 'filtered' : ''}`}
                        style={{ fontSize: 10, padding: '1px 7px' }}
                        onClick={() => { setPriceMode('absolute'); setPriceAbove(''); setPriceBelow('') }}
                      >绝对价格</button>
                      <button
                        className={`zone-btn ${isPct ? 'filtered' : ''}`}
                        style={{ fontSize: 10, padding: '1px 7px' }}
                        onClick={() => { setPriceMode('pct'); setPriceAbove(''); setPriceBelow('') }}
                      >% 偏离</button>
                      {isPct && currentPrice && (
                        <span style={{ fontSize: 10, color: 'var(--dim)' }}>
                          当前 {currentPrice.toPrecision(5)}
                        </span>
                      )}
                    </div>
                    <div className="alert-cond-inputs">
                      <label className="alert-cond-input-wrap">
                        <span className="alert-cond-hint" style={{ color: '#f85149' }}>突破</span>
                        <input className="alert-num-input" type="number" min="0"
                          placeholder={isPct ? '如 +2%' : '如 50000'} value={priceAbove}
                          onChange={e => setPriceAbove(e.target.value)} />
                        {isPct && <span className="alert-cond-unit">%</span>}
                        {previewAbove != null && (
                          <span style={{ fontSize: 10, color: '#f85149', marginLeft: 4 }}>≈{previewAbove}</span>
                        )}
                      </label>
                      <label className="alert-cond-input-wrap">
                        <span className="alert-cond-hint" style={{ color: '#3fb950' }}>跌破</span>
                        <input className="alert-num-input" type="number" min="0"
                          placeholder={isPct ? '如 2%' : '如 40000'} value={priceBelow}
                          onChange={e => setPriceBelow(e.target.value)} />
                        {isPct && <span className="alert-cond-unit">%</span>}
                        {previewBelow != null && (
                          <span style={{ fontSize: 10, color: '#3fb950', marginLeft: 4 }}>≈{previewBelow}</span>
                        )}
                      </label>
                    </div>
                  </div>
                </div>
              )
            })()}
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

            <div className="alert-cond-row">
              <span className="alert-cond-label">量价</span>
              <label style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 12, cursor: 'pointer' }}
                title="只在放量突破、放量破位、价量背离等强结构信号出现时提醒">
                <input type="checkbox" checked={volumeSignal} onChange={e => setVolumeSignal(e.target.checked)} />
                <span style={{ color: '#58a6ff' }}>结构信号</span>
              </label>
            </div>
            </>
            )}

            <div className="alert-form-actions">
              <label className="alert-resonance-label" title="保存后会跟随当前成交额 Top50 自动维护提醒范围">
                <input type="checkbox" checked={followTop}
                  onChange={e => setFollowTop(e.target.checked)} />
                <span>跟随成交额 Top50</span>
              </label>
              <button className="save-btn" onClick={handleSave}
                disabled={!editingId && selected.size === 0}>
                {editingId ? '更新提醒' : selected.size > 1 ? `保存 (${selected.size} 个品种)` : '保存提醒'}
              </button>
              {editingId && (
                <button className="zone-btn" style={{ fontSize: 11 }}
                  onClick={() => { setEditingId(null); setSelected(new Set()); setAlertLevel(1); setFollowTop(false) }}>
                  取消编辑
                </button>
              )}
              {error && <span className="alert-error">{error}</span>}
            </div>
            <div className="rule-preview">
              {describeRule(draftRule, selected.size || 1)}
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
                    onClick={() => bulkSetTimeframes(['1h', '4h'])}>批量1h/4h</button>
                  <button className="zone-btn" style={{ fontSize: 11, padding: '2px 8px' }}
                    onClick={() => bulkSetTimeframes(['4h', '1d'])}>批量4h/1d</button>
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

          <div className="rules-list">
            {configs.length === 0
              ? <div className="pair-empty">暂无规则，请在左侧添加</div>
              : (() => {
                const q = rulesSearch.trim().toUpperCase()
                const filtered = q
                  ? configs.filter(c => {
                    const text = [
                      c.symbol,
                      ...getStrategyLabels(c),
                      ...(c.timeframes ?? []),
                    ].join(' ').toUpperCase()
                    return text.includes(q)
                  })
                  : configs
                if (filtered.length === 0) return <div className="pair-empty">无匹配规则</div>
                return (
                <div className="rule-card-list">
                  {filtered.map(c => {
                    const strategyLabels = getStrategyLabels(c)
                    const conditionTags = getConditionTags(c)
                    return (
                      <div key={c.id} className={`rule-card ${c.enabled ? '' : 'rule-disabled'}`}>
                        <div className="rule-card-main">
                          <div className="rule-card-title">
                            <strong className="rule-card-symbol">{c.symbol}</strong>
                            <span className="rule-chip orange">{getLevelLabel(c)}</span>
                            {c.followTop && <span className="rule-chip blue">Top{c.followTopLimit ?? 50} 跟随</span>}
                            {c.requireAllTf && <span className="rule-chip orange">共振</span>}
                            {!c.enabled && <span className="rule-chip muted">已禁用</span>}
                          </div>
                          <div className="rule-chip-row">
                            {(c.timeframes ?? []).map(tf => (
                              <span key={tf} className="rule-chip">{tf}</span>
                            ))}
                            {strategyLabels.map(label => (
                              <span key={label} className="rule-chip blue">{label}</span>
                            ))}
                            {c.minScore != null && strategyLabels.length > 0 && (
                              <span className="rule-chip">评分 ≥ {c.minScore}</span>
                            )}
                          </div>
                          <div className="rule-chip-row">
                            {conditionTags.length > 0
                              ? conditionTags.map(tag => (
                                <span key={tag.label} className={`rule-chip ${tag.tone}`}>{tag.label}</span>
                              ))
                              : <span className="rule-chip muted">无自定义阈值</span>
                            }
                          </div>
                        </div>

                        <div className="rule-card-side">
                          <div className="rule-card-stats">
                            {c.fireCount > 0
                              ? <span title={c.lastFiredAt ? `最后: ${new Date(c.lastFiredAt).toLocaleString('zh-CN')}` : ''}>
                                  触发 {c.fireCount} 次
                                </span>
                              : <span>尚未触发</span>
                            }
                          </div>
                          <label className="toggle-switch" title={c.enabled ? '禁用规则' : '启用规则'}>
                            <input type="checkbox" checked={c.enabled} onChange={() => toggle(c.id)} />
                            <span className="toggle-track" />
                          </label>
                          <button className="rule-test-btn" onClick={() => testAlert(c)} title="模拟触发一次提醒">测试</button>
                          <button className="rule-edit-btn" onClick={() => handleCopy(c)}>复制</button>
                          <button className="rule-edit-btn" onClick={() => { handleEdit(c); setPendingDelete(null) }}>编辑</button>
                          {pendingDelete === c.id ? (
                            <>
                              <button className="rule-del-btn" onClick={() => { remove(c.id); setPendingDelete(null) }}>确认</button>
                              <button className="zone-btn rule-cancel-btn" onClick={() => setPendingDelete(null)}>取消</button>
                            </>
                          ) : (
                            <button className="rule-del-btn" onClick={() => setPendingDelete(c.id)}>删除</button>
                          )}
                        </div>
                      </div>
                    )
                  })}
                </div>
                )
              })()
            }
          </div>
        </div>

      </div>
    </div>
  )
}
