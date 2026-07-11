import { create } from 'zustand'
import { signalIdFromAsset, signalIdFromReviewItem } from '../utils/signalId'
import { hydrateOperationalData, persistOperationalData } from '../utils/operationalData'
import { assetKey, underlyingKey } from '../utils/assetKey'
import { buildCrossMarketIndex, crossMarketContext, tradfiSubtype, universeTier } from '../utils/crossMarket'

const KEY = 'rsi:signalReview'
const TRADE_LOG_KEY = 'rsi:signalReviewTradeLog'
const MIN_SCORE_KEY = 'rsi:signalReviewMinScore'
const ENTRY_CONFIRM_BUFFER_KEY = 'rsi:signalReviewEntryConfirmBuffer'
const MAX_ITEMS = 500
const MAX_TRADE_LOGS = 1000
const DEFAULT_MIN_REVIEW_SCORE = 7.5
const MIN_TAKE_PROFIT_R = 1.5
const DEFAULT_ENTRY_CONFIRM_BUFFER_PCT = 0.0015
const SIMILAR_PRICE_PCT = 0.015
const SIMILAR_REVIEW_WINDOW_MS = 12 * 60 * 60 * 1000
const SIMILAR_LOG_WINDOW_MS = 12 * 60 * 60 * 1000
const HORIZONS = [
  { key: '1h', ms: 60 * 60 * 1000 },
  { key: '4h', ms: 4 * 60 * 60 * 1000 },
  { key: '24h', ms: 24 * 60 * 60 * 1000 },
]
const REVIEWABLE_STATUSES = new Set(['triggered', 'armed', 'wait_entry', 'wait_confirm', 'watch', 'risk'])

function loadItems() {
  try {
    const items = JSON.parse(localStorage.getItem(KEY) || '[]')
    const migrated = dedupeSimilarItems(items.map(migrateLoadedItem))
    if (JSON.stringify(migrated) !== JSON.stringify(items)) saveItems(migrated)
    return migrated
  } catch { return [] }
}

function loadTradeLogs() {
  try {
    const logs = JSON.parse(localStorage.getItem(TRADE_LOG_KEY) || '[]')
    const normalized = logs.map(normalizeTradeLog)
    const valid = dedupeSimilarTradeLogs(
      normalized.filter(log =>
        entryObservedValid(log) &&
        !(log.result === 'win' && Number.isFinite(log.rMultiple) && log.rMultiple < MIN_TAKE_PROFIT_R))
    )
    if (valid.length !== logs.length || JSON.stringify(valid) !== JSON.stringify(logs)) saveTradeLogs(valid)
    return valid
  } catch { return [] }
}

function loadMinScore() {
  const value = Number(localStorage.getItem(MIN_SCORE_KEY))
  return Number.isFinite(value) ? value : DEFAULT_MIN_REVIEW_SCORE
}

function loadEntryConfirmBufferPct() {
  const value = Number(localStorage.getItem(ENTRY_CONFIRM_BUFFER_KEY))
  return Number.isFinite(value) ? Math.min(0.01, Math.max(0, value)) : DEFAULT_ENTRY_CONFIRM_BUFFER_PCT
}

function saveItems(items) {
  const next = items.slice(0, MAX_ITEMS)
  localStorage.setItem(KEY, JSON.stringify(next))
  persistOperationalData('signalReview', next)
}

function saveTradeLogs(items) {
  const next = items.slice(0, MAX_TRADE_LOGS)
  localStorage.setItem(TRADE_LOG_KEY, JSON.stringify(next))
  persistOperationalData('signalReviewTradeLog', next)
}

function saveMinScore(value) {
  localStorage.setItem(MIN_SCORE_KEY, String(value))
}

function saveEntryConfirmBufferPct(value) {
  localStorage.setItem(ENTRY_CONFIRM_BUFFER_KEY, String(value))
}

