import { assetKey, sameUnderlying, underlyingKey } from './assetKey'
import { getUSMarketPhase } from './marketHours'

const ETF_SYMBOLS = new Set(['ARKK', 'DIA', 'EEM', 'EWJ', 'EWT', 'EWY', 'EWZ', 'GLD', 'IWM', 'QQQ', 'SLV', 'SPY', 'TLT', 'USO', 'VIX'])
const COMMODITY_WORDS = /GOLD|SILVER|COPPER|OIL|BRENT|WTI|NATURALGAS|PLATINUM|PALLADIUM/i
export const CROSS_MARKET_MAPPING_KEY = 'rsi:crossMarket:mappingDecisions'

export function mappingDecision(key) {
  try { return JSON.parse(localStorage.getItem(CROSS_MARKET_MAPPING_KEY) || '{}')[key] ?? 'auto' }
  catch { return 'auto' }
}

export function tradfiSubtype(asset) {
  if (asset?.type !== 'tradfi') return asset?.type ?? 'other'
  const symbol = String(asset.symbol ?? '').toUpperCase()
  const text = `${symbol} ${asset.name ?? ''}`
  if (ETF_SYMBOLS.has(symbol) || /\bETF\b/i.test(text)) return 'etf_perp'
  if (COMMODITY_WORDS.test(text)) return 'commodity_perp'
  if (/INDEX|NASDAQ|DOW|S&P|RUSSELL/i.test(text)) return 'index_perp'
  return 'equity_perp'
}

export function buildCrossMarketIndex(assets) {
  const index = new Map()
  for (const asset of assets ?? []) {
    const key = underlyingKey(asset)
    if (!key) continue
    const group = index.get(key) ?? []
    group.push(asset)
    index.set(key, group)
  }
  return index
}

function signalDirection(asset) {
  const sig = asset?.signalHunter
  if (!sig || sig.rejected || sig.status === 'rejected') return null
  return sig.side === 'long' || sig.side === 'short' ? sig.side : null
}

export function crossMarketContext(asset, assets, now = new Date(), index = null) {
  const key = underlyingKey(asset)
  const group = index?.get(key) ?? assets ?? []
  const siblings = mappingDecision(key) === 'excluded' ? [] : group.filter(other => assetKey(other) !== assetKey(asset) && sameUnderlying(other, asset))
  const cash = [asset, ...siblings].find(item => item.type === 'stock' || item.source === 'yahoo') ?? null
  const perp = [asset, ...siblings].find(item => item.type === 'tradfi') ?? null
  const cashPrice = Number(cash?.price)
  const perpPrice = Number(perp?.price)
  const cashAvailable = !!cash && cash?.dataQuality?.ok !== false && Number.isFinite(cashPrice) && cashPrice > 0
  const basisPct = cashAvailable && Number.isFinite(perpPrice)
    ? ((perpPrice - cashPrice) / cashPrice) * 100
    : null
  const cashSide = signalDirection(cash)
  const perpSide = signalDirection(perp)
  const confirmation = cash && !cashAvailable ? 'cash_unavailable' : cashSide && perpSide
    ? cashSide === perpSide ? 'confirmed' : 'diverged'
    : cashSide || perpSide ? 'single' : 'none'
  const phase = getUSMarketPhase(now)
  const requiresCashConfirmation = !!perp && phase !== 'regular'
  const fetchedAt = Math.max(Number(asset?.liquidity?.fetchedAt) || 0, Number(asset?.derivatives?.fetchedAt) || 0)
  const stale = fetchedAt > 0 && Date.now() - fetchedAt > 20 * 60 * 1000
  return { key, siblings, cash, perp, cashAvailable, basisPct, confirmation, phase, requiresCashConfirmation, stale, contractQuality: assessContractQuality(perp), mappingDecision: mappingDecision(key) }
}

export function assessContractQuality(asset) {
  if (!asset || asset.type !== 'tradfi') return null
  const turnover = Number(asset.quoteVolume24h ?? asset.turnover ?? asset.volume24h) || 0
  const spread = Number(asset.liquidity?.spreadPct)
  const depth = Number(asset.liquidity?.topBookNotional ?? asset.liquidity?.depth?.topBookNotional)
  const hasDerivatives = asset.derivatives?.oiValue != null || asset.derivatives?.fundingRate != null
  let score = 0
  score += turnover >= 50_000_000 ? 35 : turnover >= 10_000_000 ? 25 : turnover >= 2_000_000 ? 15 : 5
  score += Number.isFinite(spread) ? spread <= 0.08 ? 25 : spread <= 0.2 ? 15 : spread <= 0.5 ? 5 : 0 : 0
  score += Number.isFinite(depth) ? depth >= 250_000 ? 25 : depth >= 50_000 ? 15 : depth >= 10_000 ? 5 : 0 : 5
  score += hasDerivatives ? 15 : 0
  const grade = score >= 80 ? 'A' : score >= 65 ? 'B' : score >= 45 ? 'C' : 'D'
  return { score, grade, executable: score >= 65, turnover, spreadPct: Number.isFinite(spread) ? spread : null, topBookNotional: Number.isFinite(depth) ? depth : null }
}

