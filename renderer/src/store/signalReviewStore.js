import { create } from 'zustand'
import { signalIdFromAsset, signalIdFromReviewItem } from '../utils/signalId'

const KEY = 'rsi:signalReview'
const TRADE_LOG_KEY = 'rsi:signalReviewTradeLog'
const MIN_SCORE_KEY = 'rsi:signalReviewMinScore'
const MAX_ITEMS = 500
const MAX_TRADE_LOGS = 1000
const DEFAULT_MIN_REVIEW_SCORE = 7.5
const MIN_TAKE_PROFIT_R = 1.5
const SIMILAR_PRICE_PCT = 0.015
const SIMILAR_REVIEW_WINDOW_MS = 12 * 60 * 60 * 1000
const SIMILAR_LOG_WINDOW_MS = 12 * 60 * 60 * 1000
const HORIZONS = [
  { key: '1h', ms: 60 * 60 * 1000 },
  { key: '4h', ms: 4 * 60 * 60 * 1000 },
  { key: '24h', ms: 24 * 60 * 60 * 1000 },
]
const ACTIONABLE_STATUSES = new Set(['triggered', 'armed', 'wait_entry', 'wait_confirm', 'watch'])

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
      normalized.filter(log => !(log.result === 'win' && Number.isFinite(log.rMultiple) && log.rMultiple < MIN_TAKE_PROFIT_R))
    )
    if (valid.length !== logs.length || JSON.stringify(valid) !== JSON.stringify(logs)) saveTradeLogs(valid)
    return valid
  } catch { return [] }
}

function loadMinScore() {
  const value = Number(localStorage.getItem(MIN_SCORE_KEY))
  return Number.isFinite(value) ? value : DEFAULT_MIN_REVIEW_SCORE
}

function saveItems(items) {
  localStorage.setItem(KEY, JSON.stringify(items.slice(0, MAX_ITEMS)))
}

function saveTradeLogs(items) {
  localStorage.setItem(TRADE_LOG_KEY, JSON.stringify(items.slice(0, MAX_TRADE_LOGS)))
}

