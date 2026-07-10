import { Fragment, lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react'
import useMarketStore from '../store/marketStore'
import useAlertStore from '../store/alertStore'
import useSettingsStore from '../store/settingsStore'
import useSignalReviewStore from '../store/signalReviewStore'
import { formatPrice } from '../utils/rsi'
import { formatTurnover, getQuoteVolume } from '../utils/liquidity'
import { buildSignalHunterAiCandidate, buildSignalHunterAiCandidates, hasExecutableStopDistance, makeSignalHunterAiFeedItems, minExecutableStopDistance, normalizeSignalHunterAiResults, signalHunterCandidateSignature } from '../utils/signalHunterAi'
import { signalIdFromAsset } from '../utils/signalId'
import { buildSignalCalibration } from '../utils/signalCalibration'
import { loadSignalLifecycleItems, saveSignalLifecycleItems } from '../utils/signalLifecycle'

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
  { key: 'priority', label: '优先级' },
  { key: 'execution', label: '执行优先' },
  { key: 'ai', label: 'AI优先' },
  { key: 'score', label: '高评分' },
  { key: 'entry', label: '近入场' },
]

const EXECUTION_FILTERS = [
  { key: 'all', label: '全部执行' },
  { key: 'ready', label: '可盯' },
  { key: 'wait', label: '等待' },
  { key: 'risk', label: '风险' },
]

const OI_FILTERS = [
  { key: 'all', label: '全部资金' },
  { key: 'aligned', label: '资金配合' },
  { key: 'diverged', label: '资金背离' },
  { key: 'crowded', label: '费率拥挤' },
  { key: 'missing', label: 'OI缺失' },
]

const ACTIONABLE_TIMEFRAMES = new Set(['1h', '4h'])

const SH_AI_CACHE_KEY = 'rsi:signalHunter:aiCache'
const SH_AI_SEEN_KEY = 'rsi:signalHunter:seen'
const SH_AI_CHANGES_KEY = 'rsi:signalHunter:changes'
const SH_AI_PINNED_KEY = 'rsi:signalHunter:pinned'
const SH_AI_DIFF_KEY = 'rsi:signalHunter:diff'
const SH_AI_PROCESSED_KEY = 'rsi:signalHunter:processed'
const SH_FOCUS_KEY = 'rsi:signalHunter:focus'
const SH_SCORE_THRESHOLD_KEY = 'rsi:signalHunter:scoreThreshold'
const SH_COLUMNS_KEY = 'rsi:signalHunter:columns'
const SH_VIEW_KEY = 'rsi:signalHunter:view'

const OPTIONAL_COLUMNS = [
  { key: 'status', label: '状态' },
  { key: 'price', label: '价格' },
  { key: 'score', label: '评分' },
  { key: 'levels', label: '关键位' },
  { key: 'risk', label: '风险 / 原因' },
]

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
  base_long: '窄幅蓄势做多',
  base_short: '窄幅蓄势做空',
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

function labelOf(items, key) {
  return items.find(item => item.key === key)?.label ?? key
}

function oiReference(asset) {
  const d = asset?.derivatives
  if (!d) return { oi: null, funding: null, tf: '', label: '' }
  const oi4h = Number(d.oiChange4h)
  const oi1h = Number(d.oiChange1h)
  return {
    oi: Number.isFinite(oi4h) ? oi4h : Number.isFinite(oi1h) ? oi1h : null,
    funding: Number.isFinite(Number(d.fundingRate)) ? Number(d.fundingRate) : null,
    tf: Number.isFinite(oi4h) ? '4h' : Number.isFinite(oi1h) ? '1h' : '',
    label: d.label || '',
  }
}

function oiInsight(asset) {
  const sig = asset?.signalHunter
  const ref = oiReference(asset)
  if (!asset?.derivatives || !Number.isFinite(ref.oi)) return { key: 'missing', label: 'OI缺失', tone: 'neutral' }
  if (Number.isFinite(ref.funding) && Math.abs(ref.funding) >= 0.06) return { key: 'crowded', label: '费率拥挤', tone: 'negative' }
  const change = Number(asset?.change24h)
  const directionAligned = sig?.side === 'short'
    ? !Number.isFinite(change) || change <= 0.3
    : !Number.isFinite(change) || change >= -0.3
  if (ref.oi <= -3) return { key: 'diverged', label: 'OI下降', tone: 'negative' }
  if (ref.oi >= 3 && directionAligned) return { key: 'aligned', label: '资金配合', tone: 'positive' }
  if (ref.oi >= 3 && !directionAligned) return { key: 'diverged', label: '增仓背离', tone: 'negative' }
  return { key: 'neutral', label: '资金中性', tone: 'neutral' }
}

function derivativesLine(asset) {
  const ref = oiReference(asset)
  if (!asset?.derivatives) return ''
  const insight = oiInsight(asset)
  const parts = []
  if (Number.isFinite(ref.oi)) parts.push(`OI${ref.tf} ${fmtPct(ref.oi)}`)
  if (Number.isFinite(ref.funding)) parts.push(`费率 ${ref.funding.toFixed(3)}%`)
  if (insight.key !== 'neutral' && insight.key !== 'missing') parts.push(insight.label)
  else if (ref.label) parts.push(ref.label)
  return parts.join(' · ')
}

function derivativesTone(asset) {
  return oiInsight(asset).tone
}

function matchesOiFilter(asset, filter) {
  if (filter === 'all') return true
  return oiInsight(asset).key === filter
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
  if (sig.status === 'triggered') return true
  const continuation = sig.entryMode === 'breakout' || sig.entryMode === 'breakdown'
  if (continuation) {
    return sig.side === 'short'
      ? entryPrice <= currentPrice * 1.001
      : entryPrice >= currentPrice * 0.999
  }
  return sig.side === 'short'
    ? entryPrice >= currentPrice * 0.999
    : entryPrice <= currentPrice * 1.001
}

function targetProgressInfo(asset, currentPrice = livePriceOf(asset)) {
  const sig = asset?.signalHunter
  if (!sig || !Number.isFinite(currentPrice)) return null
  const targets = [1, 2, 3]
    .map(n => [n, targetFallback(sig, n)])
    .filter(([, target]) => Number.isFinite(target))
  if (!targets.length) return null
  const reached = targets.filter(([, target]) => sig.side === 'short'
    ? currentPrice <= target * 1.001
    : currentPrice >= target * 0.999)
  if (!reached.length) return null
  const [level, target] = reached[reached.length - 1]
  const remaining = targets.filter(([, candidate]) => sig.side === 'short'
    ? currentPrice > candidate * 1.001
    : currentPrice < candidate * 0.999)
  return {
    level,
    target,
    remaining,
    text: remaining.length ? `已到TP${level}，复核剩余空间` : `已到TP${level}，目标已完成`,
  }
}

function hasRemainingTargetRoom(asset, currentPrice = livePriceOf(asset)) {
  const progress = targetProgressInfo(asset, currentPrice)
  if (!progress) return true
  if (!progress.remaining.length) return false
  const sig = asset?.signalHunter
  const stop = sig?.stopLoss
  if (!Number.isFinite(stop) || !Number.isFinite(currentPrice)) return false
  const risk = Math.abs(currentPrice - stop)
  const target = progress.remaining[Math.min(1, progress.remaining.length - 1)]?.[1]
  if (!risk || !Number.isFinite(target)) return false
  return Math.abs(target - currentPrice) / risk >= 1.2
}

function visibleSignal(asset, showRejected, scoreThreshold = 7, currentPrice = asset?.signalHunter?.currentPrice) {
  const sig = asset?.signalHunter
  if (!sig) return false
  if (!ACTIONABLE_TIMEFRAMES.has(sig.timeframe)) return false
  if (sig.rejected || sig.status === 'rejected') return showRejected
  if (!hasExecutableStopDistance(asset, sig)) return false
  if (!hasTradableEntrySide(sig, currentPrice)) return false
  if (!hasRemainingTargetRoom(asset, currentPrice)) return false
  if (sig.stability && !sig.stability.confirmed && sig.status !== 'triggered' && (sig.score?.total ?? 0) < 8.2) return false
  if ((sig.score?.total ?? 0) < scoreThreshold) return false
  const rewardRisk = rewardRiskFallback(sig)
  return Number.isFinite(rewardRisk) && rewardRisk >= 1.5
}

function firstText(values) {
  return values?.find(Boolean) ?? ''
}

function nextStepText(asset, expired) {
  const sig = asset?.signalHunter
  if (!sig) return { label: '等待数据', detail: '' }
  if (expired) return { label: '先重新识别', detail: 'AI结果已过期' }
  if (sig.rejected || sig.status === 'rejected') {
    return { label: '暂时回避', detail: firstText(sig.rejectReasons) || '已被AI剔除' }
  }
  const targetProgress = targetProgressInfo(asset)
  if (targetProgress) {
    return { label: '已过入场窗口', detail: targetProgress.text }
  }
  if (sig.status === 'risk') {
    return { label: '暂时回避', detail: firstText(sig.riskFlags) || '风险信号' }
  }
  if (sig.status === 'triggered') {
    return { label: '重点盯确认', detail: `确认 ${formatPrice(confirmPriceOf(sig))}` }
  }
  if (sig.status === 'armed' || sig.status === 'wait_entry') {
    const distance = distanceToEntryOf(sig, livePriceOf(asset))
    return { label: '等待入场距离', detail: Number.isFinite(distance) ? `距入场 ${fmtPct(distance)}` : '' }
  }
  if (sig.status === 'wait_confirm') {
    return { label: '等待确认价', detail: `确认 ${formatPrice(confirmPriceOf(sig))}` }
  }
  if (sig.status === 'watch') {
    return { label: '保持观察', detail: firstText(sig.reasons) || '结构未触发' }
  }
  return { label: '继续观察', detail: '' }
}