export function appendBasisSample(history = {}, context, now = Date.now()) {
  if (!context?.key || !Number.isFinite(context.basisPct)) return history
  const samples = [...(history[context.key] ?? []), { ts: now, value: context.basisPct }]
    .filter(item => now - item.ts <= 30 * 24 * 60 * 60 * 1000)
    .slice(-240)
  return { ...history, [context.key]: samples }
}

export function basisStatistics(history = {}, key, current) {
  const values = (history[key] ?? []).map(item => Number(item.value)).filter(Number.isFinite)
  if (values.length < 12 || !Number.isFinite(current)) return { samples: values.length, mean: null, zScore: null, abnormal: false }
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length
  const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length
  const deviation = Math.sqrt(variance)
  const zScore = deviation > 0.01 ? (current - mean) / deviation : 0
  return { samples: values.length, mean, zScore, abnormal: Math.abs(zScore) >= 2.5 }
}

export function universeTier(asset, assets, index = null) {
  const group = index?.get(underlyingKey(asset)) ?? assets ?? []
  const paired = group.some(other => assetKey(other) !== assetKey(asset) && sameUnderlying(other, asset))
  if (paired) return 'dual_core'
  if (asset?.type === 'tradfi') return 'tradfi_only'
  if (asset?.type === 'stock') return 'stock_only'
  return 'other'
}

export function reconcileDivergenceStates(assets, states = {}, now = Date.now(), index = buildCrossMarketIndex(assets)) {
  const next = { ...states }
  for (const [key, group] of index) {
    const cash = group.find(item => item.type === 'stock')
    const perp = group.find(item => item.type === 'tradfi')
    if (!cash || !perp) continue
    const context = crossMarketContext(perp, assets, new Date(now), index)
    const previous = next[key]
    if (context.confirmation === 'diverged') {
      next[key] = { key, status: 'diverged', startedAt: previous?.status === 'diverged' ? previous.startedAt : now, updatedAt: now }
      continue
    }
    if (context.confirmation !== 'confirmed') continue
    if (previous?.status === 'diverged') {
      next[key] = { ...previous, status: 'recovering', recoveryCandidateAt: now, updatedAt: now }
      continue
    }
    if (previous?.status === 'recovering') {
      const timeframe = perp.signalHunter?.timeframe === '4h' || cash.signalHunter?.timeframe === '4h' ? '4h' : '1h'
      const requiredMs = timeframe === '4h' ? 4 * 60 * 60 * 1000 : 60 * 60 * 1000
      if (now - previous.recoveryCandidateAt >= requiredMs) next[key] = { ...previous, status: 'recovered', recoveredAt: now, updatedAt: now }
    }
  }
  return next
}

export function reconcileOpenValidationQueue(assets, queue = [], now = Date.now()) {
  const phase = getUSMarketPhase(new Date(now))
  const byId = new Map((queue ?? []).map(item => [item.id, item]))
  for (const asset of assets ?? []) {
    const sig = asset?.signalHunter
    if (asset?.type !== 'tradfi' || !sig || sig.rejected || !['triggered', 'armed', 'wait_entry', 'wait_confirm'].includes(sig.status)) continue
    const id = `${underlyingKey(asset)}|${sig.side}|${sig.timeframe}`
    if (phase !== 'regular' && !byId.has(id)) {
      byId.set(id, {
        id, underlyingKey: underlyingKey(asset), symbol: asset.symbol, apiSymbol: asset.apiSymbol,
        source: asset.source, side: sig.side, timeframe: sig.timeframe, status: 'pending_open',
        queuedAt: now, perpPrice: asset.price, entryPrice: sig.entryPrice ?? sig.triggerPrice ?? null,
      })
    }
  }
  if (phase === 'regular') {
    for (const [id, item] of byId) {
      if (item.status !== 'pending_open') continue
      const cash = (assets ?? []).find(asset => underlyingKey(asset) === item.underlyingKey && asset.type === 'stock')
      const side = signalDirection(cash)
      if (!cash?.price) continue
      byId.set(id, {
        ...item, checkedAt: now, cashPrice: cash.price,
        status: side === item.side ? 'confirmed' : side ? 'diverged' : 'unconfirmed',
      })
    }
  }
  return [...byId.values()].filter(item => now - (item.queuedAt ?? now) < 14 * 24 * 60 * 60 * 1000)
}
