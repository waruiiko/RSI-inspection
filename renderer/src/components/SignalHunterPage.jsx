import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react'
import useMarketStore from '../store/marketStore'
import useSettingsStore from '../store/settingsStore'
import { formatPrice } from '../utils/rsi'
import { formatTurnover, getQuoteVolume } from '../utils/liquidity'
import { buildSignalHunterAiCandidates, normalizeSignalHunterAiResults, signalHunterCandidateSignature } from '../utils/signalHunterAi'

const ChartModal = lazy(() => import('./ChartModal'))

const FILTERS = [
  { key: 'all', label: '全部' },
  { key: 'armed', label: '预埋' },
  { key: 'wait_entry', label: '等回踩' },
  { key: 'triggered', label: '已触发' },
  { key: 'watch', label: '观察' },
  { key: 'risk', label: '风险' },
  { key: 'rejected', label: '剔除' },
]

const SIDE_FILTERS = [
  { key: 'all', label: '全部方向' },
  { key: 'long', label: '做多' },
  { key: 'short', label: '做空' },
]

const CATEGORY_FILTERS = [
  { key: 'all', label: '全部类别' },
  { key: 'crypto', label: '加密' },
  { key: 'tradfi', label: 'TradFi' },
  { key: 'stock', label: '股票' },
]

const TIMEFRAME_FILTERS = [
  { key: 'all', label: '全部周期' },
  { key: '15m', label: '15m' },
  { key: '1h', label: '1h' },
  { key: '4h', label: '4h' },
]

const SCORE_FILTERS = [
  { key: 7, label: '7+' },
  { key: 8, label: '8+' },
  { key: 9, label: '9+' },
]

const SH_AI_CACHE_KEY = 'rsi:signalHunter:aiCache'
const SH_AI_SEEN_KEY = 'rsi:signalHunter:seen'

const STATUS_META = {
  armed: { label: '预埋', cls: 'signal-hunter-armed' },
  wait_entry: { label: '等回踩', cls: 'signal-hunter-watch' },
  wait_confirm: { label: '等确认', cls: 'signal-hunter-watch' },
  triggered: { label: '触发', cls: 'signal-hunter-triggered' },
  watch: { label: '观察', cls: 'signal-hunter-watch' },
  risk: { label: '风险', cls: 'signal-hunter-risk' },
  rejected: { label: '剔除', cls: 'signal-hunter-rejected' },
}

const SIDE_META = {
  long: { label: '做多', cls: 'signal-hunter-long' },
  short: { label: '做空', cls: 'signal-hunter-short' },
}

const SETUP_META = {
  base_long: '压缩基地多',
  base_short: '压缩基地空',
  pullback_long: 'EMA 回踩多',
  rebound_short: 'EMA 反抽空',
  retest_long: '支撑回踩多',
  retest_short: '阻力反抽空',
  confirm_long: '突破确认观察',
  confirm_short: '跌破确认观察',
}

function fmtPct(v) {
  if (v == null || Number.isNaN(v)) return '-'
  return `${v >= 0 ? '+' : ''}${Number(v).toFixed(2)}%`
}

function statusMeta(status) {
  return STATUS_META[status] ?? STATUS_META.watch
}

function sideMeta(side) {
  return SIDE_META[side] ?? SIDE_META.long
}

function categoryBadge(asset) {
  if (asset.type === 'crypto') return 'C'
  if (asset.type === 'tradfi') return 'T'
  if (asset.type === 'stock') return 'S'
  return '?'
}

function setupLabel(setup) {
  return SETUP_META[setup] ?? '结构候选'
}

function entryPriceOf(sig) {
  return Number.isFinite(sig?.entryPrice) ? sig.entryPrice : sig?.triggerPrice
}

function confirmPriceOf(sig) {
  return Number.isFinite(sig?.confirmPrice) ? sig.confirmPrice : sig?.triggerPrice
}

