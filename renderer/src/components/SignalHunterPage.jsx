import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react'
import useMarketStore from '../store/marketStore'
import useSettingsStore from '../store/settingsStore'
import { formatPrice } from '../utils/rsi'
import { formatTurnover, getQuoteVolume } from '../utils/liquidity'
import { buildSignalHunterAiCandidates, hasExecutableStopDistance, minExecutableStopDistance, normalizeSignalHunterAiResults, signalHunterCandidateSignature } from '../utils/signalHunterAi'

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
  { key: '1h', label: '1h' },
  { key: '4h', label: '4h' },
]

const SCORE_FILTERS = [
  { key: 7, label: '7+' },
  { key: 8, label: '8+' },
  { key: 9, label: '9+' },
]

const SORT_MODES = [
  { key: 'execution', label: '执行优先' },
  { key: 'score', label: '高评分' },
  { key: 'entry', label: '近入场' },
]

const EXECUTION_FILTERS = [
  { key: 'all', label: '全部执行' },
  { key: 'ready', label: '可盯' },
  { key: 'wait', label: '等待' },
  { key: 'risk', label: '风险' },
]

const ACTIONABLE_TIMEFRAMES = new Set(['1h', '4h'])

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

function stopDistanceInfo(asset, sig) {
  const entryPrice = entryPriceOf(sig)
  const stopLoss = sig?.stopLoss
  if (!Number.isFinite(entryPrice) || !Number.isFinite(stopLoss) || !entryPrice) return null
  const distance = Math.abs(entryPrice - stopLoss)
  const pct = (distance / entryPrice) * 100
  const minDistance = minExecutableStopDistance(asset, sig)
  return {
    distance,
    pct,
    minDistance,
    ok: !Number.isFinite(minDistance) || distance >= minDistance,
  }
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

function visibleSignal(asset, showRejected, scoreThreshold = 7, currentPrice = asset?.signalHunter?.currentPrice) {
  const sig = asset?.signalHunter
  if (!sig) return false
  if (!ACTIONABLE_TIMEFRAMES.has(sig.timeframe)) return false
  if (sig.rejected || sig.status === 'rejected') return showRejected
  if (!hasExecutableStopDistance(asset, sig)) return false
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

function absDistanceToEntry(asset) {
  const distance = distanceToEntryOf(asset?.signalHunter, livePriceOf(asset))
  return Number.isFinite(distance) ? Math.abs(distance) : 99
}

function statusRank(status) {
  if (status === 'triggered') return 0
  if (status === 'armed') return 1
  if (status === 'wait_entry') return 2
  if (status === 'wait_confirm') return 3
  if (status === 'watch') return 4
  if (status === 'risk') return 5
  return 6
}

function executionMeta(asset) {
  const sig = asset?.signalHunter
  if (!sig) return { key: 'wait', label: '等待', cls: 'signal-hunter-exec-wait', rank: 3 }
  if (sig.rejected || sig.status === 'rejected') {
    return { key: 'rejected', label: '剔除', cls: 'signal-hunter-exec-muted', rank: 9 }
  }
  const drift = Math.abs(priceDriftPct(asset) ?? 0)
  const stopInfo = stopDistanceInfo(asset, sig)
  if (sig.status === 'risk' || drift >= 1.5 || stopInfo?.ok === false) {
    return { key: 'risk', label: '风险', cls: 'signal-hunter-exec-risk', rank: 6 }
  }
  const entryDistance = absDistanceToEntry(asset)
  if (sig.status === 'triggered' || (sig.status === 'armed' && entryDistance <= 0.75)) {
    return { key: 'ready', label: '可盯', cls: 'signal-hunter-exec-ready', rank: 0 }
  }
  return { key: 'wait', label: '等待', cls: 'signal-hunter-exec-wait', rank: 3 }
}

function scoreClass(score) {
  if (score >= 8) return 'hot'
  if (score >= 6.5) return 'strong'
  return ''
}

function buildEmptyDiagnostics(assets, {
  filter,
  sideFilter,
  categoryFilter,
  timeframeFilter,
  scoreThreshold,
  showRejected,
  query,
  showNewOnly,
  hideDrifted,
  seenKeys,
}) {
  const q = query.trim().toUpperCase()
  const base = assets.filter(asset => asset.signalHunter)
  const byStatus = base.filter(asset => filter === 'all' || asset.signalHunter.status === filter)
  const bySide = byStatus.filter(asset => sideFilter === 'all' || asset.signalHunter.side === sideFilter)
  const byCategory = bySide.filter(asset => categoryFilter === 'all' || asset.type === categoryFilter)
  const byTimeframe = byCategory.filter(asset => timeframeFilter === 'all' || asset.signalHunter.timeframe === timeframeFilter)
  const byActionableTf = byTimeframe.filter(asset => ACTIONABLE_TIMEFRAMES.has(asset.signalHunter.timeframe))
  const byExecutableStop = byActionableTf.filter(asset => {
    const sig = asset.signalHunter
    return showRejected && (sig.rejected || sig.status === 'rejected')
      ? true
      : hasExecutableStopDistance(asset, sig)
  })
  const byEntrySide = byExecutableStop.filter(asset => {
    const sig = asset.signalHunter
    return showRejected && (sig.rejected || sig.status === 'rejected')
      ? true
      : hasTradableEntrySide(sig, livePriceOf(asset))
  })
  const byScore = byEntrySide.filter(asset => {
    const sig = asset.signalHunter
    return showRejected && (sig.rejected || sig.status === 'rejected')
      ? true
      : (sig.score?.total ?? 0) >= scoreThreshold
  })
  const byRewardRisk = byScore.filter(asset => {
    const sig = asset.signalHunter
    if (showRejected && (sig.rejected || sig.status === 'rejected')) return true
    const rewardRisk = rewardRiskFallback(sig)
    return Number.isFinite(rewardRisk) && rewardRisk >= 1.5
  })
  const byQuality = byRewardRisk
  const byQuery = byQuality.filter(asset => !q || asset.symbol.toUpperCase().includes(q))
  const byNew = byQuery.filter(asset => !showNewOnly || !seenKeys.has(signalSeenKey(asset)))
  const byDrift = byNew.filter(asset => !hideDrifted || showRejected || Math.abs(priceDriftPct(asset) ?? 0) < 3)
  return {
    ai: base.length,
    status: byStatus.length,
    side: bySide.length,
    category: byCategory.length,
    timeframe: byTimeframe.length,
    actionableTf: byActionableTf.length,
    executableStop: byExecutableStop.length,
    entrySide: byEntrySide.length,
    score: byScore.length,
    rewardRisk: byRewardRisk.length,
    quality: byQuality.length,
    query: byQuery.length,
    fresh: byNew.length,
    visible: byDrift.length,
  }
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

async function copyText(text) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text)
    return
  }
  const el = document.createElement('textarea')
  el.value = text
  el.setAttribute('readonly', '')
  el.style.position = 'fixed'
  el.style.left = '-9999px'
  document.body.appendChild(el)
  el.select()
  document.execCommand('copy')
  document.body.removeChild(el)
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

function signalPlanText(asset) {
  const sig = asset?.signalHunter
  if (!sig) return ''
  const meta = statusMeta(sig.status)
  const side = sideMeta(sig.side)
  const exec = executionMeta(asset)
  const livePrice = livePriceOf(asset)
  const entryPrice = entryPriceOf(sig)
  const confirmPrice = confirmPriceOf(sig)
  const stopInfo = stopDistanceInfo(asset, sig)
  const rewardRisk = rewardRiskFallback(sig)
  const t1 = targetFallback(sig, 1)
  const t2 = targetFallback(sig, 2)
  const t3 = targetFallback(sig, 3)
  const drift = priceDriftPct(asset)
  const riskLines = [
    Number.isFinite(drift) && Math.abs(drift) >= 0.5 ? `价格漂移 ${fmtPct(drift)}` : null,
    ...(sig.riskFlags ?? []),
    ...(sig.rejectReasons ?? []),
  ].filter(Boolean)
  return [
    `[Signal Hunter] ${asset.symbol} ${sig.timeframe} ${side.label} · ${meta.label} · ${exec.label}`,
    `现价: ${formatPrice(livePrice)}`,
    `入场: ${formatPrice(entryPrice)} | 确认: ${formatPrice(confirmPrice)} | 失效: ${formatPrice(sig.stopLoss)}`,
    `目标: ${formatPrice(t1)} / ${formatPrice(t2)} / ${formatPrice(t3)} | R: ${Number.isFinite(rewardRisk) ? rewardRisk.toFixed(1) : '-'}`,
    stopInfo
      ? `风险宽: ${formatPrice(stopInfo.distance)} (${stopInfo.pct.toFixed(1)}%)${Number.isFinite(stopInfo.minDistance) ? ` | 最小可执行: ${formatPrice(stopInfo.minDistance)}` : ''}`
      : '风险宽: -',
    `评分: ${sig.score?.total ?? '-'}/10 | 图表 ${sig.score?.chart ?? '-'}/10 | 数据 ${sig.score?.data ?? '-'}/10 | 风险 ${sig.score?.risk ?? '-'}`,
    `形态: ${sig.setupLabel || setupLabel(sig.setup)}`,
    `依据: ${sig.reasons?.length ? sig.reasons.join(' / ') : '-'}`,
    `风险: ${riskLines.length ? riskLines.join(' / ') : '-'}`,
    '备注: SH 只做结构参考，不是自动下单指令；执行前重新确认 1h/4h K 线和流动性。',
  ].join('\n')
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
  const [stockFocus, setStockFocus] = useState(true)
  const [sortMode, setSortMode] = useState('execution')
  const [executionFilter, setExecutionFilter] = useState('all')
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
    setChartAsset(asset)
    setChartSignal(asset.signalHunter ?? null)
  }

  const closeChart = () => {
    setChartAsset(null)
    setChartSignal(null)
  }

  const copyPlan = async (asset) => {
    try {
      await copyText(signalPlanText(asset))
      markSeen(asset)
      setAiStatus(`已复制 ${asset.symbol} 的 SH 计划`)
    } catch (err) {
      setAiStatus(`复制失败：${err.message}`)
    }
  }

  const copyVisiblePlans = async () => {
    const picked = rows.slice(0, 10)
    if (!picked.length) return
    try {
      const header = [
        `Signal Hunter Watchlist · ${new Date().toLocaleString('zh-CN')}`,
        `筛选: ${categoryFilter}/${timeframeFilter}/${sideFilter} · ${scoreThreshold}+ · ${executionFilter} · ${sortMode}`,
        `数量: ${picked.length}/${rows.length}`,
      ].join('\n')
      await copyText([header, ...picked.map(signalPlanText)].join('\n\n---\n\n'))
      setSeenKeys(prev => {
        const next = new Set(prev)
        for (const asset of picked) next.add(signalSeenKey(asset))
        saveJson(SH_AI_SEEN_KEY, [...next])
        return next
      })
      setAiStatus(`已复制当前前 ${picked.length} 条 SH watchlist`)
    } catch (err) {
      setAiStatus(`复制失败：${err.message}`)
    }
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
      .filter(asset => visibleSignal(asset, showRejected, scoreThreshold, livePriceOf(asset)))
      .filter(asset => executionFilter === 'all' || executionMeta(asset).key === executionFilter)
      .filter(asset => !q || asset.symbol.toUpperCase().includes(q))
      .filter(asset => !showNewOnly || !seenKeys.has(signalSeenKey(asset)))
      .filter(asset => !hideDrifted || showRejected || Math.abs(priceDriftPct(asset) ?? 0) < 3)
      .sort((a, b) => {
        const newDelta = Number(!seenKeys.has(signalSeenKey(b))) - Number(!seenKeys.has(signalSeenKey(a)))
        if (newDelta) return newDelta
        const driftDelta = Number(Math.abs(priceDriftPct(a) ?? 0) >= 1.5) - Number(Math.abs(priceDriftPct(b) ?? 0) >= 1.5)
        if (driftDelta) return driftDelta
        if (sortMode === 'entry') return absDistanceToEntry(a) - absDistanceToEntry(b)
        const sa = a.signalHunter?.score?.total ?? 0
        const sb = b.signalHunter?.score?.total ?? 0
        if (sortMode === 'score') {
          if (sb !== sa) return sb - sa
          return absDistanceToEntry(a) - absDistanceToEntry(b)
        }
        if (stockFocus) {
          const rank = asset => asset.type === 'stock' ? 0 : asset.type === 'tradfi' ? 1 : 2
          const categoryDelta = rank(a) - rank(b)
          if (categoryDelta) return categoryDelta
        }
        const executionDelta = executionMeta(a).rank - executionMeta(b).rank
        if (executionDelta) return executionDelta
        const statusDelta = statusRank(a.signalHunter?.status) - statusRank(b.signalHunter?.status)
        if (statusDelta) return statusDelta
        const entryDelta = absDistanceToEntry(a) - absDistanceToEntry(b)
        if (Math.abs(entryDelta) > 0.25) return entryDelta
        if (sb !== sa) return sb - sa
        return (rewardRiskFallback(b.signalHunter) ?? 0) - (rewardRiskFallback(a.signalHunter) ?? 0)
      })
      .slice(0, 120)
  }, [assets, filter, sideFilter, categoryFilter, timeframeFilter, scoreThreshold, stockFocus, sortMode, executionFilter, showRejected, query, showNewOnly, hideDrifted, seenKeys])

  const emptyDiagnostics = useMemo(() => buildEmptyDiagnostics(assets, {
    filter,
    sideFilter,
    categoryFilter,
    timeframeFilter,
    scoreThreshold,
    showRejected,
    query,
    showNewOnly,
    hideDrifted,
    seenKeys,
  }), [assets, filter, sideFilter, categoryFilter, timeframeFilter, scoreThreshold, showRejected, query, showNewOnly, hideDrifted, seenKeys])

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

  const clearAiCache = () => {
    saveJson(SH_AI_CACHE_KEY, null)
    saveJson(SH_AI_SEEN_KEY, [])
    setAiRunMeta(null)
    setSeenKeys(new Set())
    lastAiSignatureRef.current = ''
    appliedCacheRef.current = ''
    setAiStatus('SH 缓存已清空，下一次识别会按 1h/4h 重新生成')
  }

  const resetFilters = () => {
    setFilter('all')
    setSideFilter('all')
    setCategoryFilter('all')
    setTimeframeFilter('all')
    setScoreThreshold(7)
    setStockFocus(true)
    setSortMode('execution')
    setExecutionFilter('all')
    setShowRejected(false)
    setShowNewOnly(false)
    setHideDrifted(false)
    setQuery('')
  }

  const summary = useMemo(() => {
    const all = assets.filter(asset => visibleSignal(asset, false, scoreThreshold, livePriceOf(asset)))
    const scoreSum = all.reduce((sum, asset) => sum + (asset.signalHunter?.score?.total ?? 0), 0)
    return {
      total: all.length,
      ready: all.filter(asset => executionMeta(asset).key === 'ready').length,
      wait: all.filter(asset => executionMeta(asset).key === 'wait').length,
      stocks: all.filter(asset => asset.type === 'stock').length,
      avgScore: all.length ? (scoreSum / all.length).toFixed(1) : '-',
    }
  }, [assets, scoreThreshold])

  return (
    <div className="page signal-hunter-page">
      <div className="signal-hunter-head">
        <div>
          <h2>Signal Hunter</h2>
          <p>形态候选雷达：只保留 1h / 4h 可执行结构，15m 仅作为背景数据。</p>
        </div>
        <div className="signal-hunter-summary">
          <div><b>{summary.total}</b><span>候选</span></div>
          <div><b>{summary.ready}</b><span>可盯</span></div>
          <div><b>{summary.wait}</b><span>等待</span></div>
          <div><b>{summary.stocks}</b><span>股票</span></div>
          <div><b>{summary.avgScore}</b><span>均分</span></div>
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
        <button
          className={`feed-type-btn ${stockFocus ? 'active' : ''}`}
          onClick={() => setStockFocus(v => !v)}
        >
          Stock Focus
        </button>
        <div className="feed-type-btns">
          {SORT_MODES.map(item => (
            <button
              key={item.key}
              className={`feed-type-btn ${sortMode === item.key ? 'active' : ''}`}
              onClick={() => setSortMode(item.key)}
            >
              {item.label}
            </button>
          ))}
        </div>
        <div className="feed-type-btns">
          {EXECUTION_FILTERS.map(item => (
            <button
              key={item.key}
              className={`feed-type-btn ${executionFilter === item.key ? 'active' : ''}`}
              onClick={() => setExecutionFilter(item.key)}
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
        <button className="feed-type-btn" onClick={copyVisiblePlans} disabled={!rows.length}>
          复制前10
        </button>
        <button
          className={`feed-type-btn ${hideDrifted ? 'active' : ''}`}
          onClick={() => setHideDrifted(v => !v)}
        >
          隐藏漂移
        </button>
        <button className="feed-type-btn" onClick={resetFilters}>
          重置筛选
        </button>
        <button className="feed-type-btn" onClick={clearAiCache}>
          清缓存
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
                <td colSpan={13} className="ai-empty">
                  <div>暂无 Signal Hunter 候选。刷新行情或等待下一次 AI 自动识别后会重新写入。</div>
                  <div className="signal-hunter-empty-diag">
                    <span>AI结果 {emptyDiagnostics.ai}</span>
                    <span>状态 {emptyDiagnostics.status}</span>
                    <span>方向 {emptyDiagnostics.side}</span>
                    <span>类别 {emptyDiagnostics.category}</span>
                    <span>周期 {emptyDiagnostics.timeframe}</span>
                    <span>1h/4h {emptyDiagnostics.actionableTf}</span>
                    <span>止损可执行 {emptyDiagnostics.executableStop}</span>
                    <span>入场侧 {emptyDiagnostics.entrySide}</span>
                    <span>评分 {emptyDiagnostics.score}</span>
                    <span>R值 {emptyDiagnostics.rewardRisk}</span>
                    <span>搜索 {emptyDiagnostics.query}</span>
                    <span>新结果 {emptyDiagnostics.fresh}</span>
                    <span>最终 {emptyDiagnostics.visible}</span>
                  </div>
                </td>
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
              const stopInfo = stopDistanceInfo(asset, sig)
              const stale = Number.isFinite(drift) && Math.abs(drift) >= 1.5
              const distanceToEntry = distanceToEntryOf(sig, livePrice)
              const rejected = sig.rejected || sig.status === 'rejected'
              const isNew = !seenKeys.has(signalSeenKey(asset))
              const exec = executionMeta(asset)
              return (
                <>
                  <tr
                    key={key}
                    className="signal-hunter-row"
                    onClick={() => {
                      setExpanded(expanded === key ? null : key)
                    }}
                    onDoubleClick={() => openChart(asset)}
                  >
                    <td className="signal-hunter-index">{index + 1}</td>
                    <td>
                      <button className="symbol-link-btn" onClick={e => {
                        e.stopPropagation()
                        openChart(asset)
                      }}>
                        {asset.symbol}
                      </button>
                      <span className={`badge badge-${asset.type}`}>{categoryBadge(asset)}</span>
                      {isNew && <span className="signal-hunter-new-badge">新</span>}
                      {stale && <span className="signal-hunter-stale-badge">漂</span>}
                      <small>{formatTurnover(getQuoteVolume(asset))}</small>
                    </td>
                    <td>
                      <span className={`signal-hunter-status ${meta.cls}`}>{meta.label}</span>
                      <span className={`signal-hunter-exec ${exec.cls}`}>{exec.label}</span>
                    </td>
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
                        <span>图 {sig.score.chart}/10</span>
                        <span>数 {sig.score.data}/10</span>
                        <span>R {rewardRisk ? rewardRisk.toFixed(1) : '-'}</span>
                        <span>风 {sig.score.risk}</span>
                      </div>
                    </td>
                    <td>
                      <div>入场 {rejected ? '-' : formatPrice(entryPrice)}</div>
                      <small>确认 {formatPrice(confirmPrice)} <span className="muted">{fmtPct(sig.distanceToConfirmPct)}</span></small>
                      <small>失效 {formatPrice(sig.stopLoss)} <span className="muted">{fmtPct(sig.stopLossPct)}</span></small>
                      {stopInfo && (
                        <small>
                          风险宽 {formatPrice(stopInfo.distance)} / {stopInfo.pct.toFixed(1)}%
                          {Number.isFinite(stopInfo.minDistance) && <span className="muted"> · min {formatPrice(stopInfo.minDistance)}</span>}
                        </small>
                      )}
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
                        <button className="zone-btn" onClick={e => {
                          e.stopPropagation()
                          openChart(asset)
                        }}>K线</button>
                        <button className="zone-btn" onClick={e => {
                          e.stopPropagation()
                          copyPlan(asset)
                        }}>
                          复制
                        </button>
                        <button className="zone-btn" onClick={e => {
                          e.stopPropagation()
                          markSeen(asset)
                        }}>
                          已看
                        </button>
                        <button className="zone-btn" onClick={e => {
                          e.stopPropagation()
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
                        <div className="signal-hunter-card">
                          <div className="signal-hunter-card-head">
                            <div>
                              <b>{asset.symbol} · {sig.timeframe}</b>
                              <span>{sig.setupLabel || setupLabel(sig.setup)}</span>
                            </div>
                            <div className="signal-hunter-card-badges">
                              <span className={`signal-hunter-status ${meta.cls}`}>{meta.label}</span>
                              <span className={`signal-hunter-side ${side.cls}`}>{side.label}</span>
                              <span className={`signal-hunter-exec ${exec.cls}`}>{exec.label}</span>
                              <button className="zone-btn" onClick={e => {
                                e.stopPropagation()
                                copyPlan(asset)
                              }}>
                                复制计划
                              </button>
                            </div>
                          </div>
                          <div className="signal-hunter-card-grid">
                            <section>
                              <b>信号评分</b>
                              <div className="signal-hunter-score-grid">
                                <span><strong>{sig.score.total}/10</strong><small>综合</small></span>
                                <span><strong>{sig.score.chart}/10</strong><small>图表</small></span>
                                <span><strong>{sig.score.data}/10</strong><small>数据</small></span>
                                <span><strong>{rewardRisk ? `${rewardRisk.toFixed(1)}R` : '-'}</strong><small>盈亏比</small></span>
                              </div>
                            </section>
                            <section>
                              <b>策略参考</b>
                              <span>现价 {formatPrice(livePrice)} · 入场 {rejected ? '-' : formatPrice(entryPrice)}</span>
                              <span>确认 {formatPrice(confirmPrice)} · 失效 {formatPrice(sig.stopLoss)}</span>
                              {stopInfo && (
                                <span>
                                  风险宽 {formatPrice(stopInfo.distance)} · {stopInfo.pct.toFixed(1)}%
                                  {Number.isFinite(stopInfo.minDistance) ? ` · 最小可执行 ${formatPrice(stopInfo.minDistance)}` : ''}
                                </span>
                              )}
                              {!rejected && <span>TP1 {formatPrice(t1)} · TP2 {formatPrice(t2)} · TP3 {formatPrice(t3)}</span>}
                            </section>
                            <section>
                              <b>风险标记</b>
                              <div className="signal-hunter-risks">
                                {stale && <span>价格漂移 {fmtPct(drift)}</span>}
                                {sig.riskFlags?.map(flag => <span key={flag}>{flag}</span>)}
                                {!stale && !sig.riskFlags?.length && <em>暂无额外风险标记</em>}
                              </div>
                            </section>
                            <section>
                              <b>判定依据</b>
                              <span>{sig.reasons?.length ? sig.reasons.join(' / ') : '-'}</span>
                              <span>{rejected ? `剔除：${sig.rejectReasons?.join(' / ') || '-'}` : '通过：位置、评分、R 值均达标'}</span>
                            </section>
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