function finite(value) {
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

function pct(side, from, to) {
  if (!Number.isFinite(from) || !Number.isFinite(to) || !from) return null
  const raw = ((to - from) / from) * 100
  return side === 'short' ? -raw : raw
}

function closeEnough(a, b, tolerance = SIMILAR_PRICE_PCT) {
  if (!Number.isFinite(a) || !Number.isFinite(b)) return false
  const base = Math.max(Math.abs(a), Math.abs(b), 1e-9)
  return Math.abs(a - b) / base <= tolerance
}

function timeClose(a, b, windowMs) {
  if (!Number.isFinite(a) || !Number.isFinite(b)) return true
  return Math.abs(a - b) <= windowMs
}

function fallbackTargets(side, entryPrice, stopLoss) {
  if (!Number.isFinite(entryPrice) || !Number.isFinite(stopLoss) || !entryPrice) return []
  const unit = Math.max(Math.abs(entryPrice - stopLoss), entryPrice * 0.018)
  return [MIN_TAKE_PROFIT_R, 2, 3].map(mult => side === 'short'
    ? entryPrice - unit * mult
    : entryPrice + unit * mult)
}

function riskMultipleForTarget(side, entryPrice, stopLoss, target) {
  if (!Number.isFinite(entryPrice) || !Number.isFinite(stopLoss) || !Number.isFinite(target)) return null
  const risk = Math.abs(entryPrice - stopLoss)
  if (!risk) return null
  const reward = side === 'short' ? entryPrice - target : target - entryPrice
  return reward / risk
}

function validTargets(side, entryPrice, stopLoss, targets) {
  const explicit = (targets ?? [])
    .map(finite)
    .filter(Number.isFinite)
    .filter(target => (riskMultipleForTarget(side, entryPrice, stopLoss, target) ?? -Infinity) >= MIN_TAKE_PROFIT_R)
    .sort((a, b) =>
      (riskMultipleForTarget(side, entryPrice, stopLoss, a) ?? 0) -
      (riskMultipleForTarget(side, entryPrice, stopLoss, b) ?? 0))
  return explicit.length ? explicit : fallbackTargets(side, entryPrice, stopLoss)
}

function inferEntryTrigger(side, entryPrice, referencePrice, setup = '') {
  const setupText = String(setup ?? '')
  if (/pullback|retest|rebound|base|回踩|支撑|反抽|阻力/i.test(setupText)) return 'pullback'
  if (/confirm_long|breakout|突破/i.test(setupText)) return 'breakout'
  if (/confirm_short|breakdown|跌破/i.test(setupText)) return 'breakdown'
  if (!Number.isFinite(entryPrice) || !Number.isFinite(referencePrice)) return 'unknown'
  if (side === 'long') return entryPrice <= referencePrice ? 'pullback' : 'breakout'
  if (side === 'short') return entryPrice >= referencePrice ? 'pullback' : 'breakdown'
  return 'unknown'
}

function triggerLabel(trigger) {
  if (trigger === 'pullback') return '回踩触发'
  if (trigger === 'breakout') return '突破触发'
  if (trigger === 'breakdown') return '跌破触发'
  return '触发方式未知'
}

function normalizeProbe(value) {
  if (value && typeof value === 'object') {
    const last = finite(value.last ?? value.price ?? value.close)
    const high = finite(value.high)
    const low = finite(value.low)
    return {
      last,
      high: Number.isFinite(high) ? high : last,
      low: Number.isFinite(low) ? low : last,
      source: value.source ?? 'price',
    }
  }
  const price = finite(value)
  return { last: price, high: price, low: price, source: 'price' }
}

function probeFromAsset(item, asset, fallbackPrice, sinceTs) {
  const candles = asset?.reviewCandlesByTf?.[item.timeframe] ?? []
  const window = candles.filter(c => (c.closeTime ?? c.time ?? 0) >= sinceTs)
  const highs = window.map(c => finite(c.high)).filter(Number.isFinite)
  const lows = window.map(c => finite(c.low)).filter(Number.isFinite)
  const last = finite(fallbackPrice)
  if (highs.length && lows.length) {
    return {
      last,
      high: Math.max(...highs, Number.isFinite(last) ? last : -Infinity),
      low: Math.min(...lows, Number.isFinite(last) ? last : Infinity),
      source: 'ohlc',
    }
  }
  return normalizeProbe(last)
}

function candleTime(candle) {
  return finite(candle?.closeTime ?? candle?.time)
}

function firstMatchingCandle(item, asset, sinceTs, predicate) {
  const candles = asset?.reviewCandlesByTf?.[item.timeframe] ?? []
  return candles
    .filter(candle => (candleTime(candle) ?? 0) >= sinceTs)
    .sort((a, b) => (candleTime(a) ?? 0) - (candleTime(b) ?? 0))
    .find(candle => predicate(normalizeProbe(candle))) ?? null
}

function firstMatchingExitCandle(item, asset, sinceTs, predicate) {
  const lowerTimeframe = item.timeframe === '4h' ? '1h' : item.timeframe === '1h' ? '15m' : null
  const preferred = lowerTimeframe ? asset?.reviewCandlesByTf?.[lowerTimeframe] : null
  const timeframe = Array.isArray(preferred) && preferred.length ? lowerTimeframe : item.timeframe
  const candles = asset?.reviewCandlesByTf?.[timeframe] ?? []
  const candle = candles
    .filter(value => (candleTime(value) ?? 0) >= sinceTs)
    .sort((a, b) => (candleTime(a) ?? 0) - (candleTime(b) ?? 0))
    .find(value => predicate(normalizeProbe(value))) ?? null
  return { candle, timeframe }
}

function entryObservedPrice(item, probe) {
  const p = normalizeProbe(probe)
  const trigger = item.entryTrigger ?? inferEntryTrigger(item.side, item.entryPrice, item.capturedPrice, item.setup)
  if (trigger === 'pullback') return item.side === 'short' ? p.high : p.low
  if (trigger === 'breakout') return p.high
  if (trigger === 'breakdown') return p.low
  return p.last
}

function entryDiagnostic(item) {
  if (item.enteredAt) {
    return `已触发：${triggerLabel(item.entryTrigger)} · 计划 ${formatNumber(item.entryPrice)} / 观测 ${formatNumber(item.entryObservedPrice)}`
  }
  const trigger = item.entryTrigger ?? inferEntryTrigger(item.side, item.entryPrice, item.capturedPrice, item.setup)
  const observed = item.entryObservedPrice
  if (!Number.isFinite(observed)) return `${triggerLabel(trigger)} · 等待有效行情`
  if (trigger === 'pullback' && item.side === 'long') return `未触发：最低 ${formatNumber(observed)} > 入场 ${formatNumber(item.entryPrice)}`
  if (trigger === 'pullback' && item.side === 'short') return `未触发：最高 ${formatNumber(observed)} < 入场 ${formatNumber(item.entryPrice)}`
  if (trigger === 'breakout') return `未触发：最高 ${formatNumber(observed)} < 入场 ${formatNumber(item.entryPrice)}`
  if (trigger === 'breakdown') return `未触发：最低 ${formatNumber(observed)} > 入场 ${formatNumber(item.entryPrice)}`
  return `${triggerLabel(trigger)} · 等待确认`
}

function formatNumber(value) {
  return Number.isFinite(value) ? Number(value).toFixed(value >= 100 ? 2 : 3) : '-'
}

function reviewKey(asset, sig) {
  return [
    underlyingKey(asset) || asset.symbol,
    asset.source,
    sig.side,
    sig.timeframe,
    Number(sig.entryPrice ?? sig.triggerPrice).toPrecision(8),
    Number(sig.stopLoss).toPrecision(8),
  ].join('|')
}

function similarReviewItem(a, b) {
  if (!a || !b) return false
  return String(a.underlyingKey ?? a.symbol).toUpperCase() === String(b.underlyingKey ?? b.symbol).toUpperCase()
    && String(a.source ?? '') === String(b.source ?? '')
    && a.side === b.side
    && a.timeframe === b.timeframe
    && closeEnough(a.entryPrice, b.entryPrice)
    && closeEnough(a.stopLoss, b.stopLoss)
    && timeClose(a.capturedAt, b.capturedAt, SIMILAR_REVIEW_WINDOW_MS)
}

function dedupeSimilarItems(items) {
  const out = []
  for (const item of items ?? []) {
    if (out.some(existing => similarReviewItem(existing, item))) continue
    out.push(item)
  }
  return out
}

function captureRejectReason(asset, minScore) {
  const sig = asset?.signalHunter
  if (!sig) return '无 SH 信号'
  if (sig.rejected || sig.status === 'rejected') return '已剔除'
  if (sig.executionEligible === false) return '观察级结构'
  if (!REVIEWABLE_STATUSES.has(sig.status)) return '状态不可识别'
  if (sig.stability && !sig.stability.confirmed && sig.status !== 'triggered') return '等待稳定确认'
  if (sig.side !== 'long' && sig.side !== 'short') return '方向无效'
  if (!Number.isFinite(sig.entryPrice ?? sig.triggerPrice) || !Number.isFinite(sig.stopLoss)) return '价格缺失'
  if ((sig.score?.total ?? 0) < minScore) return '综合分不足'
  return null
}

function shouldCapture(asset, minScore) {
  return !captureRejectReason(asset, minScore)
}

function sampleFromAsset(asset, now) {
  const sig = asset.signalHunter
  const entryPrice = finite(sig.entryPrice ?? sig.triggerPrice)
  const stopLoss = finite(sig.stopLoss)
  const currentPrice = finite(sig.currentPrice ?? asset.price)
  const explicitTargets = [sig.tp1, sig.tp2, sig.tp3, ...(sig.targets ?? [])]
    .map(finite)
    .filter(Number.isFinite)
  const targets = validTargets(sig.side, entryPrice, stopLoss, explicitTargets)
  const entryTrigger = inferEntryTrigger(sig.side, entryPrice, currentPrice, sig.entryMode || sig.setupLabel || sig.setup)
  return {
    id: `shr-${reviewKey(asset, sig)}`,
    key: reviewKey(asset, sig),
    signalId: signalIdFromAsset(asset),
    symbol: asset.symbol,
    apiSymbol: asset.apiSymbol,
    source: asset.source,
    underlyingKey: underlyingKey(asset),
    venueType: asset.type === 'tradfi' ? 'perp' : asset.type === 'stock' ? 'cash' : asset.type,
    tradfiSubtype: tradfiSubtype(asset),
    universeTier: asset.crossMarketSnapshot?.universeTier ?? null,
    crossMarketConfirmation: asset.crossMarketSnapshot?.confirmation ?? 'none',
    basisPctAtCapture: finite(asset.crossMarketSnapshot?.basisPct),
    marketPhaseAtCapture: asset.crossMarketSnapshot?.phase ?? asset.marketSession ?? null,
    name: asset.name ?? null,
    type: asset.type,
    side: sig.side,
    timeframe: sig.timeframe,
    statusAtCapture: sig.status,
    setup: sig.setupLabel || sig.setup || 'Signal Hunter',
    score: sig.score?.total ?? 0,
    marketRegime: sig.marketRegime ?? null,
    executionEligible: sig.executionEligible !== false,
    executionNotional: finite(sig.executionNotional),
    executionSlippagePct: finite(sig.executionSlippagePct) ?? 0,
    chartScore: sig.score?.chart ?? null,
    dataScore: sig.score?.data ?? null,
    riskScore: sig.score?.risk ?? null,
    entryPrice,
    entryMode: sig.entryMode ?? null,
    entryTrigger,
    entryTriggerLabel: triggerLabel(entryTrigger),
    stopLoss,
    confirmPrice: finite(sig.confirmPrice),
    targets,
    capturedPrice: currentPrice,
    capturedAt: now,
    lastPrice: currentPrice,
    lastUpdatedAt: now,
    enteredAt: null,
    entryObservedPrice: currentPrice,
    entryDiagnostic: entryDiagnostic({ side: sig.side, entryPrice, entryTrigger, entryObservedPrice: currentPrice }),
    maxReturnPct: null,
    minReturnPct: null,
    currentReturnPct: null,
    result: 'tracking',
    resultLabel: '跟踪中',
    horizons: {},
    reasons: sig.reasons ?? [],
    risks: sig.riskFlags ?? sig.rejectReasons ?? [],
  }
}

function crossedEntry(item, value) {
  const probe = normalizeProbe(value)
  if (!Number.isFinite(probe.last) || !Number.isFinite(item.entryPrice)) return false
  const trigger = item.entryTrigger ?? inferEntryTrigger(item.side, item.entryPrice, item.capturedPrice, item.setup)
  if (trigger === 'pullback') {
    return item.side === 'short'
      ? probe.high >= item.entryPrice * 0.999
      : probe.low <= item.entryPrice * 1.001
  }
  if (trigger === 'breakout') return probe.high >= item.entryPrice * 0.999
  if (trigger === 'breakdown') return probe.low <= item.entryPrice * 1.001
  return false
}

function entryConfirmed(item, value, bufferPct = DEFAULT_ENTRY_CONFIRM_BUFFER_PCT) {
  const probe = normalizeProbe(value)
  if (!crossedEntry(item, probe) || hitStop(item, probe)) return false
  const trigger = item.entryTrigger ?? inferEntryTrigger(item.side, item.entryPrice, item.capturedPrice, item.setup)
  const buffer = Math.abs(item.entryPrice) * bufferPct
  if (trigger === 'pullback') {
    return item.side === 'short'
      ? probe.last <= item.entryPrice - buffer
      : probe.last >= item.entryPrice + buffer
  }
  if (trigger === 'breakout') return probe.last >= item.entryPrice + buffer
  if (trigger === 'breakdown') return probe.last <= item.entryPrice - buffer
  return crossedEntry(item, probe)
}

function entryRejectDiagnostic(item, value, bufferPct = DEFAULT_ENTRY_CONFIRM_BUFFER_PCT) {
  const probe = normalizeProbe(value)
  if (!crossedEntry(item, probe)) return null
  if (hitStop(item, probe)) return '未入场：触发K线已扫到止损，跳过'
  if (!entryConfirmed(item, probe, bufferPct)) return '未入场：仅插针触发，等待收回确认'
  return null
}

function entryObservedValid(item) {
  if (!item?.enteredAt) return true
  const trigger = item.entryTrigger ?? inferEntryTrigger(item.side, item.entryPrice, item.capturedPrice, item.setup)
  if (trigger === 'unknown') return true
  return crossedEntry(item, item.entryObservedPrice ?? item.lastPrice)
}

function hitStop(item, value) {
  const probe = normalizeProbe(value)
  if (!Number.isFinite(probe.last)) return false
  return item.side === 'short'
    ? probe.high >= item.stopLoss
    : probe.low <= item.stopLoss
}

function hitTarget(item, value) {
  return hitTargetIndex(item, value) >= 0
}

function hitTargetIndex(item, value) {
  const probe = normalizeProbe(value)
  if (!Number.isFinite(probe.last)) return -1
  const targets = validTargets(item.side, item.entryPrice, item.stopLoss, item.targets)
  return targets.findIndex(target => Number.isFinite(target) && (
    item.side === 'short' ? probe.low <= target : probe.high >= target
  ))
}

function riskMultiple(item, exitPrice) {
  if (!Number.isFinite(item.entryPrice) || !Number.isFinite(item.stopLoss) || !Number.isFinite(exitPrice)) return null
  const risk = Math.abs(item.entryPrice - item.stopLoss)
  if (!risk) return null
  const reward = item.side === 'short'
    ? item.entryPrice - exitPrice
    : exitPrice - item.entryPrice
  return Number((reward / risk).toFixed(2))
}

function closePriceForLog(item) {
  if (Number.isFinite(item.exitObservedPrice)) return item.exitObservedPrice
  return item.result === 'loss' ? item.stopLoss : item.lastPrice
}

function tradeLogFromItem(item, now) {
  const id = `sht-${item.key}-${item.result}`
  const exitPrice = closePriceForLog(item)
  const targetIndex = item.result === 'win' ? hitTargetIndex(item, exitPrice) : -1
  const riskPct = Number.isFinite(item.entryPrice) && Number.isFinite(item.stopLoss) && item.entryPrice
    ? Math.abs(item.entryPrice - item.stopLoss) / Math.abs(item.entryPrice) * 100
    : null
  const mfeR = Number.isFinite(riskPct) && riskPct > 0 && Number.isFinite(item.maxReturnPct) ? item.maxReturnPct / riskPct : null
  const maeR = Number.isFinite(riskPct) && riskPct > 0 && Number.isFinite(item.minReturnPct) ? item.minReturnPct / riskPct : null
  const grossR = riskMultiple(item, exitPrice)
  const estimatedCostR = Number.isFinite(riskPct) && riskPct > 0 ? ((finite(item.executionSlippagePct) ?? 0) * 2) / riskPct : 0
  return {
    id,
    reviewId: item.id,
    key: item.key,
    signalId: item.signalId ?? signalIdFromReviewItem(item),
    symbol: item.symbol,
    name: item.name ?? null,
    type: item.type,
    apiSymbol: item.apiSymbol,
    source: item.source,
    underlyingKey: item.underlyingKey,
    venueType: item.venueType,
    tradfiSubtype: item.tradfiSubtype,
    universeTier: item.universeTier,
    crossMarketConfirmation: item.crossMarketConfirmation,
    basisPctAtCapture: item.basisPctAtCapture,
    marketPhaseAtCapture: item.marketPhaseAtCapture,
    side: item.side,
    timeframe: item.timeframe,
    setup: item.setup,
    marketRegime: item.marketRegime ?? null,
    score: item.score,
    result: item.result,
    resultLabel: item.resultLabel,
    capturedAt: item.capturedAt,
    capturedPrice: item.capturedPrice,
    entryTrigger: item.entryTrigger ?? inferEntryTrigger(item.side, item.entryPrice, item.capturedPrice, item.setup),
    entryTriggerLabel: item.entryTriggerLabel ?? triggerLabel(item.entryTrigger),
    entryDiagnostic: item.entryDiagnostic ?? '',
    enteredAt: item.enteredAt,
    entryTime: item.enteredAt,
    closedAt: now,
    exitTime: now,
    entryPrice: item.entryPrice,
    entryMode: item.entryMode ?? null,
    entryObservedPrice: item.entryObservedPrice,
    stopLoss: item.stopLoss,
    targets: item.targets ?? [],
    hitTarget: targetIndex >= 0 ? targetIndex + 1 : null,
    exitPrice,
    exitObservedPrice: item.exitObservedPrice,
    returnPct: pct(item.side, item.entryPrice, exitPrice),
    maxReturnPct: item.maxReturnPct,
    minReturnPct: item.minReturnPct,
    rMultiple: grossR,
    executionNotional: finite(item.executionNotional),
    executionSlippagePct: finite(item.executionSlippagePct) ?? 0,
    estimatedCostR: Number(estimatedCostR.toFixed(3)),
    executionAdjustedR: Number.isFinite(grossR) ? Number((grossR - estimatedCostR).toFixed(2)) : null,
    mfeR: Number.isFinite(mfeR) ? Number(mfeR.toFixed(2)) : null,
    maeR: Number.isFinite(maeR) ? Number(maeR.toFixed(2)) : null,
    waitTimeMs: Number.isFinite(item.enteredAt) ? Math.max(0, item.enteredAt - item.capturedAt) : null,
    holdingTimeMs: Number.isFinite(item.enteredAt) ? Math.max(0, now - item.enteredAt) : null,
    reasons: item.reasons ?? [],
    risks: item.risks ?? [],
  }
}

function normalizeTradeLog(log) {
  const withSignalId = {
    ...log,
    signalId: log?.signalId ?? signalIdFromReviewItem(log),
    entryTrigger: log?.entryTrigger ?? inferEntryTrigger(log?.side, log?.entryPrice, log?.capturedPrice, log?.setup),
    entryTriggerLabel: log?.entryTriggerLabel ?? triggerLabel(log?.entryTrigger ?? inferEntryTrigger(log?.side, log?.entryPrice, log?.capturedPrice, log?.setup)),
    entryDiagnostic: log?.entryDiagnostic ?? '',
    entryTime: log?.entryTime ?? log?.enteredAt ?? null,
    exitTime: log?.exitTime ?? log?.closedAt ?? null,
  }
  if (withSignalId?.result !== 'loss') return withSignalId
  const exitPrice = withSignalId.stopLoss
  return {
    ...withSignalId,
    exitPrice,
    returnPct: pct(withSignalId.side, withSignalId.entryPrice, exitPrice),
    rMultiple: Number.isFinite(exitPrice) ? -1 : withSignalId.rMultiple,
  }
}

function similarTradeLog(a, b) {
  if (!a || !b) return false
  const aStart = finite(a.entryTime ?? a.enteredAt)
  const bStart = finite(b.entryTime ?? b.enteredAt)
  const aEnd = finite(a.exitTime ?? a.closedAt)
  const bEnd = finite(b.exitTime ?? b.closedAt)
  const overlaps = Number.isFinite(aStart) && Number.isFinite(bStart)
    && Number.isFinite(aEnd) && Number.isFinite(bEnd)
    && Math.max(aStart, bStart) <= Math.min(aEnd, bEnd)
  return String(a.symbol).toUpperCase() === String(b.symbol).toUpperCase()
    && a.side === b.side
    && (overlaps || (
      a.timeframe === b.timeframe
      && a.result === b.result
      && closeEnough(a.entryPrice, b.entryPrice)
      && closeEnough(a.exitPrice, b.exitPrice)
      && timeClose(a.closedAt, b.closedAt, SIMILAR_LOG_WINDOW_MS)
    ))
}

function dedupeSimilarTradeLogs(logs) {
  const out = []
  for (const log of logs ?? []) {
    if (out.some(existing => similarTradeLog(existing, log))) continue
    out.push(log)
  }
  return out
}

function migrateLoadedItem(item) {
  const withSignalId = {
    ...item,
    signalId: item?.signalId ?? signalIdFromReviewItem(item),
    entryTrigger: item?.entryTrigger ?? inferEntryTrigger(item?.side, item?.entryPrice, item?.capturedPrice, item?.setup),
  }
  if (!entryObservedValid(withSignalId)) {
    return {
      ...withSignalId,
      enteredAt: null,
      entryObservedPrice: null,
      currentReturnPct: null,
      maxReturnPct: null,
      minReturnPct: null,
      result: 'tracking',
      resultLabel: '跟踪中',
      closedAt: null,
      tradeLoggedAt: null,
      tradeLogId: null,
    }
  }
  if (withSignalId?.result !== 'win') return withSignalId
  const multiple = riskMultiple(withSignalId, withSignalId.lastPrice)
  if (!Number.isFinite(multiple) || multiple >= MIN_TAKE_PROFIT_R) return withSignalId
  return {
    ...withSignalId,
    result: withSignalId.enteredAt ? 'open' : 'tracking',
    resultLabel: withSignalId.enteredAt ? '已入场' : '跟踪中',
    closedAt: null,
    tradeLoggedAt: null,
    tradeLogId: null,
  }
}

function updateItem(item, asset, now, entryConfirmBufferPct = DEFAULT_ENTRY_CONFIRM_BUFFER_PCT) {
  const price = finite(asset?.price ?? asset?.signalHunter?.currentPrice)
  if (!Number.isFinite(price)) return item

  let next = {
    ...item,
    entryTrigger: item.entryTrigger ?? inferEntryTrigger(item.side, item.entryPrice, item.capturedPrice, item.setup),
    entryTriggerLabel: item.entryTriggerLabel ?? triggerLabel(item.entryTrigger ?? inferEntryTrigger(item.side, item.entryPrice, item.capturedPrice, item.setup)),
    lastPrice: price,
    lastUpdatedAt: now,
  }

  if (!entryObservedValid(next)) {
    next = {
      ...next,
      enteredAt: null,
      entryObservedPrice: null,
      currentReturnPct: null,
      maxReturnPct: null,
      minReturnPct: null,
      result: 'tracking',
      resultLabel: '跟踪中',
      closedAt: null,
      tradeLoggedAt: null,
      tradeLogId: null,
      exitObservedPrice: null,
    }
  }

  const entryProbe = probeFromAsset(next, asset, price, next.capturedAt)
  if (!next.enteredAt) {
    next.entryObservedPrice = entryObservedPrice(next, entryProbe)
    next.entryDiagnostic = entryDiagnostic(next)
  }

  const justEntered = !next.enteredAt && entryConfirmed(next, entryProbe, entryConfirmBufferPct)
  if (!next.enteredAt && !justEntered) {
    next.entryDiagnostic = entryRejectDiagnostic(next, entryProbe, entryConfirmBufferPct) ?? next.entryDiagnostic
  }
  if (justEntered) {
    const entryCandle = firstMatchingCandle(next, asset, next.capturedAt, probe =>
      entryConfirmed(next, probe, entryConfirmBufferPct))
    const observedEntryProbe = entryCandle ? normalizeProbe(entryCandle) : entryProbe
    next.enteredAt = candleTime(entryCandle) ?? now
    next.entryObservedPrice = entryObservedPrice(next, observedEntryProbe)
    next.entryDiagnostic = entryDiagnostic(next)
  }

  if (next.enteredAt) {
    const exitProbe = probeFromAsset(next, asset, price, next.enteredAt)
    const ret = pct(next.side, next.entryPrice, price)
    const bestPrice = next.side === 'short' ? exitProbe.low : exitProbe.high
    const worstPrice = next.side === 'short' ? exitProbe.high : exitProbe.low
    const bestRet = pct(next.side, next.entryPrice, bestPrice)
    const worstRet = pct(next.side, next.entryPrice, worstPrice)
    next.currentReturnPct = ret
    next.maxReturnPct = Math.max(next.maxReturnPct ?? ret, ret, Number.isFinite(bestRet) ? bestRet : ret)
    next.minReturnPct = Math.min(next.minReturnPct ?? ret, ret, Number.isFinite(worstRet) ? worstRet : ret)

    const horizons = { ...(next.horizons ?? {}) }
    for (const horizon of HORIZONS) {
      if (!horizons[horizon.key] && now - next.capturedAt >= horizon.ms) {
        horizons[horizon.key] = { price, returnPct: ret, ts: now }
      }
    }
    next.horizons = horizons

    const closed = next.result === 'win' || next.result === 'loss' || next.result === 'ambiguous'
    if (justEntered) {
      next.result = 'open'
      next.resultLabel = '已入场'
    } else if (!closed && (hitStop(next, exitProbe) || hitTarget(next, exitProbe))) {
      const exitMatch = firstMatchingExitCandle(next, asset, next.enteredAt, probe =>
        hitStop(next, probe) || hitTarget(next, probe))
      const exitCandle = exitMatch.candle
      const observedExitProbe = exitCandle ? normalizeProbe(exitCandle) : exitProbe
      next.closedAt = candleTime(exitCandle) ?? now
      const stopped = hitStop(next, observedExitProbe)
      const targeted = hitTarget(next, observedExitProbe)
      next.sequenceResolution = exitMatch.timeframe
      if (stopped && targeted) {
        next.result = 'ambiguous'
        next.resultLabel = '同K线顺序不明'
        next.exitObservedPrice = null
      } else if (stopped) {
        next.result = 'loss'
        next.resultLabel = '触及止损'
        next.exitObservedPrice = next.stopLoss
      } else {
        const targetIndex = hitTargetIndex(next, observedExitProbe)
        next.result = 'win'
        next.resultLabel = targetIndex >= 0 ? `到达T${targetIndex + 1}` : '到达目标'
        next.exitObservedPrice = validTargets(next.side, next.entryPrice, next.stopLoss, next.targets)[targetIndex] ?? price
      }
    } else if (!closed) {
      next.result = 'open'
      next.resultLabel = '已入场'
    }
  } else if (now - next.capturedAt >= 24 * 60 * 60 * 1000) {
    next.result = 'not_entered'
    next.entryDiagnostic = entryDiagnostic(next)
    next.resultLabel = '未触发'
  }

  return next
}

const useSignalReviewStore = create((set, get) => ({
  items: loadItems(),
  tradeLogs: loadTradeLogs(),
  minScore: loadMinScore(),
  entryConfirmBufferPct: loadEntryConfirmBufferPct(),
  captureRejectStats: null,
  cleanNotice: null,
  hydrate: async () => {
    const [items, tradeLogs] = await Promise.all([
      hydrateOperationalData('signalReview', get().items),
      hydrateOperationalData('signalReviewTradeLog', get().tradeLogs),
    ])
    set({
      items: Array.isArray(items) ? items.map(migrateLoadedItem) : get().items,
      tradeLogs: Array.isArray(tradeLogs) ? tradeLogs.map(normalizeTradeLog) : get().tradeLogs,
    })
  },

  syncFromAssets: (assets, now = Date.now()) => {
    const existing = get().items
    const minScore = get().minScore
    const byKey = new Map(existing.map(item => [item.key, item]))
    const signalAssets = (assets ?? []).filter(asset => asset?.signalHunter)
    const crossMarketIndex = buildCrossMarketIndex(assets)
    const rejectStats = {}
    let changed = false
    const fresh = []
    for (const asset of signalAssets) {
      const rejectReason = captureRejectReason(asset, minScore)
      if (rejectReason) {
        rejectStats[rejectReason] = (rejectStats[rejectReason] ?? 0) + 1
        continue
      }
      const key = reviewKey(asset, asset.signalHunter)
      if (byKey.has(key)) continue
      const crossMarket = crossMarketContext(asset, assets, new Date(now), crossMarketIndex)
      const sample = sampleFromAsset({ ...asset, crossMarketSnapshot: { ...crossMarket, universeTier: universeTier(asset, assets, crossMarketIndex) } }, now)
      if ([...existing, ...fresh].some(item => similarReviewItem(item, sample))) continue
      byKey.set(key, sample)
      fresh.push(sample)
      changed = true
    }
    const captureRejectStats = { ts: now, total: signalAssets.length, captured: fresh.length, reasons: rejectStats }
    if (!changed) {
      set({ captureRejectStats })
      return
    }
    const next = dedupeSimilarItems([...fresh, ...existing]).slice(0, MAX_ITEMS)
    set({ items: next, captureRejectStats })
    saveItems(next)
  },

  updateFromAssets: (assets, now = Date.now()) => {
    const entryConfirmBufferPct = get().entryConfirmBufferPct
    const byAssetKey = new Map((assets ?? []).map(asset => [assetKey(asset), asset]))
    const bySymbol = new Map((assets ?? []).map(asset => [String(asset.symbol).toUpperCase(), asset]))
    let changed = false
    let logsChanged = false
    const rawLogs = get().tradeLogs
    const existingLogs = dedupeSimilarTradeLogs(rawLogs.map(normalizeTradeLog).filter(entryObservedValid)).slice(0, MAX_TRADE_LOGS)
    const enrichedExistingLogs = existingLogs.map(log => {
      if (log.name) return log
      const asset = byAssetKey.get(`${log.source ?? ''}:${log.apiSymbol ?? log.symbol ?? ''}`) ?? bySymbol.get(String(log.symbol ?? '').toUpperCase())
      if (!asset?.name) return log
      return { ...log, name: asset.name }
    })
    const logsCleaned = enrichedExistingLogs.length !== rawLogs.length || JSON.stringify(enrichedExistingLogs) !== JSON.stringify(rawLogs)
    const cleanedLogCount = logsCleaned ? Math.max(0, rawLogs.length - enrichedExistingLogs.length) : 0
    const logIds = new Set(enrichedExistingLogs.map(log => log.id))
    const newLogs = []
    const next = get().items.map(item => {
      const asset = byAssetKey.get(`${item.source ?? ''}:${item.apiSymbol ?? item.symbol ?? ''}`) ?? bySymbol.get(String(item.symbol).toUpperCase())
      if (!asset) return item
      const updated = updateItem(item, asset, now, entryConfirmBufferPct)
      if (updated !== item) changed = true
      if ((updated.result === 'win' || updated.result === 'loss') && !updated.tradeLoggedAt) {
        const log = tradeLogFromItem(updated, updated.closedAt ?? now)
        if (!logIds.has(log.id)) {
          newLogs.push(log)
          logIds.add(log.id)
          logsChanged = true
        }
        changed = true
        return { ...updated, tradeLoggedAt: now, tradeLogId: log.id }
      }
      return updated
    })
    if (!changed && !logsChanged && !logsCleaned) return
    const tradeLogs = logsChanged ? dedupeSimilarTradeLogs([...newLogs, ...enrichedExistingLogs]).slice(0, MAX_TRADE_LOGS) : enrichedExistingLogs
    set({ items: next, tradeLogs, cleanNotice: cleanedLogCount ? `已清理 ${cleanedLogCount} 条未真实触发的交易日志` : get().cleanNotice })
    saveItems(next)
    if (logsChanged || logsCleaned) saveTradeLogs(tradeLogs)
  },

  remove: (id) => {
    const next = get().items.filter(item => item.id !== id)
    set({ items: next })
    saveItems(next)
  },

  clear: () => {
    set({ items: [] })
    saveItems([])
  },

  clearTradeLogs: () => {
    set({ tradeLogs: [] })
    saveTradeLogs([])
  },

  clearCleanNotice: () => set({ cleanNotice: null }),

  setMinScore: (value) => {
    const n = Number(value)
    const next = Number.isFinite(n) ? Math.min(10, Math.max(0, n)) : DEFAULT_MIN_REVIEW_SCORE
    set({ minScore: next })
    saveMinScore(next)
  },

  setEntryConfirmBufferPct: (value) => {
    const n = Number(value)
    const next = Number.isFinite(n) ? Math.min(0.01, Math.max(0, n)) : DEFAULT_ENTRY_CONFIRM_BUFFER_PCT
    set({ entryConfirmBufferPct: next })
    saveEntryConfirmBufferPct(next)
  },
}))

export default useSignalReviewStore
