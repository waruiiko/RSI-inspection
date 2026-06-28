import { assetKey } from './assetKey'
import { getQuoteVolume } from './liquidity'

const TFS = ['1h', '4h']
const VALID_STATUSES = new Set(['armed', 'wait_entry', 'triggered', 'watch', 'risk', 'rejected'])
const VALID_SIDES = new Set(['long', 'short'])

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
  const stockBias = asset.type === 'stock' ? 24 : asset.type === 'tradfi' ? 12 : -8
  return stockBias + score * 16 + derivativeScore * 10 + localScore * 8 + Math.min(20, move * 2) + Math.min(12, Math.log10(turnover / 1_000_000 + 1) * 4)
}

export function buildSignalHunterAiCandidates(assets, limit = 60) {
  return assets
    .filter(asset => Number.isFinite(Number(asset?.price)))
    .map(asset => {
      const tf = pickTf(asset)
      const signal = TFS.includes(asset.signalHunter?.timeframe) ? asset.signalHunter : null
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
        localSignalHunter: signal ? {
          status: signal.status,
          side: signal.side,
          timeframe: signal.timeframe,
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
        priority: Math.round(candidatePriority(asset)),
      }
    })
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
  if (!turnover) flags.push('成交额缺失，流动性风险待确认')
  else if (turnover < 5_000_000) flags.push(`24h成交额 ${Math.round(turnover).toLocaleString()} < 5M，流动性不足`)
  if (asset.source === 'binance-futures' && !asset.derivatives) flags.push('OI / 资金费率数据缺失')
  return flags
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

export function minExecutableStopDistance(asset, sig) {
  const entry = finite(sig.entryPrice)
  if (!Number.isFinite(entry) || entry <= 0) return null

  const tfMult = sig.timeframe === '4h' ? 2 : sig.timeframe === '1h' ? 1.4 : 1
  if (asset.type === 'stock' || asset.type === 'tradfi') {
    const minPct = entry < 50 ? 0.018 : entry < 200 ? 0.015 : 0.012
    const minAbs = entry < 50 ? 0.50 : entry < 200 ? 1.00 : 2.00
    return Math.max(entry * minPct * tfMult, minAbs * tfMult)
  }
  return entry * (sig.timeframe === '4h' ? 0.018 : sig.timeframe === '1h' ? 0.012 : 0.008)
}

export function hasExecutableStopDistance(asset, sig) {
  const minDistance = minExecutableStopDistance(asset, sig)
  if (!Number.isFinite(minDistance) || !Number.isFinite(sig?.entryPrice) || !Number.isFinite(sig?.stopLoss)) return false
  return Math.abs(sig.entryPrice - sig.stopLoss) >= minDistance
}

function legalizeStatus(side, status, currentPrice, entryPrice) {
  if (!Number.isFinite(currentPrice) || !Number.isFinite(entryPrice)) return status
  if (side === 'short' && entryPrice <= currentPrice) return 'triggered'
  if (side === 'long' && entryPrice >= currentPrice) return 'triggered'
  return status
}

function validateSignal(sig, asset) {
  const reasons = []
  const targets = Array.isArray(sig.targets) ? sig.targets : []
  if (!VALID_SIDES.has(sig.side)) reasons.push('方向无效')
  if (!Number.isFinite(sig.entryPrice)) reasons.push('入场价无效')
  if (!Number.isFinite(sig.stopLoss)) reasons.push('失效价无效')
  if (!Number.isFinite(sig.currentPrice)) reasons.push('现价无效')
  if (!targets.length) reasons.push('目标位缺失')
  if ((sig.score?.total ?? 0) < 7) reasons.push('评分低于 7')
  if (!Number.isFinite(sig.rewardRisk) || sig.rewardRisk < 1.5) reasons.push('低于 1.5R')
  if (sig.side === 'long' && Number.isFinite(sig.stopLoss) && Number.isFinite(sig.entryPrice) && sig.stopLoss >= sig.entryPrice) reasons.push('做多失效价应低于入场')
  if (sig.side === 'short' && Number.isFinite(sig.stopLoss) && Number.isFinite(sig.entryPrice) && sig.stopLoss <= sig.entryPrice) reasons.push('做空失效价应高于入场')
  if (sig.side === 'long' && targets.some(target => !Number.isFinite(target) || target <= sig.entryPrice)) reasons.push('做多目标位应高于入场')
  if (sig.side === 'short' && targets.some(target => !Number.isFinite(target) || target >= sig.entryPrice)) reasons.push('做空目标位应低于入场')
  const minStopDistance = minExecutableStopDistance(asset, sig)
  if (Number.isFinite(minStopDistance) && Number.isFinite(sig.entryPrice) && Number.isFinite(sig.stopLoss)) {
    const stopDistance = Math.abs(sig.entryPrice - sig.stopLoss)
    if (stopDistance < minStopDistance) {
      reasons.push(`失效距离过窄：${stopDistance.toFixed(2)} < 最小可执行 ${minStopDistance.toFixed(2)}`)
    }
  }
  return reasons
}

export function normalizeSignalHunterAiResults(aiResult, assets) {
  const items = Array.isArray(aiResult?.items)
    ? aiResult.items
    : Array.isArray(aiResult?.signals)
      ? aiResult.signals
      : []
  const bySymbol = new Map(assets.map(asset => [String(asset.symbol).toUpperCase(), asset]))
  const byKey = new Map(assets.map(asset => [assetKey(asset), asset]))

  return items.map(item => {
    const ref = String(item.key ?? '').trim()
    const asset = byKey.get(ref) ?? bySymbol.get(String(item.symbol ?? '').toUpperCase())
    if (!asset) return null

    const side = VALID_SIDES.has(String(item.side).toLowerCase()) ? String(item.side).toLowerCase() : 'long'
    const currentPrice = finite(item.currentPrice ?? item.price ?? asset.price)
    const entryPrice = finite(item.entryPrice ?? item.entry ?? item.triggerPrice)
    const confirmPrice = finite(item.confirmPrice ?? item.confirm ?? entryPrice)
    const stopLoss = finite(item.stopLoss ?? item.stop)
    const targets = normalizeTargets(item)
    const rewardRisk = finite(item.rewardRisk ?? item.rr) ?? deriveRewardRisk(side, entryPrice, stopLoss, targets)
    const rawStatus = VALID_STATUSES.has(String(item.status)) ? String(item.status) : 'watch'
    const total = Number(clamp(item.score?.total ?? item.totalScore ?? item.score, 0, 10).toFixed(1))
    const chart = Number(clamp(item.score?.chart ?? item.chartScore, 0, 10).toFixed(1))
    const data = Number(clamp(item.score?.data ?? item.dataScore, 0, 10).toFixed(1))
    const risk = Number(clamp(item.score?.risk ?? item.riskScore, -3, 2).toFixed(1))
    const status = legalizeStatus(side, rawStatus, currentPrice, entryPrice)
    const baseReasons = Array.isArray(item.reasons) ? item.reasons : [item.reason].filter(Boolean)
    const riskFlags = Array.isArray(item.riskFlags) ? item.riskFlags : [item.risk].filter(Boolean)
    const narrativeTags = Array.isArray(item.narrativeTags) ? item.narrativeTags : []

    const sig = {
      source: 'ai',
      status,
      side,
      timeframe: TFS.includes(item.timeframe)
        ? item.timeframe
        : TFS.includes(asset.signalHunter?.timeframe)
          ? asset.signalHunter.timeframe
          : '1h',
      setup: item.setup ?? 'ai_structure',
      setupLabel: item.setupLabel ?? item.pattern ?? 'AI 结构候选',
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
      targetBasis: 'ai_structure',
      score: {
        total,
        chart,
        data,
        risk,
        rewardRisk,
        weights: 'AI structure + hard guards',
      },
      reasons: baseReasons.slice(0, 5),
      riskFlags: [...new Set([...riskFlags, ...localRiskFlags(asset)])].slice(0, 8),
      narrativeSummary: String(item.narrativeSummary ?? item.narrative ?? '').trim(),
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

    return { key: assetKey(asset), symbol: asset.symbol, signalHunter: sig }
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
    item?.symbol ?? '',
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