function targetFallback(sig, n) {
  if (Number.isFinite(sig?.[`tp${n}`])) return sig[`tp${n}`]
  const entryPrice = entryPriceOf(sig)
  if (!Number.isFinite(entryPrice) || !Number.isFinite(sig?.stopLoss)) return null
  const unit = Math.max(Math.abs(entryPrice - sig.stopLoss), entryPrice * 0.018)
  const mult = n === 1 ? 1 : n === 2 ? 1.5 : 2.2
  return sig.side === 'short'
    ? entryPrice - unit * mult
    : entryPrice + unit * mult
}

function rewardRiskFallback(sig) {
  if (Number.isFinite(sig?.score?.rewardRisk)) return sig.score.rewardRisk
  if (Number.isFinite(sig?.rewardRisk)) return sig.rewardRisk
  const target = targetFallback(sig, 2)
  const entryPrice = entryPriceOf(sig)
  if (!Number.isFinite(target) || !Number.isFinite(entryPrice) || !Number.isFinite(sig?.stopLoss)) return null
  const risk = Math.abs(entryPrice - sig.stopLoss)
  if (!risk) return null
  return Number((Math.abs(target - entryPrice) / risk).toFixed(2))
}

function livePriceOf(asset) {
  const price = Number(asset?.price)
  return Number.isFinite(price) ? price : asset?.signalHunter?.currentPrice
}

function priceDriftPct(asset) {
  const livePrice = livePriceOf(asset)
  const snapshotPrice = asset?.signalHunter?.currentPrice
  if (!Number.isFinite(livePrice) || !Number.isFinite(snapshotPrice) || !snapshotPrice) return null
  return ((livePrice - snapshotPrice) / snapshotPrice) * 100
}

function hasTradableEntrySide(sig, currentPrice = sig?.currentPrice) {
  if (sig?.rejected || sig?.status === 'rejected') return false
  const entryPrice = entryPriceOf(sig)
  if (!Number.isFinite(entryPrice) || !Number.isFinite(currentPrice)) return false
  return sig.side === 'short'
    ? entryPrice >= currentPrice * 0.999
    : entryPrice <= currentPrice * 1.001
}

function visibleSignal(sig, showRejected, scoreThreshold = 7, currentPrice = sig?.currentPrice) {
  if (!sig) return false
  if (sig.rejected || sig.status === 'rejected') return showRejected
  if (!hasTradableEntrySide(sig, currentPrice)) return false
  if ((sig.score?.total ?? 0) < scoreThreshold) return false
  const rewardRisk = rewardRiskFallback(sig)
  return Number.isFinite(rewardRisk) && rewardRisk >= 1.5
}

function distanceToEntryOf(sig, currentPrice = sig?.currentPrice) {
  const entryPrice = entryPriceOf(sig)
  if (!Number.isFinite(entryPrice) || !Number.isFinite(currentPrice) || !currentPrice) return null
  return ((entryPrice - currentPrice) / currentPrice) * 100
}

function scoreClass(score) {
  if (score >= 8) return 'hot'
  if (score >= 6.5) return 'strong'
  return ''
}

function signalKey(asset) {
  return `${asset.source}:${asset.apiSymbol ?? asset.symbol}`
}

function loadJson(key, fallback) {
  try {
    const raw = localStorage.getItem(key)
    return raw ? JSON.parse(raw) : fallback
  } catch {
    return fallback
  }
}

function saveJson(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value))
  } catch {}
}

function loadSeenKeys() {
  return new Set(loadJson(SH_AI_SEEN_KEY, []))
}

function signalSeenKey(asset) {
  const sig = asset?.signalHunter
  const entry = entryPriceOf(sig)
  return [
    asset?.key ?? signalKey(asset),
    sig?.side ?? '',
    sig?.timeframe ?? '',
    Number.isFinite(entry) ? Number(entry).toPrecision(8) : '',
    sig?.score?.total ?? '',
  ].join('|')
}

