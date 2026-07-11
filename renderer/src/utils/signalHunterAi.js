import { assetKey, underlyingKey } from './assetKey'
import { getQuoteVolume } from './liquidity'
import { findRecentSignalLoss, findSignalCalibration } from './signalCalibration'

const TFS = ['1h', '4h']
const VALID_STATUSES = new Set(['armed', 'wait_entry', 'triggered', 'watch', 'risk', 'rejected'])
const VALID_SIDES = new Set(['long', 'short'])
const VALID_ENTRY_MODES = new Set(['pullback', 'retest', 'base', 'breakout', 'breakdown'])

function finite(v) {
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

function clamp(v, min, max) {
  const n = finite(v)
  if (n == null) return min
  return Math.max(min, Math.min(max, n))
}

function pct(from, to) {
  if (!Number.isFinite(from) || !Number.isFinite(to) || !from) return null
  return ((to - from) / from) * 100
}

function pickTf(asset) {
  const localTf = asset.signalHunter?.timeframe
  if (TFS.includes(localTf)) return localTf
  const scores = asset.signalScore ?? {}
  return TFS
    .map(tf => [tf, Math.abs(Number(scores[tf]) || 0)])
    .sort((a, b) => b[1] - a[1])[0]?.[0] ?? '1h'
}

function candidatePriority(asset) {
  const turnover = getQuoteVolume(asset)
  const score = Math.max(0, ...Object.values(asset.signalScore ?? {}).map(v => Math.abs(Number(v) || 0)))
  const derivativeScore = Math.abs(Number(asset.derivatives?.score) || 0)
  const localScore = Number(asset.signalHunter?.score?.total) || 0
  const move = Math.abs(Number(asset.change24h) || 0)
  return score * 16 + derivativeScore * 10 + localScore * 8 + Math.min(20, move * 2) + Math.min(12, Math.log10(turnover / 1_000_000 + 1) * 4)
}

export function buildSignalHunterAiCandidate(asset) {
  if (!Number.isFinite(Number(asset?.price))) return null
  const tf = pickTf(asset)
  const signal = TFS.includes(asset.signalHunter?.timeframe) ? asset.signalHunter : null
  const localStructures = Array.isArray(signal?.structureCandidates) && signal.structureCandidates.length
    ? signal.structureCandidates
    : signal ? [signal] : []
  const timeframeCandidates = localStructures.map(local => ({
    status: local.status,
    rejected: Boolean(local.rejected),
    side: local.side,
    timeframe: local.timeframe,
    entryMode: local.entryMode,
    setup: local.setup,
    setupLabel: local.setupLabel,
    currentPrice: finite(local.currentPrice ?? asset.price),
    entryPrice: finite(local.entryPrice),
    executionEntryPrice: finite(local.executionEntryPrice),
    executionSlippagePct: finite(local.executionSlippagePct),
    confirmPrice: finite(local.confirmPrice),
    stopLoss: finite(local.stopLoss),
    targets: (local.targets ?? [local.tp1, local.tp2, local.tp3]).map(finite).filter(v => v != null),
    rewardRisk: finite(local.rewardRisk ?? local.score?.rewardRisk),
    score: local.score,
    support: finite(local.support),
    supportTouches: finite(local.supportTouches),
    resistance: finite(local.resistance),
    resistanceTouches: finite(local.resistanceTouches),
    compression: Boolean(local.compression),
    recentRangePct: finite(local.recentRangePct),
    volumeRatio: finite(local.volumeRatio),
    runup10: finite(local.runup10),
    runup20: finite(local.runup20),
    ema21: finite(local.ema21),
    ema55: finite(local.ema55),
    ema21DistancePct: finite(local.ema21DistancePct),
    ema21SlopePct: finite(local.ema21SlopePct),
    atr: finite(local.atr),
    atrPct: finite(local.atrPct),
    atrExpansion: finite(local.atrExpansion),
    efficiencyRatio: finite(local.efficiencyRatio),
    marketRegime: local.marketRegime ?? null,
    parameterProfile: local.parameterProfile ?? null,
    entryTouched: Boolean(local.entryTouched),
    executionEligible: Boolean(local.executionEligible),
    executionTier: local.executionTier ?? 'observe',
    reasons: local.reasons ?? [],
    riskFlags: local.riskFlags ?? [],
    rejectReasons: local.rejectReasons ?? [],
  }))
  const deterministicPlan = timeframeCandidates
    .filter(local => !local.rejected)
    .sort((a, b) => Number(b.executionEligible) - Number(a.executionEligible) || (Number(b.score?.total) || 0) - (Number(a.score?.total) || 0))[0] ?? null
  return {
    key: assetKey(asset),
    symbol: asset.symbol,
    name: asset.name,
    apiSymbol: asset.apiSymbol,
    source: asset.source,
    type: asset.type,
    price: finite(asset.price),
    change24h: finite(asset.change24h),
    turnover: getQuoteVolume(asset),
    preferredTimeframe: tf,
    rsi: Object.fromEntries(['15m', '1h', '4h', '1d'].map(k => [k, finite(asset.rsi?.[k])])),
    signalScore: asset.signalScore ?? {},
    volumeSignal: asset.volumeSignal ?? {},
    derivatives: asset.derivatives ?? null,
    liquidity: asset.liquidity ?? null,
    marketSession: asset.marketSession ?? null,
    dataQuality: asset.dataQuality ?? null,
    localSignalHunter: signal ? {
      status: signal.status,
      side: signal.side,
      timeframe: signal.timeframe,
      entryMode: signal.entryMode,
      setup: signal.setup,
      score: signal.score,
      currentPrice: finite(signal.currentPrice),
      entryPrice: finite(signal.entryPrice ?? signal.triggerPrice),
      confirmPrice: finite(signal.confirmPrice),
      stopLoss: finite(signal.stopLoss),
      targets: [finite(signal.tp1), finite(signal.tp2), finite(signal.tp3)],
      rewardRisk: finite(signal.rewardRisk ?? signal.score?.rewardRisk),
      reasons: signal.reasons ?? [],
      riskFlags: signal.riskFlags ?? [],
      narrativeSummary: signal.narrativeSummary ?? '',
      narrativeTags: signal.narrativeTags ?? [],
      rejectReasons: signal.rejectReasons ?? [],
    } : null,
    timeframeCandidates,
    deterministicPlan,
    shadowComparison: signal?.shadowComparison ?? null,
    priority: Math.round(candidatePriority(asset)),
  }
}

export function buildSignalHunterAiCandidates(assets, limit = 60) {
  return assets
    .map(buildSignalHunterAiCandidate)
    .filter(Boolean)
    .filter(candidate => candidate.deterministicPlan)
    .filter(c => {
      const minPriority = c.type === 'crypto' ? 14 : 8
      return c.priority >= minPriority || c.turnover >= 1_000_000
    })
    .sort((a, b) => b.priority - a.priority)
    .slice(0, limit)
}

function localRiskFlags(asset) {
  const flags = []
  const turnover = getQuoteVolume(asset)
  const derivatives = asset.derivatives
  const oi4h = finite(derivatives?.oiChange4h)
  const oi1h = finite(derivatives?.oiChange1h)
  const fundingRate = finite(derivatives?.fundingRate)
  const oiRef = oi4h ?? oi1h
  if (!turnover) flags.push('成交额缺失，流动性风险待确认')
  else if (turnover < 5_000_000) flags.push(`24h成交额 ${Math.round(turnover).toLocaleString()} < 5M，流动性不足`)
  if (asset.source === 'binance-futures' && !asset.derivatives) flags.push('OI / 资金费率数据缺失')
  if (asset.source === 'binance-futures' && Number.isFinite(oiRef) && oiRef <= -3) {
    flags.push(`OI${oi4h != null ? '4h' : '1h'}下降 ${Math.abs(oiRef).toFixed(1)}%，持续性存疑`)
  }
  if (Number.isFinite(fundingRate) && Math.abs(fundingRate) >= 0.06) {
    flags.push(`资金费率 ${fundingRate.toFixed(3)}%，拥挤度偏高`)
  }
  return flags
}

function localDerivativesReasons(asset) {
  const d = asset.derivatives
  if (!d) return []
  const reasons = []
  const oi4h = finite(d.oiChange4h)
  const oi1h = finite(d.oiChange1h)
  const fundingRate = finite(d.fundingRate)
  const oiRef = oi4h ?? oi1h
  if (Number.isFinite(oiRef)) {
    const tf = oi4h != null ? '4h' : '1h'
    const tone = oiRef >= 3 ? '增仓配合' : oiRef <= -3 ? '减仓压制' : '变化平缓'
    reasons.push(`OI${tf} ${oiRef >= 0 ? '+' : ''}${oiRef.toFixed(1)}% · ${tone}`)
  }
  if (d.label) reasons.push(`资金结构：${d.label}`)
  if (Number.isFinite(fundingRate)) reasons.push(`资金费率 ${fundingRate.toFixed(3)}%`)
  return reasons
}

export function signalHunterCandidateSignature(candidates) {
  return (candidates ?? [])
    .slice(0, 60)
    .map(c => `${c.key}:${c.price}:${c.preferredTimeframe}:${c.priority}`)
    .join('|')
}

function normalizeTargets(item) {
  const raw = item.targets ?? item.tps ?? item.tp ?? item.takeProfit ?? []
  return Array.isArray(raw) ? raw.map(finite).filter(v => v != null).slice(0, 3) : []
}

function deriveRewardRisk(side, entry, stop, targets) {
  if (!Number.isFinite(entry) || !Number.isFinite(stop) || !targets.length) return null
  const risk = Math.abs(stop - entry)
  if (!risk) return null
  const mainTarget = targets[Math.min(1, targets.length - 1)]
  const reward = Math.abs(mainTarget - entry)
  if (!reward) return null
  return Number((reward / risk).toFixed(2))
}

function reachedTargets(side, currentPrice, targets) {
  if (!Number.isFinite(currentPrice)) return []
  return (targets ?? []).filter(target => Number.isFinite(target) && (
    side === 'short' ? currentPrice <= target * 1.001 : currentPrice >= target * 0.999
  ))
}

function remainingTargets(side, currentPrice, targets) {
  const reached = new Set(reachedTargets(side, currentPrice, targets))
  return (targets ?? []).filter(target => !reached.has(target))
}

function inferEntryMode(item, side, currentPrice, entryPrice) {
  const explicit = String(item.entryMode ?? item.entryTrigger ?? '').toLowerCase()
  if (VALID_ENTRY_MODES.has(explicit)) return explicit
  const setup = String(item.setup ?? item.setupLabel ?? '').toLowerCase()
  if (setup.includes('break') || setup.includes('突破')) return side === 'short' ? 'breakdown' : 'breakout'
  if (setup.includes('base') || setup.includes('蓄势') || setup.includes('震荡')) return 'base'
  if (setup.includes('retest') || setup.includes('支阻') || setup.includes('回测')) return 'retest'
  if (Number.isFinite(currentPrice) && Number.isFinite(entryPrice)) {
    if (side === 'long' && entryPrice > currentPrice) return 'breakout'
    if (side === 'short' && entryPrice < currentPrice) return 'breakdown'
  }
  return 'pullback'
}

function normalizedTimestamp(value) {
  const n = finite(value)
  if (!Number.isFinite(n)) return null
  return n < 10_000_000_000 ? n * 1000 : n
}

function marketDataAge(asset, timeframe, now = Date.now()) {
  const candles = asset?.reviewCandlesByTf?.[timeframe]
  const latest = Array.isArray(candles) ? candles.at(-1) : null
  const ts = normalizedTimestamp(latest?.closeTime ?? latest?.time)
  return Number.isFinite(ts) ? Math.max(0, now - ts) : null
}

function latestCandleCloseTime(asset, timeframe) {
  const candles = asset?.reviewCandlesByTf?.[timeframe]
  const latest = Array.isArray(candles) ? candles.at(-1) : null
  return normalizedTimestamp(latest?.closeTime ?? latest?.time)
}

function signalPlanTtl(timeframe) {
  return timeframe === '4h' ? 36 * 60 * 60 * 1000 : 8 * 60 * 60 * 1000
}

function localStructureContext(asset, timeframe, side) {
  const structures = asset?.signalHunter?.structureCandidates ?? []
  const selected = structures.find(item => item.timeframe === timeframe && item.side === side && !item.rejected)
  if (!selected) return { selected: null, conflict: null, crossTimeframeConfirmed: false }
  const selectedScore = Number(selected.score?.total) || 0
  const conflict = structures.find(item =>
    !item.rejected &&
    item.side !== side &&
    (Number(item.score?.total) || 0) >= selectedScore - (item.timeframe === timeframe ? 0.8 : 0.4))
  const crossTimeframeConfirmed = structures.some(item =>
    !item.rejected && item.side === side && item.timeframe !== timeframe && (Number(item.score?.total) || 0) >= 6)
  return { selected, conflict, crossTimeframeConfirmed }
}

function deterministicLocalPlan(asset) {
  const structures = asset?.signalHunter?.structureCandidates ?? []
  return structures
    .filter(item => !item.rejected && VALID_SIDES.has(item.side) && TFS.includes(item.timeframe))
    .sort((a, b) => Number(b.executionEligible) - Number(a.executionEligible) || (Number(b.score?.total) || 0) - (Number(a.score?.total) || 0))[0] ?? null
}

function closePrice(a, b, tolerance = 0.015) {
  if (!Number.isFinite(a) || !Number.isFinite(b)) return false
  return Math.abs(a - b) / Math.max(Math.abs(a), Math.abs(b), 1e-9) <= tolerance
}

function sameSignalIdentity(prior, current, allowFirstSeenRejected = false) {
  return Boolean(prior) &&
    (prior.status !== 'rejected' || prior.planExpired || (allowFirstSeenRejected && prior.stability?.basis === 'first_seen')) &&
    prior.side === current.side &&
    prior.timeframe === current.timeframe &&
    inferEntryMode(prior, prior.side, prior.currentPrice, prior.entryPrice) === current.entryMode &&
    closePrice(prior.entryPrice, current.entryPrice)
}

function closedCandleEntryConfirmed(asset, signal, afterTime = null) {
  const candles = asset?.reviewCandlesByTf?.[signal.timeframe]
  if (!Array.isArray(candles) || !candles.length || !Number.isFinite(signal.entryPrice)) return false
  const eligible = Number.isFinite(afterTime)
    ? candles.filter(candle => {
      const ts = normalizedTimestamp(candle?.closeTime ?? candle?.time)
      return Number.isFinite(ts) && ts > afterTime
    })
    : candles
  const recent = eligible.slice(-3)
  if (!recent.length) return false
  if (signal.entryMode === 'breakout') {
    return Number.isFinite(recent.at(-1)?.close) && recent.at(-1).close >= signal.entryPrice * 1.001
  }
  if (signal.entryMode === 'breakdown') {
    return Number.isFinite(recent.at(-1)?.close) && recent.at(-1).close <= signal.entryPrice * 0.999
  }
  return recent.some(candle => {
    if (!Number.isFinite(candle.high) || !Number.isFinite(candle.low) || !Number.isFinite(candle.close)) return false
    const range = Math.max(candle.high - candle.low, signal.entryPrice * 0.0001)
    const closePosition = (candle.close - candle.low) / range
    return signal.side === 'short'
      ? candle.high >= signal.entryPrice * 0.999 && candle.close <= signal.entryPrice * 1.002 && closePosition <= 0.58
      : candle.low <= signal.entryPrice * 1.001 && candle.close >= signal.entryPrice * 0.998 && closePosition >= 0.42
  })
}

function signalStability(previous, current, crossTimeframeConfirmed) {
  const prior = previous?.signalHunter
  const sameIdentity = sameSignalIdentity(prior, current, true)
  const streak = sameIdentity ? Math.min(20, (prior.stability?.streak ?? 1) + 1) : 1
  const immediate = current.status === 'triggered' || crossTimeframeConfirmed
  return {
    streak,
    confirmed: immediate || streak >= 2,
    basis: crossTimeframeConfirmed ? 'cross_timeframe' : immediate ? 'triggered' : streak >= 2 ? 'repeated_scan' : 'first_seen',
  }
}

function entryQualityDelta({ status, timeframe, distanceToEntryPct, entryPrice, stopLoss, asset }) {
  const distance = Math.abs(Number(distanceToEntryPct) || 0)
  const stopPct = Number.isFinite(entryPrice) && Number.isFinite(stopLoss) && entryPrice
    ? (Math.abs(entryPrice - stopLoss) / Math.abs(entryPrice)) * 100
    : null
  const minStop = minExecutableStopDistance(asset, { entryPrice, stopLoss, timeframe })
  const stopDistance = Number.isFinite(entryPrice) && Number.isFinite(stopLoss)
    ? Math.abs(entryPrice - stopLoss)
    : null
  const stopRatio = Number.isFinite(minStop) && Number.isFinite(stopDistance) && minStop
    ? stopDistance / minStop
    : null

  let delta = 0
  if (timeframe === '4h') delta += 0.12
  if (timeframe === '1h') delta -= 0.12
  if (status === 'triggered' && distance >= 1.2) delta -= 0.35
  else if (distance >= 2.4) delta -= 0.42
  else if (distance >= 1.4) delta -= 0.24
  else if (distance >= 0.25 && distance <= 0.9) delta += 0.12
  if (Number.isFinite(stopRatio)) {
    if (stopRatio < 1.12) delta -= 0.36
    else if (stopRatio < 1.35) delta -= 0.18
    else if (stopRatio >= 1.8 && stopRatio <= 3.6) delta += 0.12
  }
  if (Number.isFinite(stopPct)) {
    if (timeframe === '1h' && stopPct > 8) delta -= 0.18
    if (timeframe === '4h' && stopPct > 12) delta -= 0.14
  }
  return delta
}

function recalibrateSignalScore({ total, chart, data, risk, rewardRisk, status, timeframe, riskFlags, distanceToEntryPct, asset, side, currentPrice, entryPrice, stopLoss, targets, historyCalibration, stability }) {
  if (!Number.isFinite(total)) return total
  const flags = Array.isArray(riskFlags) ? riskFlags.filter(Boolean).length : 0
  const rr = Number.isFinite(rewardRisk) ? rewardRisk : 0
  const chartScore = clamp(Number(chart) || 0, 0, 10)
  const dataScore = clamp(Number(data) || 0, 0, 10)
  const riskScore = clamp(Number(risk) || 0, -3, 2)
  const distance = Math.abs(Number(distanceToEntryPct) || 0)
  const turnover = getQuoteVolume(asset)
  const derivatives = asset?.derivatives
  const oi4h = finite(derivatives?.oiChange4h)
  const oi1h = finite(derivatives?.oiChange1h)
  const fundingRate = finite(derivatives?.fundingRate)
  const oiRef = oi4h ?? oi1h
  const oiWeight = timeframe === '1h' ? 1.55 : timeframe === '4h' ? 1.25 : 1

  const rrComponent = clamp(1.2 + (rr - 1.5) * 0.55, 0, 2)
  const riskControlComponent = ((riskScore + 3) / 5) * 2
  const evidenceScore =
    chartScore * 0.4 +
    dataScore * 0.2 +
    rrComponent +
    riskControlComponent

  let delta = 0
  delta += status === 'triggered' ? 0.18 : status === 'wait_entry' ? 0.05 : status === 'risk' ? -0.45 : status === 'rejected' ? -0.8 : 0
  delta -= Math.min(0.35, flags * 0.12)
  delta -= Math.min(0.28, distance * 0.025)
  delta += entryQualityDelta({ status, timeframe, distanceToEntryPct, entryPrice, stopLoss, asset })
  if (reachedTargets(side, currentPrice, targets).length) delta -= 0.35
  if (turnover >= 50_000_000) delta += 0.12
  else if (turnover > 0 && turnover < 5_000_000) delta -= 0.18
  if (Number.isFinite(derivatives?.score)) {
    const directionalScore = side === 'short' ? -Number(derivatives.score) : Number(derivatives.score)
    delta += Math.max(-0.36, Math.min(0.42, directionalScore * 0.08 * oiWeight))
  }
  if (Number.isFinite(oiRef)) {
    const alignedStage = side === 'short'
      ? derivatives?.stage === 'short_build'
      : derivatives?.stage === 'early_build' || derivatives?.stage === 'long_build'
    const opposedStage = side === 'short'
      ? derivatives?.stage === 'early_build' || derivatives?.stage === 'long_build'
      : derivatives?.stage === 'short_build'
    if (oiRef >= 3 && alignedStage) delta += (oiRef >= 8 ? 0.26 : 0.16) * oiWeight
    else if (oiRef >= 3 && opposedStage) delta -= 0.22 * oiWeight
    else if (oiRef <= -6) delta -= 0.42 * oiWeight
    else if (oiRef <= -3) delta -= 0.25 * oiWeight
  }
  if (Number.isFinite(fundingRate) && Math.abs(fundingRate) >= 0.06) {
    const crowdedSameSide = side === 'short' ? fundingRate < 0 : fundingRate > 0
    delta += (crowdedSameSide ? -0.22 : -0.08) * oiWeight
  }
  if (historyCalibration?.active) delta += historyCalibration.delta
  if (stability?.basis === 'first_seen') delta -= 0.25
  else if (stability?.basis === 'repeated_scan') delta += Math.min(0.12, stability.streak * 0.025)
  else if (stability?.basis === 'cross_timeframe') delta += 0.1

  const blendedScore = total * 0.6 + evidenceScore * 0.4
  return Number(clamp(blendedScore + delta, 0, 10).toFixed(1))
}

export function minExecutableStopDistance(asset, sig) {
  const entry = finite(sig.entryPrice)
  if (!Number.isFinite(entry) || entry <= 0) return null

  const tfMult = sig.timeframe === '4h' ? 2 : sig.timeframe === '1h' ? 1.4 : 1
  const atrFloor = Number.isFinite(finite(sig.atr)) ? finite(sig.atr) * (sig.timeframe === '4h' ? 0.75 : 0.65) : 0
  if (asset.type === 'stock' || asset.type === 'tradfi') {
    const minPct = entry < 50 ? 0.018 : entry < 200 ? 0.015 : 0.012
    const minAbs = entry < 50 ? 0.50 : entry < 200 ? 1.00 : 2.00
    return Math.max(entry * minPct * tfMult, minAbs * tfMult, atrFloor)
  }
  return Math.max(entry * (sig.timeframe === '4h' ? 0.018 : sig.timeframe === '1h' ? 0.012 : 0.008), atrFloor)
}

export function hasExecutableStopDistance(asset, sig) {
  const minDistance = minExecutableStopDistance(asset, sig)
  if (!Number.isFinite(minDistance) || !Number.isFinite(sig?.entryPrice) || !Number.isFinite(sig?.stopLoss)) return false
  return Math.abs(sig.entryPrice - sig.stopLoss) >= minDistance
}

function legalizeStatus(side, entryMode, status, currentPrice, entryPrice) {
  if (!Number.isFinite(currentPrice) || !Number.isFinite(entryPrice)) return status
  const continuation = entryMode === 'breakout' || entryMode === 'breakdown'
  if (continuation && side === 'short' && currentPrice <= entryPrice) return 'triggered'
  if (continuation && side === 'long' && currentPrice >= entryPrice) return 'triggered'
  if (!continuation && side === 'short' && currentPrice >= entryPrice) return 'triggered'
  if (!continuation && side === 'long' && currentPrice <= entryPrice) return 'triggered'
  return status
}

function validateSignal(sig, asset) {
  const reasons = []
  const targets = Array.isArray(sig.targets) ? sig.targets : []
  if (!VALID_SIDES.has(sig.side)) reasons.push('方向无效')
  if (!TFS.includes(sig.timeframe)) reasons.push('周期无效')
  if (!VALID_ENTRY_MODES.has(sig.entryMode)) reasons.push('入场模型无效')
  if (sig.dataFreshness?.stale) reasons.push(`行情数据过期：${sig.timeframe} K线已延迟 ${sig.dataFreshness.ageHours.toFixed(1)} 小时`)
  if (sig.structureConflict) reasons.push(`多空结构冲突：${sig.structureConflict.timeframe} ${sig.structureConflict.side === 'short' ? '空' : '多'}方评分接近`)
  if (sig.lossCooldown) reasons.push(`同类结构刚止损，冷却剩余 ${(sig.lossCooldown.remainingMs / 3_600_000).toFixed(1)} 小时`)
  if (sig.planExpired) reasons.push('冻结计划已超过结构有效期，需要形成新结构')
  if (sig.localPlanMissing) reasons.push('本地规则没有形成可执行结构')
  if (!Number.isFinite(sig.entryPrice)) reasons.push('入场价无效')
  if (!Number.isFinite(sig.stopLoss)) reasons.push('失效价无效')
  if (!Number.isFinite(sig.currentPrice)) reasons.push('现价无效')
  if (!targets.length) reasons.push('目标位缺失')
  if ((sig.score?.total ?? 0) < 7) reasons.push('评分低于 7')
  if (!Number.isFinite(sig.rewardRisk) || sig.rewardRisk < 1.5) reasons.push('低于 1.5R')
  if (sig.side === 'long' && Number.isFinite(sig.stopLoss) && Number.isFinite(sig.entryPrice) && sig.stopLoss >= sig.entryPrice) reasons.push('做多失效价应低于入场')
  if (sig.side === 'short' && Number.isFinite(sig.stopLoss) && Number.isFinite(sig.entryPrice) && sig.stopLoss <= sig.entryPrice) reasons.push('做空失效价应高于入场')
  if (sig.side === 'long' && Number.isFinite(sig.currentPrice) && Number.isFinite(sig.stopLoss) && sig.currentPrice <= sig.stopLoss) reasons.push('现价已经跌破失效位')
  if (sig.side === 'short' && Number.isFinite(sig.currentPrice) && Number.isFinite(sig.stopLoss) && sig.currentPrice >= sig.stopLoss) reasons.push('现价已经升破失效位')
  if (sig.status === 'triggered' && sig.stability?.streak === 1 && Number.isFinite(sig.entryProgressR) && sig.entryProgressR >= 0.6) {
    reasons.push(`首次识别时已离开入场位 ${sig.entryProgressR.toFixed(2)}R，避免迟到信号`)
  }
  if (sig.side === 'long' && targets.some(target => !Number.isFinite(target) || target <= sig.entryPrice)) reasons.push('做多目标位应高于入场')
  if (sig.side === 'short' && targets.some(target => !Number.isFinite(target) || target >= sig.entryPrice)) reasons.push('做空目标位应低于入场')
  const reached = reachedTargets(sig.side, sig.currentPrice, targets)
  const remaining = remainingTargets(sig.side, sig.currentPrice, targets)
  if (targets.length && !remaining.length) reasons.push('全部结构目标已到，避免追单')
  if (reached.length && remaining.length) {
    const residualRewardRisk = deriveRewardRisk(sig.side, sig.currentPrice, sig.stopLoss, remaining)
    if (!Number.isFinite(residualRewardRisk) || residualRewardRisk < 1.2) reasons.push('到达部分目标后，剩余空间低于 1.2R')
  }
  const ordered = [...targets].sort((a, b) => sig.side === 'short' ? b - a : a - b)
  if (ordered.some((target, index) => target !== targets[index])) reasons.push('目标位顺序无效')
  if (new Set(targets.map(target => Number(target).toPrecision(12))).size !== targets.length) reasons.push('目标位重复')
  const minStopDistance = minExecutableStopDistance(asset, sig)
  if (Number.isFinite(minStopDistance) && Number.isFinite(sig.entryPrice) && Number.isFinite(sig.stopLoss)) {
    const stopDistance = Math.abs(sig.entryPrice - sig.stopLoss)
    if (stopDistance < minStopDistance) {
      reasons.push(`失效距离过窄：${stopDistance.toFixed(2)} < 最小可执行 ${minStopDistance.toFixed(2)}`)
    }
  }
  return reasons
}

export function normalizeSignalHunterAiResults(aiResult, assets, calibration = null, previousItems = []) {
  const items = Array.isArray(aiResult?.items)
    ? aiResult.items
    : Array.isArray(aiResult?.signals)
      ? aiResult.signals
      : []
  const bySymbol = new Map(assets.map(asset => [String(asset.symbol).toUpperCase(), asset]))
  const byKey = new Map(assets.map(asset => [assetKey(asset), asset]))
  const previousByKey = new Map((previousItems ?? []).map(item => [item.key ?? assetKey(item), item]))

  return items.map(item => {
    const ref = String(item.key ?? '').trim()
    const asset = byKey.get(ref) ?? bySymbol.get(String(item.symbol ?? '').toUpperCase())
    if (!asset) return null

    const localPlan = deterministicLocalPlan(asset)
    const rawSide = String(localPlan?.side ?? item.side ?? '').toLowerCase()
    const side = VALID_SIDES.has(rawSide) ? rawSide : 'invalid'
    const currentPrice = finite(asset.price ?? item.currentPrice ?? item.price)
    const proposedEntryPrice = finite(localPlan?.entryPrice ?? item.entryPrice ?? item.entry ?? item.triggerPrice)
    const proposedExecutionEntryPrice = finite(localPlan?.executionEntryPrice ?? proposedEntryPrice)
    const proposedConfirmPrice = finite(localPlan?.confirmPrice ?? item.confirmPrice ?? item.confirm ?? proposedEntryPrice)
    const proposedStopLoss = finite(localPlan?.stopLoss ?? item.stopLoss ?? item.stop)
    const proposedTargets = localPlan?.targets?.map(finite).filter(Number.isFinite) ?? normalizeTargets(item)
    const statusInput = localPlan?.status ?? item.status
    const rawStatus = VALID_STATUSES.has(String(statusInput)) ? String(statusInput) : 'watch'
    const localTotal = finite(localPlan?.score?.total)
    const localChart = finite(localPlan?.score?.chart)
    const localData = finite(localPlan?.score?.data)
    const localRisk = finite(localPlan?.score?.risk)
    const rawTotal = Number(clamp(localTotal ?? item.score?.total ?? item.totalScore ?? item.score, 0, 10).toFixed(1))
    const chart = Number(clamp(localChart == null ? item.score?.chart ?? item.chartScore : (localChart / 8) * 10, 0, 10).toFixed(1))
    const data = Number(clamp(localData == null ? item.score?.data ?? item.dataScore : (localData / 6) * 10, 0, 10).toFixed(1))
    const risk = Number(clamp(localRisk == null ? item.score?.risk ?? item.riskScore : 2 - (localRisk / 6) * 5, -3, 2).toFixed(1))
    const timeframeCandidate = localPlan?.timeframe ?? item.timeframe
    const timeframe = TFS.includes(timeframeCandidate) ? timeframeCandidate : 'invalid'
    const proposedEntryMode = localPlan?.entryMode ?? inferEntryMode(item, side, currentPrice, proposedEntryPrice)
    const previousSignal = previousByKey.get(assetKey(asset))?.signalHunter
    const proposedIdentity = { side, timeframe, entryMode: proposedEntryMode, entryPrice: proposedEntryPrice }
    const continueFrozenPlan = sameSignalIdentity(previousSignal, proposedIdentity, true)
    const entryMode = continueFrozenPlan ? previousSignal.entryMode : proposedEntryMode
    const entryPrice = continueFrozenPlan ? finite(previousSignal.entryPrice) : proposedEntryPrice
    const executionEntryPrice = continueFrozenPlan
      ? finite(previousSignal.executionEntryPrice ?? previousSignal.entryPrice)
      : proposedExecutionEntryPrice
    const confirmPrice = continueFrozenPlan ? finite(previousSignal.confirmPrice ?? previousSignal.entryPrice) : proposedConfirmPrice
    const stopLoss = continueFrozenPlan ? finite(previousSignal.stopLoss) : proposedStopLoss
    const previousTargets = normalizeTargets(previousSignal ?? {})
    const targets = continueFrozenPlan && previousTargets.length ? previousTargets : proposedTargets
    const rewardRisk = deriveRewardRisk(side, executionEntryPrice ?? entryPrice, stopLoss, targets)
    const now = Date.now()
    const detectedAt = continueFrozenPlan
      ? finite(previousSignal.detectedAt ?? previousSignal.planFrozenAt) ?? now
      : now
    const detectedCandleCloseTime = continueFrozenPlan
      ? finite(previousSignal.detectedCandleCloseTime) ?? latestCandleCloseTime(asset, timeframe)
      : latestCandleCloseTime(asset, timeframe)
    const planExpiresAt = detectedAt + signalPlanTtl(timeframe)
    const planExpired = continueFrozenPlan && previousSignal.status !== 'triggered' && now > planExpiresAt
    const legalizedStatus = legalizeStatus(side, entryMode, rawStatus, currentPrice, entryPrice)
    const historyCalibration = findSignalCalibration(calibration, { timeframe, side, entryMode })
    const lossCooldown = findRecentSignalLoss(calibration, {
      symbol: asset.symbol,
      timeframe,
      side,
      entryMode,
      entryPrice,
      executionEntryPrice,
      executionSlippagePct: continueFrozenPlan
        ? finite(previousSignal.executionSlippagePct) ?? 0
        : finite(localPlan?.executionSlippagePct) ?? 0,
      executionNotional: continueFrozenPlan
        ? finite(previousSignal.executionNotional) ?? 5000
        : finite(localPlan?.executionNotional) ?? 5000,
    })
    const structureContext = localStructureContext(asset, timeframe, side)
    const identity = { side, timeframe, entryMode, entryPrice }
    const previouslyTriggered = previousSignal?.status === 'triggered' && sameSignalIdentity(previousSignal, identity)
    const closedCandleConfirmed = previouslyTriggered ||
      closedCandleEntryConfirmed(asset, identity, detectedCandleCloseTime)
    const triggerEligibleStatus = ['armed', 'wait_entry', 'triggered'].includes(legalizedStatus)
    const status = triggerEligibleStatus
      ? closedCandleConfirmed ? 'triggered' : 'armed'
      : legalizedStatus
    const entryConfirmationPending = triggerEligibleStatus && !closedCandleConfirmed
    const stability = signalStability(previousByKey.get(assetKey(asset)), { side, timeframe, entryMode, entryPrice, status }, structureContext.crossTimeframeConfirmed)
    const dataAgeMs = marketDataAge(asset, timeframe)
    const staleAfterMs = timeframe === '4h' ? 12 * 60 * 60 * 1000 : 3 * 60 * 60 * 1000
    const dataFreshness = {
      ageMs: dataAgeMs,
      ageHours: Number(((dataAgeMs ?? 0) / 3_600_000).toFixed(1)),
      stale: asset.source === 'binance-futures' && (!Number.isFinite(dataAgeMs) || dataAgeMs > staleAfterMs),
    }
    const localStructures = asset.signalHunter?.structureCandidates ?? []
    const matchedLocal = localStructures.find(local => local.timeframe === timeframe && local.side === side)
      ?? localStructures.find(local => local.timeframe === timeframe)
      ?? (asset.signalHunter?.timeframe === timeframe ? asset.signalHunter : null)
    const atr = finite(item.atr) ?? finite(matchedLocal?.atr)
    const riskUnit = Number.isFinite(entryPrice) && Number.isFinite(stopLoss) ? Math.abs(entryPrice - stopLoss) : null
    const favorableMove = side === 'short' ? entryPrice - currentPrice : currentPrice - entryPrice
    const entryProgressR = Number.isFinite(riskUnit) && riskUnit > 0 && Number.isFinite(favorableMove)
      ? Number((favorableMove / riskUnit).toFixed(2))
      : null
    const aiReasons = Array.isArray(item.reasons) ? item.reasons : [item.reason].filter(Boolean)
    const baseReasons = [...new Set([...(localPlan?.reasons ?? []), ...aiReasons])]
    const riskFlags = Array.isArray(item.riskFlags) ? item.riskFlags : [item.risk].filter(Boolean)
    const narrativeTags = Array.isArray(item.narrativeTags) ? item.narrativeTags : []
    const localRisks = localRiskFlags(asset)
    const derivativeReasons = localDerivativesReasons(asset)
    const deterministicRiskFlags = [...new Set([...(localPlan?.riskFlags ?? []), ...localRisks])]
    const allRiskFlags = [...new Set([...deterministicRiskFlags, ...riskFlags])].slice(0, 8)
    const calibrationReason = historyCalibration?.active
      ? `复盘校准 ${historyCalibration.delta >= 0 ? '+' : ''}${historyCalibration.delta.toFixed(2)} · ${historyCalibration.samples}单/${historyCalibration.averageR.toFixed(2)}R`
      : null
    const planReason = continueFrozenPlan ? '沿用首次识别的冻结入场/失效/目标' : '已冻结首次信号计划'
    const touchReason = entryConfirmationPending ? '已闭合K线尚未确认触碰/突破，状态保持预埋' : null
    const stabilityReason = stability.basis === 'first_seen'
      ? '首次识别，等待下一轮稳定性确认'
      : stability.basis === 'cross_timeframe'
        ? '1h / 4h 本地结构同向确认'
        : stability.basis === 'repeated_scan'
          ? `连续 ${stability.streak} 轮结构一致`
          : null
    const allReasons = [...new Set([planReason, touchReason, stabilityReason, calibrationReason, ...baseReasons, ...derivativeReasons].filter(Boolean))].slice(0, 6)
    const total = recalibrateSignalScore({
      total: rawTotal,
      chart,
      data,
      risk,
      rewardRisk,
      status,
      timeframe,
      riskFlags: deterministicRiskFlags,
      distanceToEntryPct: pct(currentPrice, entryPrice),
      asset,
      side,
      currentPrice,
      entryPrice,
      stopLoss,
      targets,
      historyCalibration,
      stability,
    })

    const sig = {
      source: aiResult?._meta?.degraded ? 'local_fallback' : localPlan ? 'local+ai' : 'ai_rejected',
      status,
      side,
      timeframe,
      entryMode,
      detectedAt,
      detectedCandleCloseTime,
      planFrozenAt: detectedAt,
      planExpiresAt,
      planExpired,
      planFrozen: true,
      localPlanMissing: !localPlan,
      setup: localPlan?.setup ?? item.setup ?? 'ai_structure',
      setupLabel: localPlan?.setupLabel ?? item.setupLabel ?? item.pattern ?? 'AI 结构候选',
      currentPrice,
      entryPrice,
      triggerPrice: entryPrice,
      confirmPrice,
      distanceToEntryPct: pct(currentPrice, entryPrice),
      distanceToTriggerPct: pct(currentPrice, entryPrice),
      distanceToConfirmPct: pct(currentPrice, confirmPrice),
      stopLoss,
      stopLossPct: pct(entryPrice, stopLoss),
      targets,
      tp1: targets[0] ?? null,
      tp2: targets[1] ?? targets[0] ?? null,
      tp3: targets[2] ?? targets[1] ?? targets[0] ?? null,
      rewardRisk,
      atr,
      atrPct: finite(matchedLocal?.atrPct),
      remainingTargets: remainingTargets(side, currentPrice, targets),
      reachedTargets: reachedTargets(side, currentPrice, targets),
      historyCalibration: historyCalibration?.active ? historyCalibration : null,
      lossCooldown,
      stability,
      dataFreshness,
      structureConflict: structureContext.conflict ? {
        timeframe: structureContext.conflict.timeframe,
        side: structureContext.conflict.side,
        score: structureContext.conflict.score?.total ?? null,
      } : null,
      entryTouchConfirmed: closedCandleConfirmed,
      entryProgressR,
      parameterMode: asset.signalHunter?.parameterMode ?? 'stable',
      parameterVersion: asset.signalHunter?.parameterVersion ?? 'v1',
      shadowComparison: asset.signalHunter?.shadowComparison ?? null,
      executionEligible: Boolean(localPlan?.executionEligible),
      executionTier: localPlan?.executionTier ?? 'observe',
      targetBasis: 'ai_structure',
      score: {
        total,
        chart,
        data,
        risk,
        rewardRisk,
        calibrationDelta: historyCalibration?.active ? historyCalibration.delta : 0,
        weights: 'AI structure + hard guards',
      },
      reasons: allReasons,
      riskFlags: allRiskFlags,
      narrativeSummary: String(item.narrativeSummary ?? item.narrative ?? '').trim(),
      riskNarrative: String(item.riskNarrative ?? '').trim(),
      narrativeTags: narrativeTags.map(tag => String(tag).trim()).filter(Boolean).slice(0, 5),
      rejectReasons: Array.isArray(item.rejectReasons) ? item.rejectReasons : [],
      rejected: status === 'rejected',
    }

    const guardReasons = validateSignal(sig, asset)
    if (guardReasons.length || sig.rejected) {
      sig.status = 'rejected'
      sig.rejected = true
      sig.rejectReasons = [...new Set([...(sig.rejectReasons ?? []), ...guardReasons])]
    }
    const depthExecution = asset.liquidity?.depth?.[side === 'short' ? 'sell' : 'buy']?.['5000']
    sig.marketRegime = matchedLocal?.marketRegime ?? null
    sig.parameterProfile = matchedLocal?.parameterProfile ?? null
    sig.decisionTrace = [
      {
        stage: '数据质量',
        passed: asset.dataQuality?.ok !== false,
        detail: asset.dataQuality?.issues?.length ? asset.dataQuality.issues.join(' / ') : 'K线、价格及关键数据可用',
      },
      {
        stage: '交易时段',
        passed: asset.source !== 'yahoo' || asset.marketSession === 'regular',
        detail: asset.source === 'yahoo' ? `美股 ${asset.marketSession ?? 'unknown'}` : '连续交易市场',
      },
      {
        stage: '本地结构',
        passed: Boolean(localPlan),
        detail: localPlan ? `${side} · ${timeframe} · ${localPlan.setupLabel ?? localPlan.setup}` : '没有本地可执行计划',
      },
      {
        stage: '市场状态',
        passed: !['high_volatility'].includes(matchedLocal?.marketRegime),
        detail: `${matchedLocal?.marketRegime ?? 'unknown'} · ${matchedLocal?.parameterProfile ?? 'default'}`,
      },
      {
        stage: '流动性',
        passed: !asset.liquidity?.depthError && (depthExecution?.fillRatio ?? 1) >= 0.98,
        detail: Number.isFinite(depthExecution?.slippagePct)
          ? `$5k成交 ${(depthExecution.fillRatio * 100).toFixed(0)}% · 滑点 ${depthExecution.slippagePct.toFixed(3)}%`
          : asset.liquidity?.source ?? '成交额代理',
      },
      {
        stage: '计划生命周期',
        passed: !planExpired && !lossCooldown,
        detail: planExpired ? '计划已过期' : lossCooldown ? '止损冷却中' : `冻结至 ${new Date(planExpiresAt).toLocaleString('zh-CN')}`,
      },
      {
        stage: '闭合K线触发',
        passed: status !== 'triggered' || closedCandleConfirmed,
        detail: closedCandleConfirmed ? '形成时间之后的闭合K线已确认' : '尚未确认，保持预埋',
      },
      {
        stage: '最终资格',
        passed: !sig.rejected,
        detail: sig.rejected ? sig.rejectReasons.join(' / ') : `${total.toFixed(1)}分 · ${rewardRisk?.toFixed(2) ?? '-'}R`,
      },
      ...(sig.shadowComparison ? [{
        stage: '影子参数 v2',
        passed: true,
        detail: `${sig.shadowComparison.wouldPass ? '影子通过' : '影子阻断'} · ${sig.shadowComparison.score ?? 0}分 · ${sig.shadowComparison.reason || '-'}`,
      }] : []),
    ]

    return {
      key: assetKey(asset), symbol: asset.symbol, apiSymbol: asset.apiSymbol,
      source: asset.source, type: asset.type, underlyingKey: underlyingKey(asset), signalHunter: sig,
    }
  }).filter(Boolean)
}

function signalHunterAiCondition(sig) {
  if (sig.status === 'risk') return 'risk'
  if (sig.status === 'triggered') return 'focus'
  return 'watch'
}

function signalHunterAiNextCheck(sig) {
  if (sig.status === 'risk') return '优先回避，等待风险解除'
  if (sig.status === 'triggered') return '重点盯住 1h / 4h 的确认和回踩'
  if (sig.status === 'armed' || sig.status === 'wait_entry') return '继续观察入场距离和结构变化'
  return '保持观察，等待下一次结构确认'
}

function signalHunterAiRisk(sig) {
  const flags = Array.isArray(sig.riskFlags) ? sig.riskFlags.filter(Boolean) : []
  if (flags.length) return flags[0]
  const rejects = Array.isArray(sig.rejectReasons) ? sig.rejectReasons.filter(Boolean) : []
  if (rejects.length) return rejects[0]
  return sig.narrativeSummary?.trim() || ''
}

export function signalHunterAiAlertKey(item) {
  const sig = item?.signalHunter ?? {}
  return [
    item?.underlyingKey ?? item?.symbol ?? '',
    sig.side ?? '',
    sig.timeframe ?? '',
    sig.status ?? '',
    sig.setupLabel ?? sig.setup ?? '',
  ].join('|')
}

export function makeSignalHunterAiFeedItems(items, now = Date.now()) {
  return (items ?? [])
    .map(item => {
      const sig = item?.signalHunter
      if (!sig || sig.status === 'rejected') return null
      const score = Number(sig.score?.total ?? 0)
      if (sig.status !== 'risk' && sig.status !== 'triggered' && score < 7) return null

      const condition = signalHunterAiCondition(sig)
      if (condition === 'watch') return null
      return {
        id: `signal-hunter-ai-${item.symbol}-${now}`,
        ts: now,
        symbol: item.symbol,
        apiSymbol: item.apiSymbol,
        source: item.source,
        assetType: item.type,
        underlyingKey: item.underlyingKey,
        type: 'signal_hunter_ai',
        alertKey: signalHunterAiAlertKey(item),
        condition,
        value: score,
        price: sig.currentPrice ?? null,
        level: sig.status === 'risk' ? 3 : sig.status === 'triggered' ? 2 : 1,
        special: sig.status === 'risk' || sig.status === 'triggered',
        status: sig.status,
        side: sig.side,
        timeframe: sig.timeframe,
        signal: sig.setupLabel || sig.setup || 'Signal Hunter AI',
        reason: sig.narrativeSummary || sig.reasons?.[0] || `AI ${sig.status}`,
        risk: signalHunterAiRisk(sig),
        nextCheck: signalHunterAiNextCheck(sig),
        entryPrice: sig.entryPrice ?? null,
        stopLoss: sig.stopLoss ?? null,
        rewardRisk: sig.rewardRisk ?? null,
        score: sig.score?.total ?? null,
      }
    })
    .filter(Boolean)
}
