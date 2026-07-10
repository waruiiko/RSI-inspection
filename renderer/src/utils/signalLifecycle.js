import { assetKey } from './assetKey'

const KEY = 'rsi:signalHunter:lifecycle:v1'
const MAX_ITEMS = 500

export async function loadSignalLifecycleItems() {
  if (window.api?.loadSignalLifecycle) {
    const persisted = await window.api.loadSignalLifecycle()
    if (Array.isArray(persisted) && persisted.length) return persisted
  }
  try {
    const items = JSON.parse(localStorage.getItem(KEY) ?? '[]')
    if (!Array.isArray(items)) return []
    if (items.length && window.api?.saveSignalLifecycle) {
      await window.api.saveSignalLifecycle(items)
      localStorage.removeItem(KEY)
    }
    return items
  } catch {
    return []
  }
}

export async function saveSignalLifecycleItems(items, now = Date.now()) {
  const previous = new Map((await loadSignalLifecycleItems()).map(item => [item.key, item]))
  for (const item of items ?? []) {
    const key = item.key ?? assetKey(item)
    const signal = item.signalHunter
    if (!key || !signal) continue
    previous.set(key, {
      key,
      symbol: item.symbol,
      updatedAt: now,
      signalHunter: signal,
    })
  }
  const next = [...previous.values()]
    .filter(item => now - (item.updatedAt ?? now) <= 60 * 24 * 60 * 60 * 1000)
    .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
    .slice(0, MAX_ITEMS)
  if (window.api?.saveSignalLifecycle) await window.api.saveSignalLifecycle(next)
  else localStorage.setItem(KEY, JSON.stringify(next))
  return next
}

export async function advanceSignalLifecycleItems(assets, now = Date.now()) {
  const byKey = new Map((assets ?? []).map(asset => [assetKey(asset), asset]))
  const bySymbol = new Map((assets ?? []).map(asset => [String(asset.symbol ?? '').toUpperCase(), asset]))
  const transitions = []
  const items = (await loadSignalLifecycleItems()).map(item => {
    const asset = byKey.get(item.key) ?? bySymbol.get(String(item.symbol ?? '').toUpperCase())
    const signal = item.signalHunter
    if (!asset || !signal?.planFrozen) return item
    const currentPrice = finite(asset.price ?? signal.currentPrice)
    let next = {
      ...signal,
      currentPrice,
      runtimeBlocked: asset.dataQuality?.ok === false,
      runtimeBlockReasons: asset.dataQuality?.issues ?? [],
      lastLifecycleCheckAt: now,
    }
    if (next.runtimeBlocked) return { ...item, updatedAt: now, signalHunter: next }

    if (!next.rejected && next.status !== 'triggered' && Number.isFinite(next.planExpiresAt) && now > next.planExpiresAt) {
      next = rejectLifecycleSignal(next, 'expired', '冻结计划已超过结构有效期', now)
      transitions.push({ key: item.key, symbol: item.symbol, from: signal.status, to: 'expired', signalHunter: next })
      return { ...item, updatedAt: now, signalHunter: next }
    }

    if (!next.rejected && next.status !== 'triggered') {
      const confirmation = findEntryConfirmation(asset, next)
      if (confirmation) {
        const from = next.status
        next = { ...next, status: 'triggered', entryTouchConfirmed: true, triggeredAt: confirmation.ts, runtimeTransition: 'triggered' }
        transitions.push({ key: item.key, symbol: item.symbol, from, to: 'triggered', signalHunter: next })
      }
    }

    if (!next.rejected && next.status === 'triggered') {
      const exit = findExit(asset, next)
      if (exit) {
        next = rejectLifecycleSignal(next, exit.result, exit.reason, exit.ts)
        transitions.push({ key: item.key, symbol: item.symbol, from: 'triggered', to: exit.result, signalHunter: next })
      }
    }

    next.decisionTrace = updateLifecycleTrace(next.decisionTrace, next)
    return { ...item, updatedAt: now, signalHunter: next }
  })
  if (window.api?.saveSignalLifecycle) await window.api.saveSignalLifecycle(items.slice(0, MAX_ITEMS))
  else localStorage.setItem(KEY, JSON.stringify(items.slice(0, MAX_ITEMS)))
  return { items, transitions }
}