function formatAiTime(ts) {
  if (!ts) return '-'
  return new Date(ts).toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })
}

export default function SignalHunterPage() {
  const assets = useMarketStore(s => s.assets)
  const updatedAt = useMarketStore(s => s.updatedAt)
  const applySignalHunterAiResults = useMarketStore(s => s.applySignalHunterAiResults)
  const shAiInterval = useSettingsStore(s => s.shAiInterval ?? 30)
  const [filter, setFilter] = useState('all')
  const [sideFilter, setSideFilter] = useState('all')
  const [categoryFilter, setCategoryFilter] = useState('all')
  const [timeframeFilter, setTimeframeFilter] = useState('all')
  const [scoreThreshold, setScoreThreshold] = useState(7)
  const [showRejected, setShowRejected] = useState(false)
  const [showNewOnly, setShowNewOnly] = useState(false)
  const [hideDrifted, setHideDrifted] = useState(true)
  const [query, setQuery] = useState('')
  const [expanded, setExpanded] = useState(null)
  const [chartAsset, setChartAsset] = useState(null)
  const [chartSignal, setChartSignal] = useState(null)
  const [aiBusy, setAiBusy] = useState(false)
  const [aiStatus, setAiStatus] = useState('')
  const [aiRunMeta, setAiRunMeta] = useState(() => loadJson(SH_AI_CACHE_KEY, null)?.meta ?? null)
  const [seenKeys, setSeenKeys] = useState(() => loadSeenKeys())
  const aiBusyRef = useRef(false)
  const lastAiSignatureRef = useRef('')
  const pendingAutoRef = useRef(false)
  const appliedCacheRef = useRef('')

  function markSeen(asset) {
    const key = signalSeenKey(asset)
    setSeenKeys(prev => {
      if (prev.has(key)) return prev
      const next = new Set(prev)
      next.add(key)
      saveJson(SH_AI_SEEN_KEY, [...next])
      return next
    })
  }

  const openChart = (asset) => {
    markSeen(asset)
    setChartAsset(asset)
    setChartSignal(asset.signalHunter ?? null)
  }

  const closeChart = () => {
    setChartAsset(null)
    setChartSignal(null)
  }

  const runAiSignalHunter = async ({ auto = false } = {}) => {
    if (!window.api?.runCodexScreen) return
    if (aiBusyRef.current) {
      if (auto) pendingAutoRef.current = true
      return
    }
    const candidates = buildSignalHunterAiCandidates(assets, 60)
    const signature = signalHunterCandidateSignature(candidates)
    if (auto && (!signature || signature === lastAiSignatureRef.current)) return
    if (!candidates.length) {
      if (!auto) setAiStatus('没有可送入 AI 的候选快照')
      return
    }
    aiBusyRef.current = true
    setAiBusy(true)
    setAiStatus(`${auto ? 'AI 自动识别' : 'AI 正在识别'} ${candidates.length} 个候选...`)
    try {
      const payload = {
        scope: 'signal-hunter',
        createdAt: new Date().toISOString(),
        updatedAt,
        note: 'Signal Hunter AI 只识别形态结构、方向、关键位和风险，不输出交易建议。',
        candidates,
      }
      const res = await window.api.runCodexScreen(payload)
      if (!res?.ok || !res.result) throw new Error(res?.parseError || res?.error || 'AI 未返回有效 JSON')
      const normalized = normalizeSignalHunterAiResults(res.result, assets)
      applySignalHunterAiResults(normalized)
      const live = normalized.filter(item => item.signalHunter?.status !== 'rejected').length
      const meta = {
        runAt: Date.now(),
        snapshotAt: updatedAt ?? Date.now(),
        total: normalized.length,
        live,
        candidateSignature: signature,
      }
      saveJson(SH_AI_CACHE_KEY, { meta, items: normalized })
      setAiRunMeta(meta)
      lastAiSignatureRef.current = signature
      setAiStatus(`AI 已写入 ${live}/${normalized.length} 个 SH 结果`)
    } catch (err) {
      setAiStatus(`AI 识别失败：${err.message}`)
    } finally {
      aiBusyRef.current = false
      setAiBusy(false)
      if (pendingAutoRef.current) {
        pendingAutoRef.current = false
        setTimeout(() => runAiSignalHunter({ auto: true }), 250)
      }
    }
  }

  useEffect(() => {
    if (!updatedAt || !assets.length) return
    const intervalMs = Math.max(1, Number(shAiInterval) || 30) * 60 * 1000
    const lastRunAt = aiRunMeta?.runAt ?? loadJson(SH_AI_CACHE_KEY, null)?.meta?.runAt ?? 0
    if (lastRunAt && Date.now() - lastRunAt < intervalMs) return
    const timer = setTimeout(() => runAiSignalHunter({ auto: true }), 600)
    return () => clearTimeout(timer)
  }, [updatedAt, assets.length, shAiInterval])

  useEffect(() => {
    if (!assets.length) return
    const cached = loadJson(SH_AI_CACHE_KEY, null)
    if (!cached?.items?.length) return
    const cacheKey = `${cached.meta?.runAt ?? ''}:${assets.length}`
    if (appliedCacheRef.current === cacheKey) return
    appliedCacheRef.current = cacheKey
    applySignalHunterAiResults(cached.items)
    setAiRunMeta(cached.meta ?? null)
    if (cached.meta?.candidateSignature) lastAiSignatureRef.current = cached.meta.candidateSignature
  }, [assets.length, applySignalHunterAiResults])

  const rows = useMemo(() => {
    const q = query.trim().toUpperCase()
    return assets
      .filter(asset => asset.signalHunter)
      .filter(asset => filter === 'all' || asset.signalHunter.status === filter)
      .filter(asset => sideFilter === 'all' || asset.signalHunter.side === sideFilter)
      .filter(asset => categoryFilter === 'all' || asset.type === categoryFilter)
      .filter(asset => timeframeFilter === 'all' || asset.signalHunter.timeframe === timeframeFilter)
      .filter(asset => visibleSignal(asset.signalHunter, showRejected, scoreThreshold, livePriceOf(asset)))
      .filter(asset => !q || asset.symbol.toUpperCase().includes(q))
      .filter(asset => !showNewOnly || !seenKeys.has(signalSeenKey(asset)))
      .filter(asset => !hideDrifted || showRejected || Math.abs(priceDriftPct(asset) ?? 0) < 3)
      .sort((a, b) => {
        const newDelta = Number(!seenKeys.has(signalSeenKey(b))) - Number(!seenKeys.has(signalSeenKey(a)))
        if (newDelta) return newDelta
        const driftDelta = Number(Math.abs(priceDriftPct(a) ?? 0) >= 1.5) - Number(Math.abs(priceDriftPct(b) ?? 0) >= 1.5)
        if (driftDelta) return driftDelta
        const sa = a.signalHunter?.score?.total ?? 0
        const sb = b.signalHunter?.score?.total ?? 0
        if (sb !== sa) return sb - sa
        return Math.abs(distanceToEntryOf(a.signalHunter, livePriceOf(a)) ?? 99) -
          Math.abs(distanceToEntryOf(b.signalHunter, livePriceOf(b)) ?? 99)
      })
      .slice(0, 120)
  }, [assets, filter, sideFilter, categoryFilter, timeframeFilter, scoreThreshold, showRejected, query, showNewOnly, hideDrifted, seenKeys])

  const newVisibleCount = useMemo(
    () => rows.filter(asset => !seenKeys.has(signalSeenKey(asset))).length,
    [rows, seenKeys],
  )

  const markVisibleSeen = () => {
    setSeenKeys(prev => {
      const next = new Set(prev)
      for (const asset of rows) next.add(signalSeenKey(asset))
      saveJson(SH_AI_SEEN_KEY, [...next])
      return next
    })
  }

  const summary = useMemo(() => {
    const all = assets.filter(asset => visibleSignal(asset.signalHunter, false, scoreThreshold, livePriceOf(asset)))
    return {
      total: all.length,
      armed: all.filter(a => a.signalHunter.status === 'armed').length,
      triggered: all.filter(a => a.signalHunter.status === 'triggered').length,
      risk: all.filter(a => a.signalHunter.status === 'risk').length,
    }
  }, [assets, scoreThreshold])

  return (
    <div className="page signal-hunter-page">
      <div className="signal-hunter-head">
        <div>
          <h2>Signal Hunter</h2>
          <p>形态候选雷达：只提示临界结构、方向、关键位和风险，不给交易结论。</p>
        </div>
        <div className="signal-hunter-summary">
          <div><b>{summary.total}</b><span>候选</span></div>
          <div><b>{summary.armed}</b><span>预埋</span></div>
          <div><b>{summary.triggered}</b><span>触发</span></div>
          <div><b>{summary.risk}</b><span>风险</span></div>
        </div>
      </div>

      <div className="signal-hunter-controls">
        <div className="feed-type-btns">
          {FILTERS.map(item => (
            <button
              key={item.key}
              className={`feed-type-btn ${filter === item.key ? 'active' : ''}`}
              onClick={() => setFilter(item.key)}
            >
              {item.label}
            </button>
          ))}
        </div>
        <div className="feed-type-btns">
          {SIDE_FILTERS.map(item => (
            <button
              key={item.key}
              className={`feed-type-btn ${sideFilter === item.key ? 'active' : ''}`}
              onClick={() => setSideFilter(item.key)}
            >
              {item.label}
            </button>
          ))}
        </div>
        <div className="feed-type-btns">
          {CATEGORY_FILTERS.map(item => (
            <button
              key={item.key}
              className={`feed-type-btn ${categoryFilter === item.key ? 'active' : ''}`}
              onClick={() => setCategoryFilter(item.key)}
            >
              {item.label}
            </button>
          ))}
        </div>
        <div className="feed-type-btns">
          {TIMEFRAME_FILTERS.map(item => (
            <button
              key={item.key}
              className={`feed-type-btn ${timeframeFilter === item.key ? 'active' : ''}`}
              onClick={() => setTimeframeFilter(item.key)}
            >
              {item.label}
            </button>
          ))}
        </div>
        <div className="feed-type-btns">
          {SCORE_FILTERS.map(item => (
            <button
              key={item.key}
              className={`feed-type-btn ${scoreThreshold === item.key ? 'active' : ''}`}
              onClick={() => setScoreThreshold(item.key)}
            >
              {item.label}
            </button>
          ))}
        </div>
        <input
          type="search"
          className="search-input signal-hunter-search"
          placeholder="搜索品种..."
          value={query}
          onChange={e => setQuery(e.target.value)}
        />
        <label className="signal-hunter-debug">
          <input
            type="checkbox"
            checked={showRejected}
            onChange={e => setShowRejected(e.target.checked)}
          />
          剔除原因
        </label>
        <button
          className={`feed-type-btn ${showNewOnly ? 'active' : ''}`}
          onClick={() => setShowNewOnly(v => !v)}
        >
          只看新结果{newVisibleCount ? ` ${newVisibleCount}` : ''}
        </button>
        <button className="feed-type-btn" onClick={markVisibleSeen} disabled={!rows.length}>
          标记已看
        </button>
        <button
          className={`feed-type-btn ${hideDrifted ? 'active' : ''}`}
          onClick={() => setHideDrifted(v => !v)}
        >
          隐藏漂移
        </button>
        <button className="zone-btn signal-hunter-ai-btn" onClick={() => runAiSignalHunter()} disabled={aiBusy || !assets.length}>
          {aiBusy ? 'AI识别中' : 'AI识别SH'}
        </button>
        {aiStatus && <span className="signal-hunter-ai-status">{aiStatus}</span>}
      </div>

      {aiRunMeta && (
        <div className="signal-hunter-ai-meta">
          <span>AI识别 {formatAiTime(aiRunMeta.runAt)}</span>
          <span>行情快照 {formatAiTime(aiRunMeta.snapshotAt)}</span>
          <span>写入 {aiRunMeta.live}/{aiRunMeta.total}</span>
        </div>
      )}

      <div className="signal-hunter-table-wrap">
        <table className="stats-table signal-hunter-table">
          <thead>
            <tr>
              <th className="signal-hunter-index">#</th>
              <th>品种</th>
              <th>状态</th>
              <th>方向</th>
              <th>周期</th>
              <th>现价</th>
              <th>入场价</th>
              <th>距离</th>
              <th>评分</th>
              <th>关键位</th>
              <th>风险</th>
              <th>原因</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            {!rows.length ? (
              <tr>
                <td colSpan={13} className="ai-empty">暂无 Signal Hunter 候选。刷新行情后会根据合约资金结构和短线压缩自动筛选。</td>
              </tr>
            ) : rows.map((asset, index) => {
              const sig = asset.signalHunter
              const key = signalKey(asset)
              const meta = statusMeta(sig.status)
              const side = sideMeta(sig.side)
              const t1 = targetFallback(sig, 1)
              const t2 = targetFallback(sig, 2)
              const t3 = targetFallback(sig, 3)
              const rewardRisk = rewardRiskFallback(sig)
              const entryPrice = entryPriceOf(sig)
              const confirmPrice = confirmPriceOf(sig)
              const livePrice = livePriceOf(asset)
              const drift = priceDriftPct(asset)
              const stale = Number.isFinite(drift) && Math.abs(drift) >= 1.5
              const distanceToEntry = distanceToEntryOf(sig, livePrice)
              const rejected = sig.rejected || sig.status === 'rejected'
              const isNew = !seenKeys.has(signalSeenKey(asset))
              return (
                <>
                  <tr key={key} onDoubleClick={() => openChart(asset)}>
                    <td className="signal-hunter-index">{index + 1}</td>
                    <td>
                      <button className="symbol-link-btn" onClick={() => openChart(asset)}>
                        {asset.symbol}
                      </button>
                      <span className={`badge badge-${asset.type}`}>{categoryBadge(asset)}</span>
                      {isNew && <span className="signal-hunter-new-badge">新</span>}
                      {stale && <span className="signal-hunter-stale-badge">漂</span>}
                      <small>{formatTurnover(getQuoteVolume(asset))}</small>
                    </td>
                    <td><span className={`signal-hunter-status ${meta.cls}`}>{meta.label}</span></td>
                    <td><span className={`signal-hunter-side ${side.cls}`}>{side.label}</span></td>
                    <td>{sig.timeframe}</td>
                    <td>
                      {formatPrice(livePrice)}
                      {Number.isFinite(drift) && Math.abs(drift) >= 0.5 && <small>识别后 {fmtPct(drift)}</small>}
                    </td>
                    <td>{rejected ? '-' : formatPrice(entryPrice)}</td>
                    <td className={distanceToEntry <= 0 ? 'pos' : ''}>{fmtPct(distanceToEntry)}</td>
                    <td>
                      <div className={`signal-hunter-score ${scoreClass(sig.score.total)}`}>{sig.score.total}/10</div>
                      <div className="signal-hunter-factors">
                        <span>图 {sig.score.chart}</span>
                        <span>数 {sig.score.data}</span>
                        <span>R {rewardRisk ? rewardRisk.toFixed(1) : '-'}</span>
                        <span>风 {sig.score.risk}</span>
                      </div>
                    </td>
                    <td>
                      <div>入场 {rejected ? '-' : formatPrice(entryPrice)}</div>
                      <small>确认 {formatPrice(confirmPrice)} <span className="muted">{fmtPct(sig.distanceToConfirmPct)}</span></small>
                      <small>失效 {formatPrice(sig.stopLoss)} <span className="muted">{fmtPct(sig.stopLossPct)}</span></small>
                      {!rejected && <small>目标 {formatPrice(t1)} / {formatPrice(t2)} / {formatPrice(t3)}</small>}
                      <small>形态 {sig.setupLabel || setupLabel(sig.setup)} <span className="muted">{rewardRisk ? `${rewardRisk.toFixed(1)}R` : ''}</span></small>
                    </td>
                    <td>
                      {sig.riskFlags?.length ? (
                        <div className="signal-hunter-risks">
                          {stale && <span>价格漂移 {fmtPct(drift)}</span>}
                          {sig.riskFlags.map(flag => <span key={flag}>{flag}</span>)}
                        </div>
                      ) : sig.rejectReasons?.length ? (
                        <div className="signal-hunter-risks">
                          {stale && <span>价格漂移 {fmtPct(drift)}</span>}
                          {sig.rejectReasons.map(reason => <span key={reason}>{reason}</span>)}
                        </div>
                      ) : stale ? (
                        <div className="signal-hunter-risks"><span>价格漂移 {fmtPct(drift)}</span></div>
                      ) : <span className="muted">-</span>}
                    </td>
                    <td>
                      <div className="signal-hunter-reasons">
                        {sig.reasons?.map(reason => <span key={reason}>{reason}</span>)}
                      </div>
                    </td>
                    <td>
                      <div className="signal-hunter-actions">
                        <button className="zone-btn" onClick={() => openChart(asset)}>K线</button>
                        <button className="zone-btn" onClick={() => {
                          markSeen(asset)
                          setExpanded(expanded === key ? null : key)
                        }}>
                          详情
                        </button>
                      </div>
                    </td>
                  </tr>
                  {expanded === key && (
                    <tr className="signal-hunter-detail-row" key={`${key}:detail`}>
                      <td colSpan={13}>
                        <div className="signal-hunter-detail">
                          <div>
                            <b>判定链</b>
                            <span>{sig.setupLabel || setupLabel(sig.setup)} → {side.label} → {meta.label}</span>
                            <span>{rejected ? `剔除：${sig.rejectReasons?.join(' / ') || '-'}` : '通过：位置、评分、R 值均达标'}</span>
                          </div>
                          <div>
                            <b>关键价格</b>
                            <span>现价 {formatPrice(livePrice)} / 识别价 {formatPrice(sig.currentPrice)} / 入场 {rejected ? '-' : formatPrice(entryPrice)}</span>
                            <span>确认 {formatPrice(confirmPrice)} / 失效 {formatPrice(sig.stopLoss)}</span>
                            {!rejected && <span>TP {formatPrice(t1)} / {formatPrice(t2)} / {formatPrice(t3)}</span>}
                          </div>
                          <div>
                            <b>评分</b>
                            <span>总分 {sig.score.total}/10</span>
                            <span>图表 {sig.score.chart} / 数据 {sig.score.data} / R {rewardRisk ? rewardRisk.toFixed(1) : '-'} / 风险 {sig.score.risk}</span>
                            <span>权重 图表4 数据2 R2 风控2</span>
                          </div>
                          <div>
                            <b>依据</b>
                            <span>{sig.reasons?.length ? sig.reasons.join(' / ') : '-'}</span>
                            <span>{sig.riskFlags?.length ? `风险：${sig.riskFlags.join(' / ')}` : '风险：-'}</span>
                          </div>
                        </div>
                      </td>
                    </tr>
                  )}
                </>
              )
            })}
          </tbody>
        </table>
      </div>

      {chartAsset && (
        <Suspense fallback={null}>
          <ChartModal
            asset={chartAsset}
            alertItem={chartSignal ? { timeframe: chartSignal.timeframe, signalHunter: chartSignal } : null}
            onClose={closeChart}
          />
        </Suspense>
      )}
    </div>
  )
}
