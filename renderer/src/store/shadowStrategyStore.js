import { create } from 'zustand'
import { hydrateOperationalData, persistOperationalData } from '../utils/operationalData'
import { assetKey } from '../utils/assetKey'

const MAX_OBSERVATIONS = 2000
const MAX_PLANS = 500
const TERMINAL = new Set(['win', 'loss', 'ambiguous', 'expired'])
const TTL = { '15m': 6 * 60 * 60e3, '1h': 24 * 60 * 60e3, '4h': 72 * 60 * 60e3 }

function candleTime(candle) {
  const value = Number(candle?.closeTime ?? candle?.time)
  return Number.isFinite(value) ? (value < 10_000_000_000 ? value * 1000 : value) : null
}

function entryConfirmed(plan, candle) {
  if (plan.entryMode === 'breakout') return candle.close >= plan.entryPrice * 1.001
  if (plan.entryMode === 'breakdown') return candle.close <= plan.entryPrice * 0.999
  const range = Math.max(candle.high - candle.low, plan.entryPrice * 0.0001)
  const closePosition = (candle.close - candle.low) / range
  return plan.side === 'short'
    ? candle.high >= plan.entryPrice * 0.999 && candle.close <= plan.entryPrice * 1.002 && closePosition <= 0.58
    : candle.low <= plan.entryPrice * 1.001 && candle.close >= plan.entryPrice * 0.998 && closePosition >= 0.42
}

function advancePlan(plan, asset, now) {
  if (TERMINAL.has(plan.status)) return plan
  const lower = plan.timeframe === '4h' ? '1h' : plan.timeframe === '1h' ? '15m' : plan.timeframe
  const candles = (asset.reviewCandlesByTf?.[lower]?.length ? asset.reviewCandlesByTf[lower] : asset.reviewCandlesByTf?.[plan.timeframe] ?? [])
    .filter(candle => (candleTime(candle) ?? 0) > (plan.lastCheckedAt ?? plan.createdAt))
    .sort((a, b) => candleTime(a) - candleTime(b))
  let next = { ...plan }
  for (const candle of candles) {
    const ts = candleTime(candle)
    if (next.status === 'waiting' && ts > next.expiresAt) return { ...next, status: 'expired', completedAt: ts, lastCheckedAt: ts }
    if (next.status === 'waiting' && entryConfirmed(next, candle)) next = { ...next, status: 'triggered', triggeredAt: ts }
    if (next.status !== 'triggered') { next.lastCheckedAt = ts; continue }
    const risk = Math.abs(next.entryPrice - next.stopLoss)
    const favorable = next.side === 'short' ? next.entryPrice - candle.low : candle.high - next.entryPrice
    const adverse = next.side === 'short' ? next.entryPrice - candle.high : candle.low - next.entryPrice
    next.mfeR = risk ? Math.max(next.mfeR ?? 0, favorable / risk) : null
    next.maeR = risk ? Math.min(next.maeR ?? 0, adverse / risk) : null
    const stopped = next.side === 'short' ? candle.high >= next.stopLoss : candle.low <= next.stopLoss
    const target = next.targets[0]
    const won = Number.isFinite(target) && (next.side === 'short' ? candle.low <= target : candle.high >= target)
    next.lastCheckedAt = ts
    if (stopped && won) return { ...next, status: 'ambiguous', completedAt: ts, rMultiple: null }
    if (stopped) return { ...next, status: 'loss', completedAt: ts, rMultiple: -1 }
    if (won) return { ...next, status: 'win', completedAt: ts, rMultiple: risk ? Math.abs(target - next.entryPrice) / risk : null }
  }
  if (next.status === 'waiting' && now > next.expiresAt) return { ...next, status: 'expired', completedAt: now, lastCheckedAt: now }
  return next
}

function newPlan(asset, shadow, scanAt) {
  const plan = shadow.plan
  if (!shadow.wouldPass || !plan || !Number.isFinite(plan.entryPrice) || !Number.isFinite(plan.stopLoss)) return null
  const identity = `${assetKey(asset)}:${shadow.version}:${plan.side}:${plan.timeframe}:${Number(plan.entryPrice).toPrecision(8)}`
  return { id: `${scanAt}:${identity}`, identity, key: assetKey(asset), symbol: asset.symbol, source: asset.source, type: asset.type, version: shadow.version, side: plan.side, timeframe: plan.timeframe, setup: plan.setup, entryMode: plan.entryMode, entryPrice: plan.entryPrice, stopLoss: plan.stopLoss, targets: plan.targets ?? [], createdAt: scanAt, lastCheckedAt: scanAt, expiresAt: scanAt + (TTL[plan.timeframe] ?? 24 * 60 * 60e3), status: 'waiting', mfeR: null, maeR: null, rMultiple: null }
}

const useShadowStrategyStore = create((set, get) => ({
  observations: [], plans: [], hydrated: false,
  hydrate: async () => {
    const stored = await hydrateOperationalData('shadowStrategy', { observations: [], plans: [] })
    const observations = Array.isArray(stored) ? stored : stored?.observations
    set({ observations: Array.isArray(observations) ? observations.slice(0, MAX_OBSERVATIONS) : [], plans: Array.isArray(stored?.plans) ? stored.plans.slice(0, MAX_PLANS) : [], hydrated: true })
  },
  recordFromAssets: (assets, scanAt) => {
    if (!Number.isFinite(scanAt)) return
    const previous = get()
    const byKey = new Map((assets ?? []).map(asset => [assetKey(asset), asset]))
    let plans = previous.plans.map(plan => advancePlan(plan, byKey.get(plan.key) ?? {}, scanAt))
    const additions = previous.observations.some(item => item.scanAt === scanAt) ? [] : (assets ?? []).flatMap(asset => {
      const signal = asset.signalHunter, shadow = signal?.shadowComparison
      if (!signal || !shadow) return []
      const plan = newPlan(asset, shadow, scanAt)
      if (plan && !plans.some(item => item.identity === plan.identity && !TERMINAL.has(item.status))) plans = [plan, ...plans]
      return [{ id: `${scanAt}:${assetKey(asset)}`, scanAt, key: assetKey(asset), symbol: asset.symbol, type: asset.type, source: asset.source, timeframe: shadow.timeframe ?? signal.timeframe ?? 'unknown', side: shadow.side ?? signal.side ?? 'unknown', setup: shadow.plan?.setup ?? 'unknown', stableVersion: signal.parameterVersion ?? 'v1', shadowVersion: shadow.version ?? 'v2', stablePassed: !signal.rejected && signal.status !== 'rejected', shadowPassed: Boolean(shadow.wouldPass), stableScore: signal.score?.total ?? null, shadowScore: shadow.score ?? null, shadowReason: shadow.reason ?? '' }]
    })
    const observations = [...additions, ...previous.observations].slice(0, MAX_OBSERVATIONS)
    plans = plans.slice(0, MAX_PLANS)
    set({ observations, plans })
    persistOperationalData('shadowStrategy', { observations, plans })
  },
}))

export default useShadowStrategyStore