function rejectLifecycleSignal(signal, completion, reason, ts) {
  return {
    ...signal,
    status: 'rejected',
    rejected: true,
    completion,
    completedAt: ts,
    planExpired: completion === 'expired' || signal.planExpired,
    rejectReasons: [...new Set([...(signal.rejectReasons ?? []), reason])],
    runtimeTransition: completion,
  }
}

function findEntryConfirmation(asset, signal) {
  const lower = signal.timeframe === '4h' ? '1h' : signal.timeframe === '1h' ? '15m' : signal.timeframe
  const preferred = asset?.reviewCandlesByTf?.[lower]
  const timeframe = Array.isArray(preferred) && preferred.length ? lower : signal.timeframe
  const candles = candlesAfter(asset, timeframe, signal.detectedCandleCloseTime)
  for (const candle of candles) {
    if (entryConfirmed(signal, candle)) return { ts: candleTime(candle) }
  }
  return null
}

function findExit(asset, signal) {
  const lower = signal.timeframe === '4h' ? '1h' : signal.timeframe === '1h' ? '15m' : signal.timeframe
  const preferred = asset?.reviewCandlesByTf?.[lower]
  const timeframe = Array.isArray(preferred) && preferred.length ? lower : signal.timeframe
  const candles = candlesAtOrAfter(asset, timeframe, signal.triggeredAt ?? signal.detectedCandleCloseTime)
  const targets = [signal.tp1, signal.tp2, signal.tp3, ...(signal.targets ?? [])].filter(Number.isFinite)
  for (const candle of candles) {
    const stopped = signal.side === 'short' ? candle.high >= signal.stopLoss : candle.low <= signal.stopLoss
    const reachedTargets = targets.filter(target => signal.side === 'short' ? candle.low <= target : candle.high >= target)
    const targeted = targets.length && reachedTargets.length === targets.length
    const ts = candleTime(candle)
    if (stopped && reachedTargets.length) return { result: 'ambiguous', reason: '同K线触及失效位与目标，顺序不明', ts }
    if (stopped) return { result: 'stopped', reason: '触及冻结计划失效位', ts }
    if (targeted) return { result: 'completed', reason: '冻结计划全部目标已完成', ts }
  }
  return null
}

function entryConfirmed(signal, candle) {
  if (!candle || !Number.isFinite(signal.entryPrice)) return false
  if (signal.entryMode === 'breakout') return candle.close >= signal.entryPrice * 1.001
  if (signal.entryMode === 'breakdown') return candle.close <= signal.entryPrice * 0.999
  const range = Math.max(candle.high - candle.low, signal.entryPrice * 0.0001)
  const closePosition = (candle.close - candle.low) / range
  return signal.side === 'short'
    ? candle.high >= signal.entryPrice * 0.999 && candle.close <= signal.entryPrice * 1.002 && closePosition <= 0.58
    : candle.low <= signal.entryPrice * 1.001 && candle.close >= signal.entryPrice * 0.998 && closePosition >= 0.42
}

function candlesAfter(asset, timeframe, afterTime) {
  return (asset?.reviewCandlesByTf?.[timeframe] ?? [])
    .filter(candle => (candleTime(candle) ?? 0) > (afterTime ?? 0))
    .sort((a, b) => (candleTime(a) ?? 0) - (candleTime(b) ?? 0))
}

function candlesAtOrAfter(asset, timeframe, fromTime) {
  return (asset?.reviewCandlesByTf?.[timeframe] ?? [])
    .filter(candle => (candleTime(candle) ?? 0) >= (fromTime ?? 0))
    .sort((a, b) => (candleTime(a) ?? 0) - (candleTime(b) ?? 0))
}

function candleTime(candle) {
  const value = finite(candle?.closeTime ?? candle?.time)
  return Number.isFinite(value) && value < 10_000_000_000 ? value * 1000 : value
}

function updateLifecycleTrace(trace, signal) {
  const next = (trace ?? []).filter(item => item.stage !== '实时生命周期')
  next.push({
    stage: '实时生命周期',
    passed: !signal.runtimeBlocked && !signal.rejected,
    detail: signal.runtimeBlocked
      ? signal.runtimeBlockReasons.join(' / ')
      : signal.rejected
        ? signal.rejectReasons?.at(-1) ?? '计划结束'
        : signal.status === 'triggered' ? '闭合K线已确认触发' : '等待形成时间之后的新K线',
  })
  return next
}

function finite(value) {
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}
