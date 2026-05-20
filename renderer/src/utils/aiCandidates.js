import { getQuoteVolume } from './liquidity'

export const AI_TFS = ['15m', '1h', '4h', '1d']

export const AI_DECISION_LABELS = {
  focus: '重点',
  watch: '观察',
  ignore: '忽略',
  risk: '风险',
}

export function normalizeDecision(value) {
  const v = String(value || '').toLowerCase()
  return ['focus', 'watch', 'ignore', 'risk'].includes(v) ? v : 'watch'
}

function fmtPct(v) {
  if (v == null || Number.isNaN(v)) return '-'
  return `${v >= 0 ? '+' : ''}${Number(v).toFixed(2)}%`
}

function maxAbsScore(scores = {}) {
  return Math.max(0, ...Object.values(scores).map(v => Math.abs(Number(v) || 0)))
}

function volumeReason(asset) {
  const entries = Object.entries(asset.volumeSignal ?? {})
    .filter(([, sig]) => sig && sig.direction && sig.direction !== 'neutral')
  if (!entries.length) return null
  const [tf, sig] = entries.sort((a, b) =>
    Math.abs(asset.signalScore?.[b[0]] ?? 0) - Math.abs(asset.signalScore?.[a[0]] ?? 0)
  )[0]
  return `${tf} ${sig.label ?? '量价信号'}`
}

function divergenceReason(asset) {
  const entries = Object.entries(asset.divergence ?? {}).filter(([, v]) => v)
  if (!entries.length) return null
  const [tf, type] = entries[0]
  return `${tf} ${type === 'bullish' ? '牛市背离' : '熊市背离'}`
}

export function buildCandidate(asset) {
  const rsi = asset.rsi ?? {}
  const scores = asset.signalScore ?? {}
  const score = maxAbsScore(scores)
  const rsiExtreme = AI_TFS.filter(tf => rsi[tf] != null && (rsi[tf] >= 70 || rsi[tf] <= 30))
  const rsiHot = AI_TFS.filter(tf => rsi[tf] != null && (rsi[tf] >= 65 || rsi[tf] <= 35))
  const bullAlign = AI_TFS.filter(tf => rsi[tf] >= 55).length
  const bearAlign = AI_TFS.filter(tf => rsi[tf] <= 45).length
  const div = divergenceReason(asset)
  const vol = volumeReason(asset)
  const move = Math.abs(asset.change24h ?? 0)
  const turnover = getQuoteVolume(asset)

  const reasons = []
  let priority = 0
  if (score >= 4) { priority += score * 12; reasons.push(`量价评分 ${score}`) }
  else if (score >= 2) { priority += score * 8; reasons.push(`量价评分 ${score}`) }
  if (vol) { priority += 18; reasons.push(vol) }
  if (div) { priority += 26; reasons.push(div) }
  if (rsiExtreme.length) { priority += rsiExtreme.length * 12; reasons.push(`${rsiExtreme.join('/')} RSI 极值`) }
  else if (rsiHot.length) { priority += rsiHot.length * 7; reasons.push(`${rsiHot.join('/')} RSI 接近极值`) }
  if (bullAlign >= 3 || bearAlign >= 3) {
    priority += 10
    reasons.push(bullAlign >= 3 ? '多周期偏强' : '多周期偏弱')
  }
  if (move >= 4) { priority += Math.min(20, move * 2); reasons.push(`24H 波动 ${fmtPct(asset.change24h)}`) }
  if (asset.derivatives?.score) {
    priority += Math.abs(asset.derivatives.score) * 10
    reasons.push(asset.derivatives.label ?? '资金结构')
  }
  if (turnover) priority += Math.min(10, Math.log10(turnover / 1_000_000 + 1) * 3)

  return {
    symbol: asset.symbol,
    source: asset.source,
    type: asset.type,
    price: asset.price,
    change24h: asset.change24h,
    turnover,
    rsi: Object.fromEntries(AI_TFS.map(tf => [tf, rsi[tf] ?? null])),
    divergence: asset.divergence ?? {},
    volumeSignal: asset.volumeSignal ?? {},
    signalScore: scores,
    derivatives: asset.derivatives ?? null,
    opportunityStage: classifyOpportunityStage(asset),
    priority: Math.round(priority),
    localReasons: reasons.slice(0, 4),
  }
}

export function classifyOpportunityStage(asset) {
  const d = asset.derivatives
  if (!d) return null
  if (d.stage === 'crowded') return 'risk'
  if (d.stage === 'early_build') return 'early'
  if (d.stage === 'long_build' && (asset.rsi?.['4h'] ?? 50) < 72) return 'entry_window'
  if (d.stage === 'short_cover') return 'pullback_watch'
  if (Math.abs(d.score ?? 0) >= 4) return d.score > 0 ? 'early' : 'risk'
  return null
}

export function buildCandidates(assets, limit = 30) {
  return assets
    .map(buildCandidate)
    .filter(c => c.priority >= 24 || c.localReasons.length >= 2)
    .sort((a, b) => b.priority - a.priority)
    .slice(0, limit)
}

export function candidateSignature(candidates) {
  return candidates
    .slice(0, 12)
    .map(c => `${c.symbol}:${Math.floor(c.priority / 10)}:${c.localReasons.join('|')}`)
    .join(';')
}

export function makeAiFeedItems(candidates, aiItems, now = Date.now()) {
  const bySymbol = new Map()
  for (const item of aiItems ?? []) bySymbol.set(String(item.symbol).toUpperCase(), item)
  return candidates
    .map(c => {
      const ai = bySymbol.get(c.symbol.toUpperCase())
      if (!ai) return null
      const decision = normalizeDecision(ai.decision)
      const confidence = Number(ai.confidence) || 0
      if (decision !== 'focus' && decision !== 'risk' && !(decision === 'watch' && confidence >= 80)) return null
      return {
        id: `ai-${c.symbol}-${now}`,
        ts: now,
        symbol: c.symbol,
        type: 'ai',
        condition: decision,
        value: confidence,
        price: c.price,
        change24h: c.change24h,
        level: decision === 'focus' || decision === 'risk' ? 2 : 1,
        reason: ai.reason,
        risk: ai.risk,
        nextCheck: ai.next_check,
      }
    })
    .filter(Boolean)
}