function matchesAiView(asset, aiView, changedKeys = null, pinnedKeys = null) {
  const sig = asset?.signalHunter ?? asset
  if (aiView === 'all') return true
  if (aiView === 'pinned') return pinnedKeys?.has(signalPinnedKey(asset)) ?? false
  if (aiView === 'actionable') return ['triggered', 'armed', 'wait_entry', 'wait_confirm'].includes(sig?.status)
  if (aiView === 'changed') return changedKeys?.has(signalHistoryKey(asset)) ?? false
  if (aiView === 'changed_up' || aiView === 'changed_down') {
    const change = changedKeys?.get?.(signalHistoryKey(asset))
    const direction = statusChangeDirection(change, sig?.status)
    return aiView === 'changed_up' ? direction === 'up' : direction === 'down'
  }
  if (aiView === 'focus') return sig?.status === 'triggered'
  if (aiView === 'pending') return ['armed', 'wait_entry', 'wait_confirm'].includes(sig?.status)
  return sig?.status === aiView
}

function signalHistoryKey(item) {
  const sig = item?.signalHunter ?? {}
  return [item?.key ?? signalKey(item), sig.side ?? '', sig.timeframe ?? ''].join('|')
}

function signalPinnedKey(item) {
  const sig = item?.signalHunter ?? {}
  return [item?.symbol ?? item?.apiSymbol ?? item?.key ?? signalKey(item), sig.side ?? '', sig.timeframe ?? ''].join('|')
}

function signalTrackKey(item) {
  const sig = item?.signalHunter ?? {}
  return [item?.symbol ?? item?.apiSymbol ?? item?.key ?? signalKey(item), sig.side ?? ''].join('|')
}

function collectStatusChanges(previousItems, nextItems, now) {
  const previous = new Map((previousItems ?? []).map(item => [signalHistoryKey(item), item?.signalHunter?.status]))
  return (nextItems ?? []).flatMap(item => {
    const key = signalHistoryKey(item)
    const from = previous.get(key)
    const to = item?.signalHunter?.status
    if (!from || !to || from === to) return []
    return [{ key, symbol: item.symbol, from, to, ts: now }]
  })
}

function collectAiDiff(previousItems, nextItems, now) {
  const previous = new Map((previousItems ?? []).map(item => [signalHistoryKey(item), item]))
  const next = new Map((nextItems ?? []).map(item => [signalHistoryKey(item), item]))
  const added = []
  const removed = []
  const scoreChanged = []
  for (const [key, item] of next) {
    const before = previous.get(key)
    if (!before) {
      added.push({ key, symbol: item.symbol, ts: now })
      continue
    }
    const from = before.signalHunter?.score?.total
    const to = item.signalHunter?.score?.total
    if (Number.isFinite(from) && Number.isFinite(to) && Math.abs(to - from) >= 0.5) {
      scoreChanged.push({ key, symbol: item.symbol, from, to, ts: now })
    }
  }
  for (const [key, item] of previous) {
    if (!next.has(key)) removed.push({ key, symbol: item.symbol, ts: now })
  }
  return { added, removed, scoreChanged, ts: now }
}

function diffByKey(diff, field) {
  return new Map((diff?.[field] ?? []).map(item => [item.key, item]))
}

function statusChangeText(change, fallbackStatus) {
  if (!change) return ''
  const from = statusMeta(change.from).label
  const to = statusMeta(change.to ?? fallbackStatus).label
  return `${from} → ${to}`
}

function riskGradeText(text) {
  const value = String(text ?? '')
  if (/止损|不可执行|方向|剔除|TP|追单|R 值|R值|reward|risk\/reward/i.test(value)) return 'hard'
  if (/漂移|距离|确认|偏远|结构|等待|波动/i.test(value)) return 'soft'
  return 'soft'
}

function riskItems(asset, stale, drift) {
  const sig = asset?.signalHunter ?? {}
  const targetProgress = targetProgressInfo(asset)
  return [
    stale ? `价格漂移 ${fmtPct(drift)}` : null,
    targetProgress?.text,
    ...(sig.riskFlags ?? []),
    ...(sig.rejectReasons ?? []),
  ].filter(Boolean).map(text => ({ text, grade: riskGradeText(text) }))
}

function signalPriority(asset) {
  const sig = asset?.signalHunter ?? {}
  const score = Number(sig.score?.total) || 0
  const rewardRisk = rewardRiskFallback(sig)
  const distance = absDistanceToEntry(asset)
  const drift = Math.abs(priceDriftPct(asset) ?? 0)
  const turnover = getQuoteVolume(asset) || 0
  const stopInfo = stopDistanceInfo(asset, sig)
  const exec = executionMeta(asset)
  const statusBonus = sig.status === 'triggered' ? 8
    : sig.status === 'armed' || sig.status === 'wait_entry' ? 5
      : sig.status === 'wait_confirm' ? 3
        : sig.status === 'watch' ? 1
          : sig.status === 'risk' ? -10
            : sig.status === 'rejected' ? -18
              : 0
  const scorePart = score * 6
  const rrPart = Number.isFinite(rewardRisk) ? Math.min(18, Math.max(0, (rewardRisk - 1.5) * 12)) : 0
  const entryPart = Math.max(0, 12 - Math.min(12, distance * 2.2))
  const liquidityPart = Math.min(8, Math.log10(turnover / 1_000_000 + 1) * 3)
  const execPart = exec.key === 'ready' ? 8 : exec.key === 'wait' ? 3 : exec.key === 'risk' ? -8 : -2
  const riskPenalty = (sig.riskFlags?.length ?? 0) * 2.5 + (stopInfo?.ok === false ? 8 : 0) + Math.min(10, drift * 2)
  return Number(Math.max(0, Math.min(100,
    scorePart + rrPart + entryPart + liquidityPart + execPart + statusBonus - riskPenalty
  )).toFixed(1))
}

function dedupeSignalRows(rows) {
  const best = new Map()
  const rank = asset => {
    const sig = asset.signalHunter ?? {}
    const statusScore = 10 - statusRank(sig.status)
    const score = sig.score?.total ?? 0
    const rr = rewardRiskFallback(sig) ?? 0
    return statusScore * 100 + signalPriority(asset) + score * 10 + rr - absDistanceToEntry(asset) * 0.01
  }
  for (const asset of rows) {
    const key = signalTrackKey(asset)
    const current = best.get(key)
    if (!current || rank(asset) > rank(current)) best.set(key, asset)
  }
  return [...best.values()]
}

function statusStrength(status) {
  if (status === 'triggered') return 5
  if (status === 'armed' || status === 'wait_entry' || status === 'wait_confirm') return 4
  if (status === 'watch') return 3
  if (status === 'risk') return 2
  if (status === 'rejected') return 1
  return 0
}

function statusChangeDirection(change, fallbackStatus) {
  if (!change) return 'flat'
  const from = statusStrength(change.from)
  const to = statusStrength(change.to ?? fallbackStatus)
  if (to > from) return 'up'
  if (to < from) return 'down'
  return 'flat'
}

