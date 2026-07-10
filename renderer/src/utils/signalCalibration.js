const MIN_SAMPLES = 12
const MAX_GROUP_SAMPLES = 40
const MAX_AGE_MS = 90 * 24 * 60 * 60 * 1000
const MAX_SCORE_DELTA = 0.35

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value))
}

function rowR(row) {
  if (Number.isFinite(row?.rMultiple)) return row.rMultiple
  return row?.result === 'win' ? 1.5 : -1
}

function entryMode(value) {
  const text = String(value ?? '').toLowerCase()
  if (text === 'breakout' || /confirm_long|breakout|突破/.test(text)) return 'breakout'
  if (text === 'breakdown' || /confirm_short|breakdown|跌破/.test(text)) return 'breakdown'
  if (text === 'base' || /base|蓄势|震荡/.test(text)) return 'base'
  if (text === 'retest' || /retest|支阻|回测/.test(text)) return 'retest'
  return 'pullback'
}

export function signalCalibrationKey(signal) {
  const timeframe = String(signal?.timeframe ?? '')
  const side = String(signal?.side ?? '')
  const mode = entryMode(signal?.entryMode ?? signal?.entryTrigger ?? signal?.setup)
  return `${timeframe}|${side}|${mode}`
}

export function buildSignalCalibration(tradeLogs, now = Date.now()) {
  const groups = new Map()
  const eligible = (tradeLogs ?? [])
    .filter(log => log?.result === 'win' || log?.result === 'loss')
    .filter(log => Number.isFinite(log?.enteredAt ?? log?.entryTime))
    .filter(log => !Number.isFinite(log?.closedAt ?? log?.exitTime) || now - (log.closedAt ?? log.exitTime) <= MAX_AGE_MS)
    .sort((a, b) => (b.closedAt ?? b.exitTime ?? 0) - (a.closedAt ?? a.exitTime ?? 0))

  for (const log of eligible) {
    const key = signalCalibrationKey(log)
    const [timeframe, side] = key.split('|')
    if (!['1h', '4h'].includes(timeframe) || !['long', 'short'].includes(side)) continue
    const rows = groups.get(key) ?? []
    if (rows.length < MAX_GROUP_SAMPLES) rows.push(log)
    groups.set(key, rows)
  }

  const entries = [...groups.entries()].map(([key, rows]) => {
    const wins = rows.filter(row => row.result === 'win').length
    const sumR = rows.reduce((sum, row) => sum + rowR(row), 0)
    const averageR = rows.length ? sumR / rows.length : 0
    const chronological = [...rows].sort((a, b) => (a.closedAt ?? a.exitTime ?? 0) - (b.closedAt ?? b.exitTime ?? 0))
    const splitAt = Math.max(1, Math.floor(chronological.length * 0.7))
    const training = chronological.slice(0, splitAt)
    const validation = chronological.slice(splitAt)
    const trainingR = training.length ? training.reduce((sum, row) => sum + rowR(row), 0) / training.length : 0
    const validationR = validation.length ? validation.reduce((sum, row) => sum + rowR(row), 0) / validation.length : 0
    const directionStable = Math.sign(trainingR) !== 0 && Math.sign(trainingR) === Math.sign(validationR)
    const confidence = Math.min(1, rows.length / 20)
    const active = rows.length >= MIN_SAMPLES && training.length >= 8 && validation.length >= 3 && directionStable
    const verifiedR = directionStable ? Math.sign(trainingR) * Math.min(Math.abs(trainingR), Math.abs(validationR)) : 0
    const delta = active
      ? Number(clamp(verifiedR * 0.22 * confidence, -MAX_SCORE_DELTA, MAX_SCORE_DELTA).toFixed(2))
      : 0
    const [timeframe, side, mode] = key.split('|')
    return {
      key,
      timeframe,
      side,
      entryMode: mode,
      samples: rows.length,
      wins,
      losses: rows.length - wins,
      winRate: rows.length ? wins / rows.length : null,
      averageR: Number(averageR.toFixed(2)),
      trainingSamples: training.length,
      validationSamples: validation.length,
      trainingR: Number(trainingR.toFixed(2)),
      validationR: Number(validationR.toFixed(2)),
      directionStable,
      delta,
      active,
    }
  }).sort((a, b) => b.samples - a.samples || b.averageR - a.averageR)

  return {
    entries,
    byKey: new Map(entries.map(item => [item.key, item])),
    recentLosses: eligible.filter(item => item.result === 'loss').slice(0, 100),
    eligibleSamples: eligible.length,
    activeGroups: entries.filter(item => item.active).length,
    minSamples: MIN_SAMPLES,
  }
}

export function findSignalCalibration(calibration, signal) {
  return calibration?.byKey?.get(signalCalibrationKey(signal)) ?? null
}

export function findRecentSignalLoss(calibration, signal, now = Date.now()) {
  const cooldownMs = signal?.timeframe === '4h' ? 24 * 60 * 60 * 1000 : 6 * 60 * 60 * 1000
  const key = signalCalibrationKey(signal)
  const symbol = String(signal?.symbol ?? '').toUpperCase()
  const entryPrice = Number(signal?.entryPrice)
  const match = (calibration?.recentLosses ?? []).find(log => {
    const closedAt = Number(log.closedAt ?? log.exitTime)
    if (!Number.isFinite(closedAt) || now - closedAt > cooldownMs) return false
    if (String(log.symbol ?? '').toUpperCase() !== symbol || signalCalibrationKey(log) !== key) return false
    const previousEntry = Number(log.entryPrice)
    if (!Number.isFinite(entryPrice) || !Number.isFinite(previousEntry)) return true
    return Math.abs(entryPrice - previousEntry) / Math.max(Math.abs(entryPrice), Math.abs(previousEntry), 1e-9) <= 0.03
  })
  if (!match) return null
  const closedAt = Number(match.closedAt ?? match.exitTime)
  return {
    closedAt,
    remainingMs: Math.max(0, cooldownMs - (now - closedAt)),
    previousEntry: Number.isFinite(Number(match.entryPrice)) ? Number(match.entryPrice) : null,
  }
}