function saveMinScore(value) {
  localStorage.setItem(MIN_SCORE_KEY, String(value))
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

function reviewKey(asset, sig) {
  return [
    asset.symbol,
    sig.side,
    sig.timeframe,
    Number(sig.entryPrice ?? sig.triggerPrice).toPrecision(8),
    Number(sig.stopLoss).toPrecision(8),
  ].join('|')
}

function similarReviewItem(a, b) {
  if (!a || !b) return false
  return String(a.symbol).toUpperCase() === String(b.symbol).toUpperCase()
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

function shouldCapture(asset, minScore) {
  const sig = asset?.signalHunter
  if (!sig) return false
  if (!ACTIONABLE_STATUSES.has(sig.status) || sig.rejected) return false
  if ((sig.score?.total ?? 0) < minScore) return false
  if (sig.side !== 'long' && sig.side !== 'short') return false
  return Number.isFinite(sig.entryPrice ?? sig.triggerPrice) && Number.isFinite(sig.stopLoss)
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
  return {
    id: `shr-${reviewKey(asset, sig)}`,
    key: reviewKey(asset, sig),
    signalId: signalIdFromAsset(asset),
    symbol: asset.symbol,
    type: asset.type,
    side: sig.side,
    timeframe: sig.timeframe,
    statusAtCapture: sig.status,
    setup: sig.setupLabel || sig.setup || 'Signal Hunter',
    score: sig.score?.total ?? 0,
    chartScore: sig.score?.chart ?? null,
    dataScore: sig.score?.data ?? null,
    riskScore: sig.score?.risk ?? null,
    entryPrice,
    stopLoss,
    confirmPrice: finite(sig.confirmPrice),
    targets,
    capturedPrice: currentPrice,
    capturedAt: now,
    lastPrice: currentPrice,
    lastUpdatedAt: now,
    enteredAt: null,
    entryObservedPrice: null,
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

function crossedEntry(item, price) {
  if (!Number.isFinite(price)) return false
  return item.side === 'short'
    ? price <= item.entryPrice * 1.001
    : price >= item.entryPrice * 0.999
}

function hitStop(item, price) {
  if (!Number.isFinite(price)) return false
  return item.side === 'short'
    ? price >= item.stopLoss
    : price <= item.stopLoss
}

function hitTarget(item, price) {
  return hitTargetIndex(item, price) >= 0
}

function hitTargetIndex(item, price) {
  if (!Number.isFinite(price)) return -1
  const targets = validTargets(item.side, item.entryPrice, item.stopLoss, item.targets)
  return targets.findIndex(target => Number.isFinite(target) && (
    item.side === 'short' ? price <= target : price >= target
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
  return item.result === 'loss' ? item.stopLoss : item.lastPrice
}

function tradeLogFromItem(item, now) {
  const id = `sht-${item.key}-${item.result}`
  const exitPrice = closePriceForLog(item)
  const targetIndex = item.result === 'win' ? hitTargetIndex(item, exitPrice) : -1
  return {
    id,
    reviewId: item.id,
    key: item.key,
    signalId: item.signalId ?? signalIdFromReviewItem(item),
    symbol: item.symbol,
    type: item.type,
    side: item.side,
    timeframe: item.timeframe,
    setup: item.setup,
    score: item.score,
    result: item.result,
    resultLabel: item.resultLabel,
    capturedAt: item.capturedAt,
    enteredAt: item.enteredAt,
    closedAt: now,
    entryPrice: item.entryPrice,
    entryObservedPrice: item.entryObservedPrice,
    stopLoss: item.stopLoss,
    targets: item.targets ?? [],
    hitTarget: targetIndex >= 0 ? targetIndex + 1 : null,
    exitPrice,
    returnPct: pct(item.side, item.entryPrice, exitPrice),
    maxReturnPct: item.maxReturnPct,
    minReturnPct: item.minReturnPct,
    rMultiple: riskMultiple(item, exitPrice),
    reasons: item.reasons ?? [],
    risks: item.risks ?? [],
  }
}

function normalizeTradeLog(log) {
  const withSignalId = {
    ...log,
    signalId: log?.signalId ?? signalIdFromReviewItem(log),
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
  return String(a.symbol).toUpperCase() === String(b.symbol).toUpperCase()
    && a.side === b.side
    && a.timeframe === b.timeframe
    && a.result === b.result
    && closeEnough(a.entryPrice, b.entryPrice)
    && closeEnough(a.exitPrice, b.exitPrice)
    && timeClose(a.closedAt, b.closedAt, SIMILAR_LOG_WINDOW_MS)
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

function updateItem(item, asset, now) {
  const price = finite(asset?.price ?? asset?.signalHunter?.currentPrice)
  if (!Number.isFinite(price)) return item

  let next = {
    ...item,
    lastPrice: price,
    lastUpdatedAt: now,
  }

  if (!next.enteredAt && crossedEntry(next, price)) {
    next.enteredAt = now
    next.entryObservedPrice = price
  }

  if (next.enteredAt) {
    const ret = pct(next.side, next.entryPrice, price)
    next.currentReturnPct = ret
    next.maxReturnPct = Math.max(next.maxReturnPct ?? ret, ret)
    next.minReturnPct = Math.min(next.minReturnPct ?? ret, ret)

    const horizons = { ...(next.horizons ?? {}) }
    for (const horizon of HORIZONS) {
      if (!horizons[horizon.key] && now - next.capturedAt >= horizon.ms) {
        horizons[horizon.key] = { price, returnPct: ret, ts: now }
      }
    }
    next.horizons = horizons

    const closed = next.result === 'win' || next.result === 'loss'
    if (!closed && hitStop(next, price)) {
      next.result = 'loss'
      next.resultLabel = '触及止损'
      next.closedAt = now
    } else if (!closed && hitTarget(next, price)) {
      next.result = 'win'
      const targetIndex = hitTargetIndex(next, price)
      next.resultLabel = targetIndex >= 0 ? `到达T${targetIndex + 1}` : '到达目标'
      next.closedAt = now
    } else if (!closed) {
      next.result = 'open'
      next.resultLabel = '已入场'
    }
  } else if (now - next.capturedAt >= 24 * 60 * 60 * 1000) {
    next.result = 'not_entered'
    next.resultLabel = '未触发'
  }

  return next
}

const useSignalReviewStore = create((set, get) => ({
  items: loadItems(),
  tradeLogs: loadTradeLogs(),
  minScore: loadMinScore(),

  syncFromAssets: (assets, now = Date.now()) => {
    const existing = get().items
    const minScore = get().minScore
    const byKey = new Map(existing.map(item => [item.key, item]))
    let changed = false
    const fresh = []
    for (const asset of assets ?? []) {
      if (!shouldCapture(asset, minScore)) continue
      const key = reviewKey(asset, asset.signalHunter)
      if (byKey.has(key)) continue
      const sample = sampleFromAsset(asset, now)
      if ([...existing, ...fresh].some(item => similarReviewItem(item, sample))) continue
      byKey.set(key, sample)
      fresh.push(sample)
      changed = true
    }
    if (!changed) return
    const next = dedupeSimilarItems([...fresh, ...existing]).slice(0, MAX_ITEMS)
    set({ items: next })
    saveItems(next)
  },

  updateFromAssets: (assets, now = Date.now()) => {
    const bySymbol = new Map((assets ?? []).map(asset => [String(asset.symbol).toUpperCase(), asset]))
    let changed = false
    let logsChanged = false
    const existingLogs = get().tradeLogs
    const logIds = new Set(existingLogs.map(log => log.id))
    const newLogs = []
    const next = get().items.map(item => {
      const asset = bySymbol.get(String(item.symbol).toUpperCase())
      if (!asset) return item
      const updated = updateItem(item, asset, now)
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
    if (!changed && !logsChanged) return
    const tradeLogs = logsChanged ? dedupeSimilarTradeLogs([...newLogs, ...existingLogs]).slice(0, MAX_TRADE_LOGS) : existingLogs
    set({ items: next, tradeLogs })
    saveItems(next)
    if (logsChanged) saveTradeLogs(tradeLogs)
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

  setMinScore: (value) => {
    const n = Number(value)
    const next = Number.isFinite(n) ? Math.min(10, Math.max(0, n)) : DEFAULT_MIN_REVIEW_SCORE
    set({ minScore: next })
    saveMinScore(next)
  },
}))

export default useSignalReviewStore