function isSignalHunterAiExpired(runAt, intervalMinutes, now) {
  if (!Number.isFinite(runAt) || runAt <= 0) return false
  const intervalMs = Math.max(1, Number(intervalMinutes) || 30) * 60 * 1000
  return now - runAt > Math.max(90 * 60 * 1000, intervalMs * 2)
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
  if (sig.status === 'risk' || drift >= 1.5 || stopInfo?.ok === false || targetProgressInfo(asset)) {
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

function matchesSignalHunterQuery(asset, q) {
  if (!q) return true
  const sig = asset.signalHunter ?? {}
  return [
    asset.symbol,
    signalIdFromAsset(asset),
    asset.apiSymbol,
    asset.name,
    sig.status,
    statusMeta(sig.status).label,
    sig.side,
    sideMeta(sig.side).label,
    sig.timeframe,
    sig.setup,
    sig.setupLabel,
    setupLabel(sig.setup),
    derivativesLine(asset),
    oiInsight(asset).label,
    ...(sig.reasons ?? []),
    ...(sig.riskFlags ?? []),
    ...(sig.rejectReasons ?? []),
  ].some(value => String(value ?? '').toUpperCase().includes(q))
}

function buildEmptyDiagnostics(assets, {
  filter,
  aiView,
  changedKeys,
  pinnedKeys,
  sideFilter,
  categoryFilter,
  timeframeFilter,
  oiFilter,
  scoreThreshold,
  showRejected,
  query,
  showNewOnly,
  hideDrifted,
  seenKeys,
}) {
  const q = query.trim().toUpperCase()
  const base = assets.filter(asset => asset.signalHunter)
  const byAiView = base.filter(asset => matchesAiView(asset, aiView, changedKeys, pinnedKeys))
  const byStatus = byAiView.filter(asset => aiView !== 'all' || filter === 'all' || asset.signalHunter.status === filter)
  const bySide = byStatus.filter(asset => sideFilter === 'all' || asset.signalHunter.side === sideFilter)
  const byCategory = bySide.filter(asset => categoryFilter === 'all' || asset.type === categoryFilter)
  const byTimeframe = byCategory.filter(asset => timeframeFilter === 'all' || asset.signalHunter.timeframe === timeframeFilter)
  const byOi = byTimeframe.filter(asset => matchesOiFilter(asset, oiFilter))
  const byActionableTf = byOi.filter(asset => ACTIONABLE_TIMEFRAMES.has(asset.signalHunter.timeframe))
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
  const byTargetRoom = byEntrySide.filter(asset => showRejected || hasRemainingTargetRoom(asset, livePriceOf(asset)))
  const byScore = byTargetRoom.filter(asset => {
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
  const byQuery = byQuality.filter(asset => matchesSignalHunterQuery(asset, q))
  const byNew = byQuery.filter(asset => !showNewOnly || !seenKeys.has(signalSeenKey(asset)))
  const byDrift = byNew.filter(asset => !hideDrifted || showRejected || Math.abs(priceDriftPct(asset) ?? 0) < 3)
  return {
    ai: base.length,
    aiView: byAiView.length,
    status: byStatus.length,
    side: bySide.length,
    category: byCategory.length,
    timeframe: byTimeframe.length,
    oi: byOi.length,
    actionableTf: byActionableTf.length,
    executableStop: byExecutableStop.length,
    entrySide: byEntrySide.length,
    targetRoom: byTargetRoom.length,
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

function loadScoreThreshold() {
  const value = Number(localStorage.getItem(SH_SCORE_THRESHOLD_KEY))
  return Number.isFinite(value) ? value : 7
}

function saveScoreThreshold(value) {
  localStorage.setItem(SH_SCORE_THRESHOLD_KEY, String(value))
}

function loadPinnedKeys() {
  return new Set(loadJson(SH_AI_PINNED_KEY, []))
}

function loadProcessedKeys() {
  return new Set(loadJson(SH_AI_PROCESSED_KEY, []))
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
  const signalId = signalIdFromAsset(asset)
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
  const derivativeInfo = derivativesLine(asset)
  const riskLines = [
    Number.isFinite(drift) && Math.abs(drift) >= 0.5 ? `价格漂移 ${fmtPct(drift)}` : null,
    ...(sig.riskFlags ?? []),
    ...(sig.rejectReasons ?? []),
  ].filter(Boolean)
  return [
    `[Signal Hunter] ${signalId} · ${asset.symbol} ${sig.timeframe} ${side.label} · ${meta.label} · ${exec.label}`,
    `现价: ${formatPrice(livePrice)}`,
    `入场: ${formatPrice(entryPrice)} | 确认: ${formatPrice(confirmPrice)} | 失效: ${formatPrice(sig.stopLoss)}`,
    `目标: ${formatPrice(t1)} / ${formatPrice(t2)} / ${formatPrice(t3)} | R: ${Number.isFinite(rewardRisk) ? rewardRisk.toFixed(1) : '-'}`,
    stopInfo
      ? `风险宽: ${formatPrice(stopInfo.distance)} (${stopInfo.pct.toFixed(1)}%)${Number.isFinite(stopInfo.minDistance) ? ` | 最小可执行: ${formatPrice(stopInfo.minDistance)}` : ''}`
      : '风险宽: -',
    `评分: ${sig.score?.total ?? '-'}/10 | 图表 ${sig.score?.chart ?? '-'}/10 | 数据 ${sig.score?.data ?? '-'}/10 | 风险 ${sig.score?.risk ?? '-'}`,
    `资金: ${derivativeInfo || '-'}`,
    `形态: ${sig.setupLabel || setupLabel(sig.setup)}`,
    `依据: ${sig.reasons?.length ? sig.reasons.join(' / ') : '-'}`,
    `风险: ${riskLines.length ? riskLines.join(' / ') : '-'}`,
    '备注: SH 只做结构参考，不是自动下单指令；执行前重新确认 1h/4h K 线和流动性。',
  ].join('\n')
}

function signalHunterHealth(aiRunMeta, aiSummary, aiExpired) {
  if (!aiRunMeta || !aiSummary?.total) {
    return { key: 'empty', label: '无结果', cls: 'muted', note: '还没有 AI 识别结果' }
  }
  if (aiExpired) {
    return { key: 'expired', label: '过期', cls: 'warn', note: '建议重新识别' }
  }
  if ((aiRunMeta.live ?? 0) < 3 || aiSummary.total < 5) {
    return { key: 'thin', label: '候选不足', cls: 'warn', note: '覆盖样本偏少' }
  }
  const weak = aiSummary.risk + aiSummary.rejected
  if (aiSummary.total && weak / aiSummary.total >= 0.45) {
    return { key: 'review', label: '需复核', cls: 'risk', note: '风险/剔除偏多' }
  }
  return { key: 'healthy', label: '健康', cls: 'good', note: '结果可用' }
}

function signalHunterReviewText(aiSummary, statusChanges) {
  if (!aiSummary?.total) return '暂无 AI 结果，先运行一次 AI 识别。'
  const changedUp = aiSummary.changedUp || 0
  const changedDown = aiSummary.changedDown || 0
  const tone = changedUp > changedDown ? '偏积极' : changedDown > changedUp ? '偏谨慎' : '中性'
  return `本轮重点 ${aiSummary.focus} 个，待确认 ${aiSummary.pending} 个，风险 ${aiSummary.risk} 个，变强 ${changedUp} 个，变弱 ${changedDown} 个，整体 ${tone}。`
}

function signalHunterViewSummaryText({
  rows,
  aiView,
  aiHealth,
  aiReview,
  statusChangeByKey,
  pinnedKeys,
  processedKeys,
  aiDiff,
  aiExpired,
  filters,
}) {
  const picked = rows.slice(0, 12)
  const header = [
    `Signal Hunter 当前视图摘要 · ${new Date().toLocaleString('zh-CN')}`,
    `视图: ${aiView} | 健康度: ${aiHealth.label} (${aiHealth.note})`,
    `筛选: ${filters.category}/${filters.timeframe}/${filters.side} | 资金 ${filters.oi} | ${filters.score}+ | ${filters.execution} | ${filters.sort}`,
    `数量: ${picked.length}/${rows.length}`,
    `小结: ${aiReview}`,
  ].join('\n')
  const body = picked.map((asset, index) => {
    const sig = asset.signalHunter
    const change = statusChangeByKey.get(signalHistoryKey(asset))
    const next = nextStepText(asset, aiExpired)
    const pinned = pinnedKeys?.has(signalPinnedKey(asset))
    const processed = processedKeys?.has(signalPinnedKey(asset))
    return [
      `${index + 1}. ${pinned ? '[关注] ' : ''}${processed ? '[已处理] ' : ''}${asset.symbol} ${sig.timeframe} ${sideMeta(sig.side).label} · ${statusMeta(sig.status).label}`,
      `下一步: ${next.label}${next.detail ? ` (${next.detail})` : ''}`,
      change ? `变化: ${statusChangeText(change, sig.status)}` : null,
      `评分: ${sig.score?.total ?? '-'}/10 | R: ${Number.isFinite(rewardRiskFallback(sig)) ? rewardRiskFallback(sig).toFixed(1) : '-'}`,
      sig.riskFlags?.length ? `风险: ${sig.riskFlags.join(' / ')}` : null,
    ].filter(Boolean).join('\n')
  })
  const diffLine = aiDiff
    ? `对比上一轮: 新增 ${aiDiff.added?.length ?? 0} / 消失 ${aiDiff.removed?.length ?? 0} / 分数变化 ${aiDiff.scoreChanged?.length ?? 0}`
    : ''
  return [header, diffLine, ...body].filter(Boolean).join('\n\n')
}

function findInterestAsset(assets, input) {
  const q = String(input ?? '').trim().toUpperCase()
  if (!q) return null
  return assets.find(asset => {
    const values = [
      asset.symbol,
      asset.apiSymbol,
      asset.name,
      assetKeyForMatch(asset),
    ].filter(Boolean).map(v => String(v).toUpperCase())
    return values.some(v => v === q || v.includes(q))
  }) ?? null
}

function assetKeyForMatch(asset) {
  return `${asset.source ?? ''}:${asset.apiSymbol ?? asset.symbol ?? ''}`
}

function mergeSignalHunterCacheItems(previousItems, nextItems) {
  const byKey = new Map((previousItems ?? []).map(item => [item.key ?? assetKeyForMatch(item), item]))
  for (const item of nextItems ?? []) {
    byKey.set(item.key ?? assetKeyForMatch(item), item)
  }
  return [...byKey.values()]
}

export default function SignalHunterPage() {
  const assets = useMarketStore(s => s.assets)
  const updatedAt = useMarketStore(s => s.updatedAt)
  const applySignalHunterAiResults = useMarketStore(s => s.applySignalHunterAiResults)
  const addFeedItems = useAlertStore(s => s.addFeedItems)
  const shAiInterval = useSettingsStore(s => s.shAiInterval ?? 30)
  const tradeLogs = useSignalReviewStore(s => s.tradeLogs)
  const signalCalibration = useMemo(() => buildSignalCalibration(tradeLogs), [tradeLogs])
  const [filter, setFilter] = useState('all')
  const [sideFilter, setSideFilter] = useState('all')
  const [categoryFilter, setCategoryFilter] = useState('all')
  const [timeframeFilter, setTimeframeFilter] = useState('all')
  const [oiFilter, setOiFilter] = useState('all')
  const [scoreThreshold, setScoreThresholdState] = useState(() => loadScoreThreshold())
  const [stockFocus, setStockFocus] = useState(true)
  const [sortMode, setSortMode] = useState('priority')
  const [aiView, setAiView] = useState('all')
  const [executionFilter, setExecutionFilter] = useState('all')
  const [showRejected, setShowRejected] = useState(false)
  const [showNewOnly, setShowNewOnly] = useState(false)
  const [showUnprocessedOnly, setShowUnprocessedOnly] = useState(() => Boolean(loadJson(SH_VIEW_KEY, {}).showUnprocessedOnly))
  const [hideDrifted, setHideDrifted] = useState(true)
  const [query, setQuery] = useState('')
  const [interestSymbol, setInterestSymbol] = useState('')
  const [tableMode, setTableMode] = useState(() => loadJson(SH_VIEW_KEY, {}).tableMode === 'detail' ? 'detail' : 'compact')
  const [showFilters, setShowFilters] = useState(() => Boolean(loadJson(SH_VIEW_KEY, {}).showFilters))
  const [showOverview, setShowOverview] = useState(() => loadJson(SH_VIEW_KEY, {}).showOverview !== false)
  const [expanded, setExpanded] = useState(null)
  const [focusedRow, setFocusedRow] = useState(null)
  const [visibleColumns, setVisibleColumns] = useState(() => ({
    status: true,
    price: true,
    score: true,
    levels: true,
    risk: false,
    ...loadJson(SH_COLUMNS_KEY, {}),
  }))
  const [chartAsset, setChartAsset] = useState(null)
  const [chartSignal, setChartSignal] = useState(null)
  const [aiBusy, setAiBusy] = useState(false)
  const [aiStatus, setAiStatus] = useState('')
  const [aiRunMeta, setAiRunMeta] = useState(() => loadJson(SH_AI_CACHE_KEY, null)?.meta ?? null)
  const [statusChanges, setStatusChanges] = useState(() => loadJson(SH_AI_CHANGES_KEY, []))
  const [aiDiff, setAiDiff] = useState(() => loadJson(SH_AI_DIFF_KEY, { added: [], removed: [], scoreChanged: [], ts: 0 }))
  const [seenKeys, setSeenKeys] = useState(() => loadSeenKeys())
  const [pinnedKeys, setPinnedKeys] = useState(() => loadPinnedKeys())
  const [processedKeys, setProcessedKeys] = useState(() => loadProcessedKeys())
  const [mergeBySymbol, setMergeBySymbol] = useState(false)
  const [now, setNow] = useState(() => Date.now())
  const aiBusyRef = useRef(false)
  const lastAiSignatureRef = useRef('')
  const pendingAutoRef = useRef(false)
  const appliedCacheRef = useRef('')
  const rowRefs = useRef(new Map())
  const stickyHeadRef = useRef(null)

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60 * 1000)
    return () => clearInterval(timer)
  }, [])

  useEffect(() => {
    if (!focusedRow) return undefined
    const timer = setTimeout(() => setFocusedRow(null), 2600)
    return () => clearTimeout(timer)
  }, [focusedRow])

  useEffect(() => {
    saveJson(SH_VIEW_KEY, { tableMode, showFilters, showOverview, showUnprocessedOnly })
  }, [tableMode, showFilters, showOverview, showUnprocessedOnly])

  const setScoreThreshold = (value) => {
    const n = Number(value)
    const next = Number.isFinite(n) ? Math.min(10, Math.max(0, n)) : 7
    setScoreThresholdState(next)
    saveScoreThreshold(next)
  }

  useEffect(() => {
    const raw = localStorage.getItem(SH_FOCUS_KEY)
    if (!raw) return
    localStorage.removeItem(SH_FOCUS_KEY)
    try {
      const focus = JSON.parse(raw)
      if (!focus?.symbol) return
      setQuery(String(focus.signalId || focus.symbol).toUpperCase())
      setAiView('all')
      setFilter('all')
      setSideFilter('all')
      setCategoryFilter('all')
      setTimeframeFilter(focus.timeframe && ACTIONABLE_TIMEFRAMES.has(focus.timeframe) ? focus.timeframe : 'all')
      setExecutionFilter('all')
      setShowRejected(true)
      setShowNewOnly(false)
      setHideDrifted(false)
      setMergeBySymbol(false)
      setAiStatus(`已从 SH复盘定位 ${focus.symbol}；若列表为空，说明它不在当前 SH 快照或当前管理品种中。`)
    } catch {
      // ignore malformed focus payload
    }
  }, [])

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
        `筛选: ${categoryFilter}/${timeframeFilter}/${sideFilter} · 资金 ${oiFilter} · ${scoreThreshold}+ · ${executionFilter} · ${sortMode}`,
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

  function togglePinned(asset) {
    const key = signalPinnedKey(asset)
    setPinnedKeys(prev => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      saveJson(SH_AI_PINNED_KEY, [...next])
      return next
    })
  }

  function toggleProcessed(asset) {
    const key = signalPinnedKey(asset)
    setProcessedKeys(prev => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      saveJson(SH_AI_PROCESSED_KEY, [...next])
      return next
    })
  }

  const copyVisibleSummary = async () => {
    if (!rows.length) return
    try {
      await copyText(signalHunterViewSummaryText({
        rows,
        aiView,
        aiHealth,
        aiReview,
        statusChangeByKey,
        pinnedKeys,
        processedKeys,
        aiDiff,
        aiExpired,
        filters: {
          category: categoryFilter,
          timeframe: timeframeFilter,
          side: sideFilter,
          oi: oiFilter,
          score: scoreThreshold,
          execution: executionFilter,
          sort: sortMode,
        },
      }))
      setAiStatus(`已复制当前视图摘要 ${Math.min(rows.length, 12)}/${rows.length}`)
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
      const previousItems = await loadSignalLifecycleItems()
      const normalized = normalizeSignalHunterAiResults(res.result, assets, signalCalibration, previousItems)
      const runAt = Date.now()
      const changes = collectStatusChanges(previousItems, normalized, runAt)
      const diff = collectAiDiff(previousItems, normalized, runAt)
      applySignalHunterAiResults(normalized)
      await saveSignalLifecycleItems(normalized, runAt)
      const feedItems = makeSignalHunterAiFeedItems(normalized, Date.now())
      if (feedItems.length) addFeedItems(feedItems)
      const live = normalized.filter(item => item.signalHunter?.status !== 'rejected').length
      const meta = {
        runAt,
        snapshotAt: updatedAt ?? Date.now(),
        total: normalized.length,
        live,
        candidateSignature: signature,
      }
      saveJson(SH_AI_CACHE_KEY, { meta, items: normalized })
      saveJson(SH_AI_DIFF_KEY, diff)
      setAiDiff(diff)
      if (changes.length) {
        setStatusChanges(prev => {
          const next = [...changes, ...prev].slice(0, 100)
          saveJson(SH_AI_CHANGES_KEY, next)
          return next
        })
      }
      setAiRunMeta(meta)
      lastAiSignatureRef.current = signature
      setAiStatus(res.degraded
        ? `AI 解释异常，已保留本地确定性结果 ${live}/${normalized.length}`
        : `AI 已写入 ${live}/${normalized.length} 个 SH 结果`)
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

  const runInterestSignalHunter = async () => {
    if (!window.api?.runCodexScreen || aiBusyRef.current) return
    const asset = findInterestAsset(assets, interestSymbol || query)
    if (!asset) {
      setAiStatus('没有找到这个标的；请先确认它已经在当前行情/管理列表里。')
      return
    }
    const candidate = buildSignalHunterAiCandidate(asset)
    if (!candidate) {
      setAiStatus(`${asset.symbol} 当前没有可用价格，暂时不能送入 AI 分析。`)
      return
    }
    aiBusyRef.current = true
    setAiBusy(true)
    setAiStatus(`AI 正在单独分析 ${asset.symbol}...`)
    try {
      const payload = {
        scope: `signal-hunter-interest-${asset.symbol}`,
        createdAt: new Date().toISOString(),
        updatedAt,
        note: '临时单标的 Signal Hunter 分析：只识别结构、方向、关键位、风险和是否值得继续观察；不要输出交易指令。',
        candidates: [candidate],
      }
      const res = await window.api.runCodexScreen(payload)
      if (!res?.ok || !res.result) throw new Error(res?.parseError || res?.error || 'AI 未返回有效 JSON')
      const cached = loadJson(SH_AI_CACHE_KEY, null)
      const cachedItems = cached?.items ?? []
      const previousItems = await loadSignalLifecycleItems()
      const normalized = normalizeSignalHunterAiResults(res.result, assets, signalCalibration, previousItems)
      if (!normalized.length) throw new Error('AI 结果没有匹配到当前标的')
      const runAt = Date.now()
      const mergedItems = mergeSignalHunterCacheItems(cachedItems, normalized)
      const changes = collectStatusChanges(previousItems, normalized, runAt)
      const diff = collectAiDiff(cachedItems, mergedItems, runAt)
      applySignalHunterAiResults(normalized)
      await saveSignalLifecycleItems(normalized, runAt)
      const feedItems = makeSignalHunterAiFeedItems(normalized, Date.now())
      if (feedItems.length) addFeedItems(feedItems)
      const live = mergedItems.filter(item => item.signalHunter?.status !== 'rejected').length
      const meta = {
        ...(cached?.meta ?? {}),
        runAt,
        snapshotAt: updatedAt ?? Date.now(),
        total: mergedItems.length,
        live,
        interestSymbol: asset.symbol,
      }
      saveJson(SH_AI_CACHE_KEY, { meta, items: mergedItems })
      saveJson(SH_AI_DIFF_KEY, diff)
      setAiRunMeta(meta)
      setAiDiff(diff)
      if (changes.length) {
        setStatusChanges(prev => {
          const next = [...changes, ...prev].slice(0, 100)
          saveJson(SH_AI_CHANGES_KEY, next)
          return next
        })
      }
      setInterestSymbol(asset.symbol)
      setQuery(asset.symbol)
      setAiView('all')
      setFilter('all')
      setExecutionFilter('all')
      setShowRejected(true)
      setShowNewOnly(false)
      setHideDrifted(false)
      setSortMode('ai')
      setExpanded(signalKey(asset))
      setAiStatus(res.degraded
        ? `AI 解释异常，已保留 ${asset.symbol} 的本地确定性结果`
        : `AI 已完成 ${asset.symbol} 临时分析，并写入 SH。`)
    } catch (err) {
      setAiStatus(`${asset?.symbol ?? interestSymbol} 临时分析失败：${err.message}`)
    } finally {
      aiBusyRef.current = false
      setAiBusy(false)
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

  const statusChangeByKey = useMemo(() => new Map(statusChanges.map(change => [change.key, change])), [statusChanges])
  const changedKeys = statusChangeByKey
  const aiExpired = isSignalHunterAiExpired(aiRunMeta?.runAt, shAiInterval, now)
  const interestAsset = useMemo(() => findInterestAsset(assets, interestSymbol), [assets, interestSymbol])

  const rows = useMemo(() => {
    const q = query.trim().toUpperCase()
    const filtered = assets
      .filter(asset => asset.signalHunter)
      .filter(asset => aiView !== 'all' || filter === 'all' || asset.signalHunter.status === filter)
      .filter(asset => matchesAiView(asset, aiView, changedKeys, pinnedKeys))
      .filter(asset => aiView !== 'focus' || !aiExpired)
      .filter(asset => sideFilter === 'all' || asset.signalHunter.side === sideFilter)
      .filter(asset => categoryFilter === 'all' || asset.type === categoryFilter)
      .filter(asset => timeframeFilter === 'all' || asset.signalHunter.timeframe === timeframeFilter)
      .filter(asset => matchesOiFilter(asset, oiFilter))
      .filter(asset => {
        if (aiView === 'pinned' || aiView === 'risk' || aiView === 'rejected' || aiView === 'changed' || aiView === 'changed_up' || aiView === 'changed_down') {
          return ACTIONABLE_TIMEFRAMES.has(asset.signalHunter.timeframe)
        }
        return visibleSignal(asset, showRejected, scoreThreshold, livePriceOf(asset))
      })
      .filter(asset => showRejected || aiView === 'rejected' || aiView === 'risk' || hasRemainingTargetRoom(asset, livePriceOf(asset)))
      .filter(asset => aiView !== 'all' || executionFilter === 'all' || executionMeta(asset).key === executionFilter)
      .filter(asset => !q || asset.symbol.toUpperCase().includes(q))
      .filter(asset => !showNewOnly || !seenKeys.has(signalSeenKey(asset)))
      .filter(asset => !showUnprocessedOnly || !processedKeys.has(signalPinnedKey(asset)))
      .filter(asset => !hideDrifted || showRejected || Math.abs(priceDriftPct(asset) ?? 0) < 3)
      .sort((a, b) => {
        if (aiView === 'changed') {
          const changeDelta = (statusChangeByKey.get(signalHistoryKey(b))?.ts ?? 0) - (statusChangeByKey.get(signalHistoryKey(a))?.ts ?? 0)
          if (changeDelta) return changeDelta
        }
        const newDelta = Number(!seenKeys.has(signalSeenKey(b))) - Number(!seenKeys.has(signalSeenKey(a)))
        if (newDelta) return newDelta
        const driftDelta = Number(Math.abs(priceDriftPct(a) ?? 0) >= 1.5) - Number(Math.abs(priceDriftPct(b) ?? 0) >= 1.5)
        if (driftDelta) return driftDelta
        if (sortMode === 'ai') {
          const aiRank = asset => {
            const status = asset.signalHunter?.status
            if (status === 'risk') return 0
            if (status === 'triggered') return 1
            if (status === 'armed' || status === 'wait_entry' || status === 'wait_confirm') return 2
            if (status === 'watch') return 3
            if (status === 'rejected') return 5
            return 4
          }
          const aiDelta = aiRank(a) - aiRank(b)
          if (aiDelta) return aiDelta
          const aiScoreDelta = (b.signalHunter?.score?.total ?? 0) - (a.signalHunter?.score?.total ?? 0)
          if (aiScoreDelta) return aiScoreDelta
          const aiRRDelta = (rewardRiskFallback(b.signalHunter) ?? 0) - (rewardRiskFallback(a.signalHunter) ?? 0)
          if (aiRRDelta) return aiRRDelta
          return absDistanceToEntry(a) - absDistanceToEntry(b)
        }
        if (sortMode === 'priority') return signalPriority(b) - signalPriority(a)
        if (sortMode === 'entry') return absDistanceToEntry(a) - absDistanceToEntry(b)
        const sa = a.signalHunter?.score?.total ?? 0
        const sb = b.signalHunter?.score?.total ?? 0
        if (sortMode === 'score') {
          if (sb !== sa) return sb - sa
          return signalPriority(b) - signalPriority(a)
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
        const priorityDelta = signalPriority(b) - signalPriority(a)
        if (priorityDelta) return priorityDelta
        if (sb !== sa) return sb - sa
        return (rewardRiskFallback(b.signalHunter) ?? 0) - (rewardRiskFallback(a.signalHunter) ?? 0)
      })
    return (mergeBySymbol ? dedupeSignalRows(filtered) : filtered).slice(0, 120)
  }, [assets, filter, sideFilter, categoryFilter, timeframeFilter, oiFilter, scoreThreshold, stockFocus, sortMode, aiView, executionFilter, showRejected, query, showNewOnly, showUnprocessedOnly, hideDrifted, seenKeys, processedKeys, changedKeys, pinnedKeys, statusChangeByKey, aiExpired, mergeBySymbol])

  const emptyDiagnostics = useMemo(() => buildEmptyDiagnostics(assets, {
    filter,
    aiView,
    changedKeys,
    pinnedKeys,
    sideFilter,
    categoryFilter,
    timeframeFilter,
    oiFilter,
    scoreThreshold,
    showRejected,
    query,
    showNewOnly,
    hideDrifted,
    seenKeys,
  }), [assets, filter, aiView, changedKeys, pinnedKeys, sideFilter, categoryFilter, timeframeFilter, oiFilter, scoreThreshold, showRejected, query, showNewOnly, hideDrifted, seenKeys])

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

  const markVisibleProcessed = () => {
    setProcessedKeys(prev => {
      const next = new Set(prev)
      for (const asset of rows) next.add(signalPinnedKey(asset))
      saveJson(SH_AI_PROCESSED_KEY, [...next])
      return next
    })
    setAiStatus(`已标记当前视图 ${rows.length} 条为已处理`)
  }

  const clearStatusChanges = () => {
    saveJson(SH_AI_CHANGES_KEY, [])
    setStatusChanges([])
    if (aiView === 'changed' || aiView === 'changed_up' || aiView === 'changed_down') setAiView('all')
  }

  const clearAiCache = () => {
    saveJson(SH_AI_CACHE_KEY, null)
    saveJson(SH_AI_SEEN_KEY, [])
    saveJson(SH_AI_CHANGES_KEY, [])
    saveJson(SH_AI_DIFF_KEY, { added: [], removed: [], scoreChanged: [], ts: 0 })
    setAiRunMeta(null)
    setStatusChanges([])
    setAiDiff({ added: [], removed: [], scoreChanged: [], ts: 0 })
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
    setOiFilter('all')
    setScoreThreshold(7)
    setStockFocus(true)
    setSortMode('priority')
    setAiView('all')
    setExecutionFilter('all')
    setShowRejected(false)
    setShowNewOnly(false)
    setShowUnprocessedOnly(false)
    setHideDrifted(false)
    setMergeBySymbol(false)
    setTableMode('compact')
    setShowFilters(false)
    setQuery('')
  }

  const summary = useMemo(() => {
    const all = assets.filter(asset => visibleSignal(asset, false, scoreThreshold, livePriceOf(asset)))
    return {
      total: all.length,
      ready: all.filter(asset => executionMeta(asset).key === 'ready').length,
      wait: all.filter(asset => executionMeta(asset).key === 'wait').length,
    }
  }, [assets, scoreThreshold])

  const aiSummary = useMemo(() => {
    const all = assets.filter(asset => asset.signalHunter)
    const count = status => all.filter(asset => asset.signalHunter?.status === status).length
    return {
      total: all.length,
      pinned: all.filter(asset => pinnedKeys.has(signalPinnedKey(asset))).length,
      actionable: all.filter(asset => matchesAiView(asset, 'actionable')).length,
      focus: count('triggered'),
      risk: count('risk'),
      pending: count('armed') + count('wait_entry') + count('wait_confirm'),
      watch: count('watch'),
      rejected: count('rejected'),
      changed: all.filter(asset => changedKeys.has(signalHistoryKey(asset))).length,
      changedUp: all.filter(asset => matchesAiView(asset, 'changed_up', changedKeys)).length,
      changedDown: all.filter(asset => matchesAiView(asset, 'changed_down', changedKeys)).length,
    }
  }, [assets, changedKeys, pinnedKeys])

  const aiHealth = useMemo(() => signalHunterHealth(aiRunMeta, aiSummary, aiExpired), [aiRunMeta, aiSummary, aiExpired])
  const aiReview = useMemo(() => signalHunterReviewText(aiSummary, statusChanges), [aiSummary, statusChanges])
  const activeFilterSummary = useMemo(() => {
    const parts = [
      labelOf(FILTERS, filter),
      labelOf(SIDE_FILTERS, sideFilter),
      labelOf(CATEGORY_FILTERS, categoryFilter),
      labelOf(TIMEFRAME_FILTERS, timeframeFilter),
      labelOf(OI_FILTERS, oiFilter),
      `${scoreThreshold}+`,
      labelOf(EXECUTION_FILTERS, executionFilter),
      labelOf(SORT_MODES, sortMode),
      showNewOnly ? '只看新结果' : null,
      showUnprocessedOnly ? '只看未处理' : null,
      hideDrifted ? '隐藏漂移' : null,
      mergeBySymbol ? '按标的合并' : null,
    ].filter(Boolean)
    return parts.join(' · ')
  }, [filter, sideFilter, categoryFilter, timeframeFilter, oiFilter, scoreThreshold, executionFilter, sortMode, showNewOnly, showUnprocessedOnly, hideDrifted, mergeBySymbol])

  const selectAiView = view => {
    setAiView(view)
    setFilter('all')
    setExecutionFilter('all')
    setSortMode('ai')
  }

  const toggleColumn = key => {
    setVisibleColumns(previous => {
      const next = { ...previous, [key]: !previous[key] }
      saveJson(SH_COLUMNS_KEY, next)
      return next
    })
  }

  const focusSpotlightRow = asset => {
    const key = signalKey(asset)
    setExpanded(key)
    setFocusedRow(key)
    requestAnimationFrame(() => {
      rowRefs.current.get(key)?.scrollIntoView({ behavior: 'smooth', block: 'center' })
    })
  }

  const spotlightRows = rows.slice(0, 3)
  const marketPulse = summary.ready
    ? `${summary.ready} 个信号通过硬筛且当前可盯，优先核对确认价与失效位。`
    : summary.wait
      ? `${summary.wait} 个信号通过硬筛但仍需等待价格到位。`
      : '当前没有需要追价的信号，保持观察。'
  const columnClassNames = OPTIONAL_COLUMNS
    .filter(column => !visibleColumns[column.key])
    .map(column => `signal-hunter-hide-${column.key}`)
    .join(' ')
  const aiStatusTone = /失败|错误|没有|不能|过期/.test(aiStatus) ? 'error' : 'info'
  const unprocessedCount = assets.filter(asset => asset.signalHunter && !processedKeys.has(signalPinnedKey(asset))).length
  const dataHealth = useMemo(() => {
    const checked = assets.filter(asset => asset.signalHunter || asset.dataQuality)
    const blocked = checked.filter(asset => asset.dataQuality?.ok === false || asset.signalHunter?.runtimeBlocked)
    return { checked: checked.length, blocked: blocked.length }
  }, [assets])

  return (
    <div className="page signal-hunter-page">
      {showOverview ? <>
      <section className="signal-hunter-command">
        <div className="signal-hunter-head">
          <div>
            <span className="signal-hunter-kicker">24H SIGNAL DESK</span>
            <h2>Signal Hunter <em>打榜猎人</em></h2>
            <p>{marketPulse}</p>
          </div>
          <div className="signal-hunter-head-actions">
            <span className={`signal-hunter-ai-health ${dataHealth.blocked ? 'risk' : 'good'}`}>
              数据健康 {dataHealth.blocked ? `${dataHealth.blocked}阻断` : `${dataHealth.checked}正常`}
            </span>
            <span className={`signal-hunter-ai-health ${signalCalibration.activeGroups ? 'good' : 'muted'}`}>
              复盘校准 {signalCalibration.activeGroups ? `${signalCalibration.activeGroups}组` : `${signalCalibration.eligibleSamples}/${signalCalibration.minSamples}`}
            </span>
            <span className={`signal-hunter-ai-health ${aiHealth.cls}`}>AI {aiHealth.label}</span>
            <button className="zone-btn" onClick={() => setShowOverview(false)}>收起概览</button>
            <button className="zone-btn signal-hunter-ai-btn signal-hunter-ai-main-btn" onClick={() => runAiSignalHunter()} disabled={aiBusy || !assets.length}>
              {aiBusy ? '正在扫描市场' : aiExpired ? '重新识别' : '刷新识别'}
            </button>
          </div>
        </div>
        <div className="signal-hunter-summary">
          <div><b>{aiSummary.total}</b><span>AI 原始结果</span></div>
          <div><b>{summary.total}</b><span>通过硬筛</span></div>
          <div className="positive"><b>{summary.ready}</b><span>现在可盯</span></div>
          <div className={aiSummary.risk ? 'negative' : ''}><b>{aiSummary.risk}</b><span>风险回避</span></div>
          <div><b>{aiSummary.rejected}</b><span>已剔除</span></div>
        </div>
      </section>

      <section className="signal-hunter-spotlight">
        <div className="signal-hunter-section-title">
          <div><span>PRIORITY QUEUE</span><b>当前最值得看的信号</b></div>
          <small>按执行状态、评分、距离与风险综合排序</small>
        </div>
        <div className="signal-hunter-spotlight-grid">
          {spotlightRows.length ? spotlightRows.map((asset, index) => {
            const sig = asset.signalHunter
            const exec = executionMeta(asset)
            const entry = entryPriceOf(sig)
            const next = nextStepText(asset, aiExpired)
            return (
              <button key={signalKey(asset)} className={`signal-hunter-spotlight-card rank-${index + 1}`} onClick={() => focusSpotlightRow(asset)}>
                <span className="signal-hunter-rank">#{index + 1}</span>
                <span className="signal-hunter-spotlight-symbol"><b>{asset.symbol}</b><small>{sideMeta(sig.side).label} · {sig.timeframe}</small></span>
                <span className="signal-hunter-spotlight-plan"><b>{next.label}</b><small>入场 {formatPrice(entry)} · 失效 {formatPrice(sig.stopLoss)}</small></span>
                <span className={`signal-hunter-exec ${exec.cls}`}>{exec.label}</span>
                <strong>{sig.score?.total ?? '-'}</strong>
              </button>
            )
          }) : <div className="signal-hunter-spotlight-empty">暂无优先信号，刷新识别后会在这里给出行动队列。</div>}
        </div>
      </section>
      </> : (
        <section className="signal-hunter-command-compact">
          <div>
            <span className="signal-hunter-kicker">SIGNAL HUNTER</span>
            <b>{marketPulse}</b>
          </div>
          <div className="signal-hunter-compact-stats">
            <span><strong>{summary.total}</strong> 通过硬筛</span>
            <span><strong>{summary.ready}</strong> 可盯</span>
            <span className={aiSummary.risk ? 'negative' : ''}><strong>{aiSummary.risk}</strong> 风险</span>
            <span><strong>{aiSummary.rejected}</strong> 剔除</span>
          </div>
          <div className="signal-hunter-head-actions">
            <span className={`signal-hunter-ai-health ${aiHealth.cls}`}>AI {aiHealth.label}</span>
            <button className="zone-btn" onClick={() => setShowOverview(true)}>展开概览</button>
            <button className="zone-btn signal-hunter-ai-btn" onClick={() => runAiSignalHunter()} disabled={aiBusy || !assets.length}>
              {aiBusy ? '扫描中' : '刷新识别'}
            </button>
          </div>
        </section>
      )}

      <div className={`signal-hunter-ai-summary signal-hunter-ai-summary-priority ${showOverview ? '' : 'compact'}`}>
        <button className={`signal-hunter-ai-chip signal-hunter-ai-chip-all ${aiView === 'all' ? 'active' : ''}`} onClick={() => selectAiView('all')}>
          <b>{aiSummary.total}</b>
          <span>AI原始</span>
        </button>
        <button className={`signal-hunter-ai-chip signal-hunter-ai-chip-pinned ${aiView === 'pinned' ? 'active' : ''}`} onClick={() => selectAiView('pinned')}>
          <b>{aiSummary.pinned}</b>
          <span>关注</span>
        </button>
        <button className={`signal-hunter-ai-chip signal-hunter-ai-chip-actionable ${aiView === 'actionable' ? 'active' : ''}`} onClick={() => selectAiView('actionable')}>
          <b>{aiSummary.actionable}</b>
          <span>状态可执行</span>
        </button>
        <button className={`signal-hunter-ai-chip signal-hunter-ai-chip-focus ${aiView === 'focus' ? 'active' : ''}`} onClick={() => selectAiView('focus')}>
          <b>{aiSummary.focus}</b>
          <span>已触发</span>
        </button>
        <button className={`signal-hunter-ai-chip signal-hunter-ai-chip-risk ${aiView === 'risk' ? 'active' : ''}`} onClick={() => selectAiView('risk')}>
          <b>{aiSummary.risk}</b>
          <span>风险</span>
        </button>
        <button className={`signal-hunter-ai-chip signal-hunter-ai-chip-changed ${aiView === 'changed' ? 'active' : ''}`} onClick={() => selectAiView('changed')}>
          <b>{aiSummary.changed}</b>
          <span>变化</span>
        </button>
      </div>

      <div className="signal-hunter-filter-strip">
        <button className="feed-type-btn active" onClick={() => setShowFilters(v => !v)}>
          {showFilters ? '收起筛选' : '展开筛选'}
        </button>
        <span className="signal-hunter-filter-summary">{activeFilterSummary}</span>
        <span>待确认 {aiSummary.pending} · 观察 {aiSummary.watch} · 剔除 {aiSummary.rejected} · 变强 {aiSummary.changedUp} · 变弱 {aiSummary.changedDown}</span>
      </div>

      {aiStatus && (
        <div className={`signal-hunter-status-notice ${aiStatusTone}`}>
          <span title={aiStatus}>{aiStatus}</span>
          <button type="button" onClick={() => setAiStatus('')} aria-label="关闭状态提示">×</button>
        </div>
      )}

      {showFilters && <div className="signal-hunter-interest-panel">
        <div className="signal-hunter-interest-copy">
          <b>临时标的</b>
          <span>输入一个当前管理列表里的代码，让 AI 单独补一份 SH 结构分析。</span>
        </div>
        <div className="signal-hunter-interest-controls">
          <input
            type="search"
            className="search-input signal-hunter-interest-input"
            placeholder="例如 AAPL / BTCUSDT / SPY"
            value={interestSymbol}
            onChange={e => setInterestSymbol(e.target.value.toUpperCase())}
            onKeyDown={e => {
              if (e.key === 'Enter') runInterestSignalHunter()
            }}
          />
          {interestSymbol && (
            <span className={`signal-hunter-interest-match ${interestAsset ? 'ok' : 'miss'}`}>
              {interestAsset ? `${interestAsset.symbol} · ${formatPrice(livePriceOf(interestAsset))}` : '未匹配'}
            </span>
          )}
          <button
            className="zone-btn signal-hunter-ai-btn"
            onClick={runInterestSignalHunter}
            disabled={aiBusy || !interestSymbol.trim()}
          >
            {aiBusy ? '分析中' : '分析这只'}
          </button>
        </div>
      </div>}

      {showFilters && <div className="signal-hunter-controls">
        <div className="feed-type-btns">
          {FILTERS.map(item => (
            <button
              key={item.key}
              className={`feed-type-btn ${filter === item.key ? 'active' : ''}`}
              onClick={() => { setAiView('all'); setFilter(item.key) }}
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
          {OI_FILTERS.map(item => (
            <button
              key={item.key}
              className={`feed-type-btn ${oiFilter === item.key ? 'active' : ''}`}
              onClick={() => setOiFilter(item.key)}
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
        <label className="signal-hunter-score-control">
          <span>最低评分 ≥</span>
          <input
            type="number"
            min="0"
            max="10"
            step="0.1"
            value={scoreThreshold}
            onChange={e => setScoreThreshold(e.target.value)}
          />
        </label>
        <button
          className={`feed-type-btn ${stockFocus ? 'active' : ''}`}
          onClick={() => setStockFocus(v => !v)}
        >
          Stock Focus
        </button>
        <button
          className={`feed-type-btn ${mergeBySymbol ? 'active' : ''}`}
          onClick={() => setMergeBySymbol(v => !v)}
        >
          按标的合并
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
              onClick={() => { setAiView('all'); setExecutionFilter(item.key) }}
            >
              {item.label}
            </button>
          ))}
        </div>
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
        <button className="feed-type-btn" onClick={markVisibleProcessed} disabled={!rows.length}>
          标记已处理
        </button>
        <button className="feed-type-btn" onClick={copyVisiblePlans} disabled={!rows.length}>
          复制前10
        </button>
        <button className="feed-type-btn" onClick={copyVisibleSummary} disabled={!rows.length}>
          复制摘要
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
      </div>}

      {showFilters && <div className="signal-hunter-ai-insight">
        <span>{aiReview}</span>
      </div>}

      {showFilters && aiRunMeta && (
        <div className="signal-hunter-ai-meta">
          <span>AI识别 {formatAiTime(aiRunMeta.runAt)}</span>
          <span>行情快照 {formatAiTime(aiRunMeta.snapshotAt)}</span>
          <span>写入 {aiRunMeta.live}/{aiRunMeta.total}</span>
          <span>已处理 {processedKeys.size}</span>
          <span>新增 {aiDiff.added?.length ?? 0} / 消失 {aiDiff.removed?.length ?? 0} / 分数变 {aiDiff.scoreChanged?.length ?? 0}</span>
          {aiExpired && <span className="signal-hunter-ai-expired-meta">AI结果已过期，建议重新识别</span>}
          {statusChanges.length > 0 && <span>状态变化 {statusChanges.length}</span>}
          {statusChanges.length > 0 && <button type="button" onClick={clearStatusChanges}>清变化</button>}
        </div>
      )}

      <div className="signal-hunter-table-tools">
        <div className="signal-hunter-table-search">
          <span>表格搜索</span>
          <input
            type="search"
            className="search-input signal-hunter-search"
            placeholder="搜索代码 / 形态 / 状态 / 风险..."
            value={query}
            onChange={e => setQuery(e.target.value)}
          />
          {query && <button className="feed-type-btn" onClick={() => setQuery('')}>清除</button>}
        </div>
        <div className="signal-hunter-table-actions">
          <button
            className={`feed-type-btn ${showUnprocessedOnly ? 'active' : ''}`}
            onClick={() => setShowUnprocessedOnly(value => !value)}
          >
            未处理 {unprocessedCount}
          </button>
          <button className="feed-type-btn" onClick={markVisibleProcessed} disabled={!rows.length}>
            当前全部完成
          </button>
          <details className="signal-hunter-column-picker">
            <summary>显示列</summary>
            <div>
              {OPTIONAL_COLUMNS.map(column => (
                <label key={column.key}>
                  <input type="checkbox" checked={visibleColumns[column.key]} onChange={() => toggleColumn(column.key)} />
                  {column.label}
                </label>
              ))}
              <small>品种、方向和操作列固定显示</small>
            </div>
          </details>
          <button
            className={`feed-type-btn ${tableMode === 'compact' ? 'active' : ''}`}
            onClick={() => setTableMode(mode => mode === 'compact' ? 'detail' : 'compact')}
          >
            {tableMode === 'compact' ? '详细模式' : '紧凑模式'}
          </button>
          <span className="signal-hunter-table-count">当前 {rows.length} / AI结果 {aiSummary.total}</span>
        </div>
      </div>

      <div className="signal-hunter-sticky-head" ref={stickyHeadRef}>
        <table className={`stats-table signal-hunter-table signal-hunter-head-table ${tableMode === 'compact' ? 'signal-hunter-table-compact' : ''} ${columnClassNames}`}>
          <thead>
            <tr>
              <th className="signal-hunter-index">#</th>
              <th>品种</th>
              <th>状态</th>
              <th>方向</th>
              <th>价格</th>
              <th>评分</th>
              <th>关键位</th>
              <th>风险 / 原因</th>
              <th>操作</th>
            </tr>
          </thead>
        </table>
      </div>

      <div className="signal-hunter-table-wrap" onScroll={event => {
        if (stickyHeadRef.current) stickyHeadRef.current.scrollLeft = event.currentTarget.scrollLeft
      }}>
        <table className={`stats-table signal-hunter-table ${tableMode === 'compact' ? 'signal-hunter-table-compact' : ''} ${columnClassNames}`}>
          <thead className="signal-hunter-native-head">
            <tr>
              <th className="signal-hunter-index">#</th>
              <th>品种</th>
              <th>状态</th>
              <th>方向</th>
              <th>价格</th>
              <th>评分</th>
              <th>关键位</th>
              <th>风险 / 原因</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            {!rows.length ? (
              <tr>
                <td colSpan={9} className="ai-empty">
                  <div>暂无 Signal Hunter 候选。刷新行情或等待下一次 AI 自动识别后会重新写入。</div>
                  <div className="signal-hunter-empty-diag">
                    <span>AI结果 {emptyDiagnostics.aiView}/{emptyDiagnostics.ai}</span>
                    <span>状态 {emptyDiagnostics.status}</span>
                    <span>方向 {emptyDiagnostics.side}</span>
                    <span>类别 {emptyDiagnostics.category}</span>
                    <span>周期 {emptyDiagnostics.timeframe}</span>
                    <span>资金 {emptyDiagnostics.oi}</span>
                    <span>1h/4h {emptyDiagnostics.actionableTf}</span>
                    <span>止损可执行 {emptyDiagnostics.executableStop}</span>
                    <span>入场侧 {emptyDiagnostics.entrySide}</span>
                    <span>未到目标 {emptyDiagnostics.targetRoom}</span>
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
              const priority = signalPriority(asset)
              const entryPrice = entryPriceOf(sig)
              const confirmPrice = confirmPriceOf(sig)
              const livePrice = livePriceOf(asset)
              const drift = priceDriftPct(asset)
              const stopInfo = stopDistanceInfo(asset, sig)
              const stale = Number.isFinite(drift) && Math.abs(drift) >= 1.5
              const distanceToEntry = distanceToEntryOf(sig, livePrice)
              const rejected = sig.rejected || sig.status === 'rejected'
              const isNew = !seenKeys.has(signalSeenKey(asset))
              const isPinned = pinnedKeys.has(signalPinnedKey(asset))
              const isProcessed = processedKeys.has(signalPinnedKey(asset))
              const exec = executionMeta(asset)
              const expired = aiExpired
              const statusChange = statusChangeByKey.get(signalHistoryKey(asset))
              const addedDiff = diffByKey(aiDiff, 'added').get(signalHistoryKey(asset))
              const scoreDiff = diffByKey(aiDiff, 'scoreChanged').get(signalHistoryKey(asset))
              const shSignalId = signalIdFromAsset(asset)
              const derivativeInfo = derivativesLine(asset)
              const derivativeInfoTone = derivativesTone(asset)
              const rowClasses = [
                'signal-hunter-row',
                sig.status === 'risk' ? 'signal-hunter-row-risk' : '',
                sig.status === 'triggered' ? 'signal-hunter-row-focus' : '',
                focusedRow === key ? 'signal-hunter-row-located' : '',
                expired ? 'signal-hunter-row-expired' : '',
              ].filter(Boolean).join(' ')
              const indexClasses = [
                'signal-hunter-index',
                'signal-hunter-priority-index',
                sig.status === 'risk' ? 'signal-hunter-row-risk' : '',
                sig.status === 'triggered' ? 'signal-hunter-row-focus' : '',
                expired ? 'signal-hunter-row-expired' : '',
              ].filter(Boolean).join(' ')
              const nextStep = nextStepText(asset, expired)
              const changeText = statusChangeText(statusChange, sig.status)
              const changeDirection = statusChangeDirection(statusChange, sig.status)
              return (
                <Fragment key={key}>
                  <tr
                    ref={node => {
                      if (node) rowRefs.current.set(key, node)
                      else rowRefs.current.delete(key)
                    }}
                    className={rowClasses}
                    onClick={() => {
                      setExpanded(expanded === key ? null : key)
                    }}
                    onDoubleClick={() => openChart(asset)}
                  >
                    <td className={indexClasses}>{index + 1}</td>
                    <td>
                      <button className="symbol-link-btn" onClick={e => {
                        e.stopPropagation()
                        openChart(asset)
                      }}>
                        {asset.symbol}
                      </button>
                      <span className={`badge badge-${asset.type}`}>{categoryBadge(asset)}</span>
                      {isPinned && <span className="signal-hunter-pin-badge">关注</span>}
                      {isProcessed && <span className="signal-hunter-processed-badge">已处理</span>}
                      {isNew && <span className="signal-hunter-new-badge">新</span>}
                      {stale && <span className="signal-hunter-stale-badge">漂</span>}
                      <small className="signal-id-badge">{shSignalId}</small>
                      <small>{formatTurnover(getQuoteVolume(asset))}</small>
                    </td>
                    <td>
                      <span className={`signal-hunter-status ${meta.cls}`}>{meta.label}</span>
                      <span className={`signal-hunter-exec ${exec.cls}`}>{exec.label}</span>
                      {expired && <span className="signal-hunter-expired-badge">过期</span>}
                      {addedDiff && <span className="signal-hunter-added-badge">新增</span>}
                      {scoreDiff && <span className={`signal-hunter-score-change-badge ${scoreDiff.to > scoreDiff.from ? 'up' : 'down'}`}>{scoreDiff.from.toFixed(1)}→{scoreDiff.to.toFixed(1)}</span>}
                      {statusChange && <span className={`signal-hunter-change-badge ${changeDirection}`} title={changeText}>{changeText}</span>}
                    </td>
                    <td>
                      <span className={`signal-hunter-side ${side.cls}`}>{side.label}</span>
                      <small>{sig.timeframe}</small>
                    </td>
                    <td className="signal-hunter-price-cell">
                      {formatPrice(livePrice)}
                      {tableMode === 'detail' && Number.isFinite(drift) && Math.abs(drift) >= 0.5 && <small>识别后 {fmtPct(drift)}</small>}
                      <small>入场 {rejected ? '-' : formatPrice(entryPrice)}</small>
                      {tableMode === 'detail' && <small className={distanceToEntry <= 0 ? 'pos' : ''}>距离 {fmtPct(distanceToEntry)}</small>}
                    </td>
                    <td>
                      <div className={`signal-hunter-score ${scoreClass(sig.score.total)}`}>{sig.score.total}/10</div>
                      <div className="signal-hunter-priority-score">优 {priority}</div>
                      {tableMode === 'detail' && <div className="signal-hunter-factors">
                        <span>图 {sig.score.chart}/10</span>
                        <span>数 {sig.score.data}/10</span>
                        <span>R {rewardRisk ? rewardRisk.toFixed(1) : '-'}</span>
                        <span>风 {sig.score.risk}</span>
                      </div>}
                    </td>
                    <td>
                      <div>入场 {rejected ? '-' : formatPrice(entryPrice)}</div>
                      {tableMode === 'detail' && <small>确认 {formatPrice(confirmPrice)} <span className="muted">{fmtPct(sig.distanceToConfirmPct)}</span></small>}
                      <small>失效 {formatPrice(sig.stopLoss)} <span className="muted">{fmtPct(sig.stopLossPct)}</span></small>
                      {tableMode === 'detail' && stopInfo && (
                        <small>
                          风险宽 {formatPrice(stopInfo.distance)} / {stopInfo.pct.toFixed(1)}%
                          {Number.isFinite(stopInfo.minDistance) && <span className="muted"> · min {formatPrice(stopInfo.minDistance)}</span>}
                        </small>
                      )}
                      {!rejected && <small>目标 {formatPrice(t1)} / {formatPrice(t2)} / {formatPrice(t3)}</small>}
                      {tableMode === 'detail' && <small>形态 {sig.setupLabel || setupLabel(sig.setup)} <span className="muted">{rewardRisk ? `${rewardRisk.toFixed(1)}R` : ''}</span></small>}
                      {tableMode === 'detail' && derivativeInfo && <small className={`signal-hunter-oi-line ${derivativeInfoTone}`}>资金 {derivativeInfo}</small>}
                    </td>
                    <td>
                      {riskItems(asset, stale, drift).length ? (
                        <div className="signal-hunter-risks">
                          {riskItems(asset, stale, drift).map(item => <span className={item.grade} key={item.text}>{item.grade === 'hard' ? '硬' : '软'} · {item.text}</span>)}
                        </div>
                      ) : <span className="muted">风险 -</span>}
                      <div className="signal-hunter-reasons">
                        {sig.reasons?.map(reason => <span key={reason}>{reason}</span>)}
                      </div>
                    </td>
                    <td>
                      <div className={`signal-hunter-next-step ${expired ? 'expired' : exec.key}`}>
                        <b>{nextStep.label}</b>
                        {nextStep.detail && <small>{nextStep.detail}</small>}
                      </div>
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
                        {tableMode === 'detail' && <button className="zone-btn" onClick={e => {
                          e.stopPropagation()
                          togglePinned(asset)
                        }}>
                          {isPinned ? '取消关注' : '关注'}
                        </button>}
                        <button className={`zone-btn ${isProcessed ? 'active' : ''}`} onClick={e => {
                          e.stopPropagation()
                          toggleProcessed(asset)
                        }}>
                          {isProcessed ? '撤销完成' : '完成'}
                        </button>
                        {tableMode === 'detail' && <button className="zone-btn" onClick={e => {
                          e.stopPropagation()
                          markSeen(asset)
                        }}>
                          已看
                        </button>}
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
                    <tr className="signal-hunter-detail-row">
                      <td colSpan={9}>
                        <div className="signal-hunter-card">
                          <div className="signal-hunter-card-head">
                            <div>
                              <b>{asset.symbol} · {sig.timeframe}</b>
                              <small className="signal-id-badge">{shSignalId}</small>
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
                              {derivativeInfo && <span className={`signal-hunter-oi-line ${derivativeInfoTone}`}>资金 {derivativeInfo}</span>}
                            </section>
                            <section>
                              <b>风险标记</b>
                              <div className="signal-hunter-risks">
                                {riskItems(asset, stale, drift).map(item => <span className={item.grade} key={item.text}>{item.grade === 'hard' ? '硬' : '软'} · {item.text}</span>)}
                                {!riskItems(asset, stale, drift).length && <em>暂无额外风险标记</em>}
                              </div>
                            </section>
                            <section>
                              <b>上一轮对比</b>
                              <span>{addedDiff ? '本轮新增' : '本轮延续'}</span>
                              <span>{scoreDiff ? `评分 ${scoreDiff.from.toFixed(1)} → ${scoreDiff.to.toFixed(1)}` : '评分无明显变化'}</span>
                              <span>{statusChange ? `状态 ${changeText}` : '状态无变化'}</span>
                            </section>
                            <section>
                              <b>判定依据</b>
                              <span>{sig.reasons?.length ? sig.reasons.join(' / ') : '-'}</span>
                              <span>{rejected ? `剔除：${sig.rejectReasons?.join(' / ') || '-'}` : '通过：位置、评分、R 值均达标'}</span>
                            </section>
                            <section>
                              <b>完整决策链</b>
                              {sig.decisionTrace?.length ? sig.decisionTrace.map(item => (
                                <span key={item.stage}>{item.passed ? '通过' : '阻断'} · {item.stage} · {item.detail}</span>
                              )) : <span>暂无结构化诊断记录</span>}
                            </section>
                            <section>
                              <b>观察点</b>
                              <span>确认 {formatPrice(confirmPrice)} · 入场 {rejected ? '-' : formatPrice(entryPrice)}</span>
                              <span>失效 {formatPrice(sig.stopLoss)} · 距入场 {fmtPct(distanceToEntry)}</span>
                              <span>{sig.riskFlags?.length ? `先排除：${sig.riskFlags.join(' / ')}` : rejected ? `剔除原因：${sig.rejectReasons?.join(' / ') || '-'}` : '未出现额外风险标记'}</span>
                            </section>
                          </div>
                        </div>
                      </td>
                    </tr>
                  )}
                </Fragment>
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
