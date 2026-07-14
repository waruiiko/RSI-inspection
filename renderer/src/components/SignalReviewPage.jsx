import { lazy, Suspense, useEffect, useMemo, useState } from 'react'
import useSignalReviewStore, { captureRejectReason } from '../store/signalReviewStore'
import useMarketStore from '../store/marketStore'
import { formatPrice } from '../utils/rsi'
import { signalIdFromReviewItem } from '../utils/signalId'
import { buildSignalCalibration } from '../utils/signalCalibration'

const ChartModal = lazy(() => import('./ChartModal'))

const SH_FOCUS_KEY = 'rsi:signalHunter:focus'
const MIN_TAKE_PROFIT_R = 1.5
const REPORT_PERIODS = [
  { key: '24h', label: '24H', days: 1 },
  { key: '7d', label: '7D', days: 7 },
  { key: '30d', label: '30D', days: 30 },
]

function fmtTime(ts) {
  if (!ts) return '-'
  return new Date(ts).toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })
}

function fmtPct(value) {
  if (!Number.isFinite(value)) return '-'
  return `${value >= 0 ? '+' : ''}${value.toFixed(2)}%`
}

function fmtR(value) {
  if (!Number.isFinite(value)) return '-'
  return `${value >= 0 ? '+' : ''}${value.toFixed(2)}R`
}

function fmtRate(count, total) {
  if (!total) return '-'
  return `${((count / total) * 100).toFixed(1)}% (${count}/${total})`
}

function sideLabel(side) {
  return side === 'short' ? '做空' : '做多'
}

function resultTone(result) {
  if (result === 'win') return 'win'
  if (result === 'loss') return 'loss'
  if (result === 'not_entered') return 'muted'
  if (result === 'ambiguous') return 'muted'
  return 'open'
}

function horizonText(item, key) {
  const h = item.horizons?.[key]
  return h ? fmtPct(h.returnPct) : '等待'
}

function fallbackTargets(item) {
  if (!Number.isFinite(item.entryPrice) || !Number.isFinite(item.stopLoss) || !item.entryPrice) return []
  const unit = Math.max(Math.abs(item.entryPrice - item.stopLoss), item.entryPrice * 0.018)
  return [MIN_TAKE_PROFIT_R, 2, 3].map(mult => item.side === 'short'
    ? item.entryPrice - unit * mult
    : item.entryPrice + unit * mult)
}

function targetR(item, target) {
  if (!Number.isFinite(item.entryPrice) || !Number.isFinite(item.stopLoss) || !Number.isFinite(target)) return null
  const risk = Math.abs(item.entryPrice - item.stopLoss)
  if (!risk) return null
  const reward = item.side === 'short' ? item.entryPrice - target : target - item.entryPrice
  return reward / risk
}

function targetsOf(item) {
  const targets = (item.targets ?? [])
    .filter(Number.isFinite)
    .filter(target => (targetR(item, target) ?? -Infinity) >= MIN_TAKE_PROFIT_R)
    .sort((a, b) => (targetR(item, a) ?? 0) - (targetR(item, b) ?? 0))
  return targets.length ? targets : fallbackTargets(item)
}

function displaySetup(setup) {
  const labelMap = {
    base_long: '窄幅蓄势做多',
    base_short: '窄幅蓄势做空',
    压缩基地多: '窄幅蓄势做多',
    压缩基地空: '窄幅蓄势做空',
    压缩基地: '窄幅蓄势',
  }
  return labelMap[setup] || setup || 'Signal Hunter'
}

function statusLabel(row) {
  if (row.result === 'loss') return 'STOPPED'
  if (row.result === 'win') return row.hitTarget ? `TP${row.hitTarget}` : 'TP'
  if (row.result === 'ambiguous') return '顺序不明'
  if (row.enteredAt) return 'TRIGGERED'
  if (row.result === 'not_entered') return '未触发'
  return '观察中'
}

function signalIdOf(item) {
  return item?.signalId ?? signalIdFromReviewItem(item)
}

function rowMaxMove(row) {
  const values = [row.maxReturnPct, row.returnPct, row.currentReturnPct].filter(Number.isFinite)
  return values.length ? Math.max(...values) : null
}


function sumR(rows) {
  return rows.reduce((sum, row) => sum + (Number.isFinite(row.rMultiple) ? row.rMultiple : 0), 0)
}

function groupTradeLogs(rows, keyFn, labelFn) {
  const groups = new Map()
  for (const row of rows) {
    const rawKey = keyFn(row)
    if (!rawKey) continue
    const key = String(rawKey)
    if (!groups.has(key)) {
      groups.set(key, {
        key,
        label: labelFn?.(row, key) ?? key,
        total: 0,
        wins: 0,
        losses: 0,
        netR: 0,
      })
    }
    const group = groups.get(key)
    group.total += 1
    if (row.result === 'win') group.wins += 1
    if (row.result === 'loss') group.losses += 1
    group.netR += Number.isFinite(row.rMultiple) ? row.rMultiple : 0
  }

  return [...groups.values()]
    .map(group => ({
      ...group,
      winRate: group.total ? (group.wins / group.total) * 100 : null,
    }))
    .sort((a, b) => {
      const netDiff = (b.netR ?? 0) - (a.netR ?? 0)
      if (netDiff) return netDiff
      return b.total - a.total
    })
}

function groupCountLabel(group) {
  return `${group.total} 单 / ${group.winRate == null ? '-' : `${group.winRate.toFixed(1)}%`} / ${fmtR(group.netR)}`
}

function reviewQualificationNext(asset, minScore) {
  const sig = asset?.signalHunter
  if (!sig) return '等待 Signal Hunter 生成结构'
  if (asset.dataQuality?.ok === false || sig.runtimeBlocked) return `补齐数据后自动重试${(asset.dataQuality?.issues ?? sig.runtimeBlockReasons ?? []).length ? `：${(asset.dataQuality?.issues ?? sig.runtimeBlockReasons).join(' / ')}` : ''}`
  if (sig.rejected || sig.status === 'rejected') return sig.rejectReasons?.at(-1) ?? '等待下一次形成新的有效结构'
  if (sig.executionEligible === false) return '当前仅观察；等待止损距离、流动性和入场位置满足可执行条件'
  if (sig.stability && !sig.stability.confirmed && sig.status !== 'triggered') return '等待下一轮扫描确认结构稳定'
  if ((sig.score?.total ?? 0) < minScore) return `当前 ${(sig.score?.total ?? 0).toFixed(1)} 分，复盘门槛 ${minScore.toFixed(1)} 分`
  if (!Number.isFinite(sig.entryPrice ?? sig.triggerPrice) || !Number.isFinite(sig.stopLoss)) return '等待生成完整入场价和失效位'
  return '等待状态转为可复盘阶段'
}

function winRateConfidence(wins, total) {
  if (!total) return null
  const z = 1.96
  const p = wins / total
  const denominator = 1 + z * z / total
  const center = (p + z * z / (2 * total)) / denominator
  const margin = z * Math.sqrt((p * (1 - p) + z * z / (4 * total)) / total) / denominator
  return { low: Math.max(0, center - margin) * 100, high: Math.min(1, center + margin) * 100, sufficient: total >= 30 }
}

function fmtDuration(ms) {
  if (!Number.isFinite(ms)) return '-'
  const hours = ms / 36e5
  return hours < 1 ? `${Math.round(ms / 60000)}分` : `${hours.toFixed(1)}小时`
}

function calibrationModeLabel(mode) {
  return {
    pullback: '回踩/反抽',
    retest: '支阻回测',
    base: '区间蓄势',
    breakout: '向上突破',
    breakdown: '向下跌破',
  }[mode] ?? mode
}

function buildReviewReport(items, tradeLogs, period) {
  const cutoff = Date.now() - period.days * 24 * 60 * 60 * 1000
  const byKey = new Map()
  for (const item of items) {
    if ((item.capturedAt ?? 0) >= cutoff || (item.closedAt ?? 0) >= cutoff || (item.lastUpdatedAt ?? 0) >= cutoff) {
      byKey.set(item.key, item)
    }
  }
  for (const log of tradeLogs) {
    if ((log.closedAt ?? 0) >= cutoff && !byKey.has(log.key)) {
      byKey.set(log.key, log)
    }
  }

  const rows = [...byKey.values()].sort((a, b) => (rowMaxMove(b) ?? -Infinity) - (rowMaxMove(a) ?? -Infinity))
  const total = rows.length
  const wins = rows.filter(row => row.result === 'win')
  const losses = rows.filter(row => row.result === 'loss')
  const ambiguous = rows.filter(row => row.result === 'ambiguous')
  const open = rows.filter(row => row.enteredAt && !['win', 'loss', 'ambiguous'].includes(row.result))
  const tpCount = level => wins.filter(row => (row.hitTarget ?? 1) >= level).length
  const positiveMoves = rows.map(rowMaxMove).filter(Number.isFinite).filter(v => v > 0)
  const avgMaxMove = positiveMoves.length
    ? positiveMoves.reduce((sum, value) => sum + value, 0) / positiveMoves.length
    : null
  const stars = rows.filter(row => Number.isFinite(rowMaxMove(row))).slice(0, 5)
  const highlights = []
  if (stars[0]) highlights.push(`${stars[0].symbol} ${signalIdOf(stars[0])} ${fmtPct(rowMaxMove(stars[0]))} 为过去${period.label}最强`)
  if (losses.length) highlights.push(`止损 ${losses.length} 个，止损率 ${fmtRate(losses.length, total)}`)
  else if (total) highlights.push(`过去${period.label}暂无止损信号`)
  if (open.length) highlights.push(`${open.length} 个信号仍在跟踪中`)
  if (wins.length) highlights.push(`${wins.length} 个信号已经触达止盈目标`)
  if (ambiguous.length) highlights.push(`${ambiguous.length} 个样本同K线触及止损与目标，未计入校准`)

  return {
    rows,
    total,
    wins,
    losses,
    ambiguous,
    open,
    stars,
    avgMaxMove,
    tp1: tpCount(1),
    tp2: tpCount(2),
    tp3: tpCount(3),
    highlights,
    periodLabel: period.label,
  }
}

function reportText(report) {
  return [
    `打榜猎人 SH ${report.periodLabel} 复盘`,
    `总信号: ${report.total}`,
    `有效突破率: ${fmtRate(report.wins.length, report.total)}`,
    `止损率: ${fmtRate(report.losses.length, report.total)}`,
    `仅触发: ${fmtRate(report.open.length, report.total)}`,
    `盈利信号平均最大涨幅: ${fmtPct(report.avgMaxMove)}`,
    '',
    'TOP 明星:',
    ...report.stars.slice(0, 5).map((row, index) => `${index + 1}. ${signalIdOf(row)} ${row.symbol} ${statusLabel(row)} ${fmtPct(rowMaxMove(row))}`),
    '',
    '亮点:',
    ...report.highlights.map(item => `- ${item}`),
  ].join('\n')
}

export default function SignalReviewPage({ onNavigate }) {
  const assets = useMarketStore(s => s.assets)
  const items = useSignalReviewStore(s => s.items)
  const tradeLogs = useSignalReviewStore(s => s.tradeLogs)
  const minScore = useSignalReviewStore(s => s.minScore)
  const entryConfirmBufferPct = useSignalReviewStore(s => s.entryConfirmBufferPct)
  const captureRejectStats = useSignalReviewStore(s => s.captureRejectStats)
  const cleanNotice = useSignalReviewStore(s => s.cleanNotice)
  const remove = useSignalReviewStore(s => s.remove)
  const clear = useSignalReviewStore(s => s.clear)
  const clearTradeLogs = useSignalReviewStore(s => s.clearTradeLogs)
  const setMinScore = useSignalReviewStore(s => s.setMinScore)
  const setEntryConfirmBufferPct = useSignalReviewStore(s => s.setEntryConfirmBufferPct)
  const clearCleanNotice = useSignalReviewStore(s => s.clearCleanNotice)
  const [view, setView] = useState('report')
  const [overviewCollapsed, setOverviewCollapsed] = useState(() => localStorage.getItem('rsi:signalReview:overviewCollapsed') === '1')
  const [reportPeriod, setReportPeriod] = useState('24h')
  const [filter, setFilter] = useState('all')
  const [sampleQuery, setSampleQuery] = useState('')
  const [logFilter, setLogFilter] = useState('all')
  const [logQuery, setLogQuery] = useState('')
  const [logMinScore, setLogMinScore] = useState(minScore)
  const [logWindow, setLogWindow] = useState(() => {
    const value = Number(localStorage.getItem('rsi:signalReview:recentCount'))
    return Number.isFinite(value) ? Math.min(200, Math.max(5, value)) : 20
  })
  const [chartSelection, setChartSelection] = useState(null)
  const [replayBusy, setReplayBusy] = useState(false)
  const [replayReport, setReplayReport] = useState(null)
  const [replayError, setReplayError] = useState('')
  const [replayHistory, setReplayHistory] = useState([])

  useEffect(() => {
    window.api?.loadSignalReplayHistory?.()
      .then(items => setReplayHistory(Array.isArray(items) ? items : []))
      .catch(err => console.warn('[signal-replay-history]', err))
  }, [])

  const runReplay = async () => {
    if (!window.api?.runSignalHunterReplay || replayBusy) return
    setReplayBusy(true)
    setReplayError('')
    try {
      const selected = assets
        .filter(asset => asset.signalHunter?.structureCandidates?.length)
        .slice(0, 12)
        .map(({ symbol, apiSymbol, source, type, name }) => ({ symbol, apiSymbol, source, type, name }))
      const result = await window.api.runSignalHunterReplay({ assets: selected, maxAssets: 12 })
      setReplayReport(result)
      setReplayHistory(previous => [result, ...previous].slice(0, 90))
    } catch (err) {
      setReplayError(err.message)
    } finally {
      setReplayBusy(false)
    }
  }
  const [showLogBreakdown, setShowLogBreakdown] = useState(false)
  const [confirmClear, setConfirmClear] = useState(false)
  const [confirmClearLogs, setConfirmClearLogs] = useState(false)
  const [confirmClearAll, setConfirmClearAll] = useState(false)
  const reportPeriodMeta = REPORT_PERIODS.find(period => period.key === reportPeriod) ?? REPORT_PERIODS[0]
  const report = useMemo(() => buildReviewReport(items, tradeLogs, reportPeriodMeta), [items, tradeLogs, reportPeriodMeta])
  const crossMarketStats = useMemo(() => {
    const groups = ['confirmed', 'diverged', 'single', 'none'].map(key => {
      const logs = tradeLogs.filter(item => (item.crossMarketConfirmation ?? 'none') === key)
      const closed = logs.filter(item => item.result === 'win' || item.result === 'loss')
      const wins = closed.filter(item => item.result === 'win').length
      const avgR = closed.length ? closed.reduce((sum, item) => sum + (Number(item.rMultiple) || 0), 0) / closed.length : null
      return { key, count: closed.length, winRate: closed.length ? wins / closed.length * 100 : null, avgR, confidence: winRateConfidence(wins, closed.length) }
    })
    return groups.filter(group => group.count)
  }, [tradeLogs])
  const captureRejectRows = useMemo(() => {
    const reasons = captureRejectStats?.reasons ?? {}
    return Object.entries(reasons)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 6)
  }, [captureRejectStats])
  const pendingQualification = useMemo(() => assets
    .filter(asset => asset.signalHunter)
    .map(asset => ({
      key: `${asset.source}:${asset.apiSymbol ?? asset.symbol}`,
      symbol: asset.symbol,
      reason: captureRejectReason(asset, minScore),
      updatedAt: asset.signalHunter?.lastLifecycleCheckAt ?? asset.signalHunter?.detectedAt ?? null,
      next: reviewQualificationNext(asset, minScore),
    }))
    .filter(item => item.reason)
    .slice(0, 20), [assets, minScore])

  const handleClear = () => {
    clear()
    setConfirmClear(false)
  }

  const handleClearLogs = () => {
    clearTradeLogs()
    setConfirmClearLogs(false)
  }

  const handleClearAll = () => {
    clear()
    clearTradeLogs()
    setConfirmClear(false)
    setConfirmClearLogs(false)
    setConfirmClearAll(false)
  }

  const copyReport = async () => {
    await navigator.clipboard?.writeText(reportText(report))
  }

  const openInSignalHunter = (item) => {
    localStorage.setItem(SH_FOCUS_KEY, JSON.stringify({
      symbol: item.symbol,
      timeframe: item.timeframe,
      signalId: signalIdOf(item),
      ts: Date.now(),
    }))
    onNavigate?.('signal-hunter')
  }

  const filtered = useMemo(() => {
    const q = sampleQuery.trim().toUpperCase()
    return items
      .filter(item => {
        if (filter === 'all') return true
        if (filter === 'entered') return item.enteredAt
        return item.result === filter
      })
      .filter(item => !q || [
        signalIdOf(item),
        item.symbol,
        item.name,
        item.setup,
        item.timeframe,
        item.side,
        item.resultLabel,
      ].some(value => String(value ?? '').toUpperCase().includes(q)))
  }, [items, filter, sampleQuery])

  const filteredTradeLogs = useMemo(() => {
    const q = logQuery.trim().toUpperCase()
    const min = Number(logMinScore)
    const scoreThreshold = Number.isFinite(min) ? min : 0
    return tradeLogs
      .filter(log => logFilter === 'all' || log.result === logFilter)
      .filter(log => (Number.isFinite(log.score) ? log.score : 0) >= scoreThreshold)
      .filter(log => !q || [
        signalIdOf(log),
        log.symbol,
        log.name,
        log.timeframe,
        log.side,
        log.setup,
        log.resultLabel,
      ].some(value => String(value ?? '').toUpperCase().includes(q)))
  }, [tradeLogs, logFilter, logQuery, logMinScore])

  const logSummary = useMemo(() => {
    const recent = filteredTradeLogs.slice(0, logWindow)
    const wins = recent.filter(log => log.result === 'win')
    const losses = recent.filter(log => log.result === 'loss')
    const winR = sumR(wins)
    const lossR = Math.abs(sumR(losses))
    const netR = sumR(recent)
    const adjusted = recent.map(log => log.executionAdjustedR).filter(Number.isFinite)
    const mfe = recent.map(log => log.mfeR).filter(Number.isFinite)
    const mae = recent.map(log => log.maeR).filter(Number.isFinite)
    const waits = recent.map(log => log.waitTimeMs).filter(Number.isFinite)
    const holds = recent.map(log => log.holdingTimeMs).filter(Number.isFinite)
    return {
      recent,
      wins,
      losses,
      winR,
      lossR,
      netR,
      adjustedR: adjusted.length ? adjusted.reduce((sum, value) => sum + value, 0) : null,
      avgMfeR: mfe.length ? mfe.reduce((sum, value) => sum + value, 0) / mfe.length : null,
      avgMaeR: mae.length ? mae.reduce((sum, value) => sum + value, 0) / mae.length : null,
      avgWaitMs: waits.length ? waits.reduce((sum, value) => sum + value, 0) / waits.length : null,
      avgHoldMs: holds.length ? holds.reduce((sum, value) => sum + value, 0) / holds.length : null,
      winRate: recent.length ? (wins.length / recent.length) * 100 : null,
    }
  }, [filteredTradeLogs, logWindow])

  const updateLogWindow = value => {
    const next = Math.min(200, Math.max(5, Number(value) || 20))
    setLogWindow(next)
    localStorage.setItem('rsi:signalReview:recentCount', String(next))
  }

  const openLogChart = log => {
    const asset = assets.find(item => item.source === log.source && (item.apiSymbol ?? item.symbol) === (log.apiSymbol ?? log.symbol))
      ?? assets.find(item => item.symbol === log.symbol)
    if (asset) setChartSelection({ asset, item: log })
  }

  const logBreakdown = useMemo(() => {
    const recent = logSummary.recent
    const setupGroups = groupTradeLogs(recent, row => row.setup, row => row.setup || 'Signal Hunter')
    const timeframeGroups = groupTradeLogs(recent, row => row.timeframe, row => row.timeframe || '-')
    const sideGroups = groupTradeLogs(recent, row => row.side, row => sideLabel(row.side))
    const regimeGroups = groupTradeLogs(recent, row => row.marketRegime, row => row.marketRegime || '未知状态')
    return {
      setupGroups,
      timeframeGroups,
      sideGroups,
      regimeGroups,
      worstSetups: setupGroups.slice().sort((a, b) => (a.netR ?? 0) - (b.netR ?? 0)).slice(0, 3),
      bestSetups: setupGroups.slice(0, 3),
    }
  }, [logSummary.recent])
  const signalCalibration = useMemo(() => buildSignalCalibration(tradeLogs), [tradeLogs])

  const stats = useMemo(() => {
    const entered = items.filter(item => item.enteredAt)
    const closed = items.filter(item => item.result === 'win' || item.result === 'loss')
    const avgReturn = entered.length
      ? entered.reduce((sum, item) => sum + (item.currentReturnPct ?? 0), 0) / entered.length
      : null
    const avgMax = entered.length
      ? entered.reduce((sum, item) => sum + (item.maxReturnPct ?? 0), 0) / entered.length
      : null
    const avgDrawdown = entered.length
      ? entered.reduce((sum, item) => sum + (item.minReturnPct ?? 0), 0) / entered.length
      : null
    return {
      total: items.length,
      entered: entered.length,
      win: items.filter(item => item.result === 'win').length,
      loss: items.filter(item => item.result === 'loss').length,
      notEntered: items.filter(item => item.result === 'not_entered').length,
      ambiguous: items.filter(item => item.result === 'ambiguous').length,
      winRate: closed.length ? (items.filter(item => item.result === 'win').length / closed.length) * 100 : null,
      avgReturn,
      avgMax,
      avgDrawdown,
    }
  }, [items])

  return (
    <div className={`signal-review-page ${view === 'logs' ? 'signal-review-page-logs' : ''} ${overviewCollapsed ? 'signal-review-overview-collapsed' : ''}`}>
      <div className="signal-review-head">
        <div>
          <span className="signal-review-kicker">{report.periodLabel} PERFORMANCE REVIEW</span>
          <h2>SH复盘 <em>让结果反过来校准信号</em></h2>
          <p>先看过去 24 小时有没有兑现，再下钻到样本与交易日志。</p>
        </div>
        <div className="signal-review-summary">
          <div><b>{stats.total}</b><span>样本</span></div>
          <div><b>{stats.entered}</b><span>已入场</span></div>
          <div><b>{stats.winRate == null ? '-' : `${stats.winRate.toFixed(0)}%`}</b><span>胜率</span></div>
          <div><b>{fmtPct(stats.avgReturn)}</b><span>平均当前</span></div>
          <div><b>{fmtPct(stats.avgMax)}</b><span>平均最大浮盈</span></div>
          <div><b>{fmtPct(stats.avgDrawdown)}</b><span>平均回撤</span></div>
        </div>
      </div>

      <div className="signal-review-tabs">
        <button className={`feed-type-btn ${view === 'samples' ? 'active' : ''}`} onClick={() => setView('samples')}>
          复盘样本 {items.length}
        </button>
        <button className={`feed-type-btn ${view === 'logs' ? 'active' : ''}`} onClick={() => setView('logs')}>
          交易日志 {tradeLogs.length}
        </button>
        <button className={`feed-type-btn ${view === 'report' ? 'active' : ''}`} onClick={() => setView('report')}>
          战绩报告 {report.total}
        </button>
        <button className="feed-type-btn" disabled={replayBusy || !assets.length} onClick={runReplay}>
          {replayBusy ? '逐根回放中' : '运行近期回放'}
        </button>
        <button className="feed-type-btn" onClick={() => setOverviewCollapsed(value => {
          localStorage.setItem('rsi:signalReview:overviewCollapsed', value ? '0' : '1')
          return !value
        })}>{overviewCollapsed ? '展开概览' : '折叠概览'}</button>
        {view === 'report' && <div className="signal-review-periods" aria-label="复盘周期">
          {REPORT_PERIODS.map(period => (
            <button
              key={period.key}
              className={`feed-type-btn ${reportPeriod === period.key ? 'active' : ''}`}
              onClick={() => setReportPeriod(period.key)}
            >
              {period.label}
            </button>
          ))}
        </div>}
        <label className="signal-review-score-control">
          <span>入库分数 ≥</span>
          <input
            type="number"
            min="0"
            max="10"
            step="0.1"
            value={minScore}
            onChange={e => setMinScore(e.target.value)}
          />
        </label>
        <label className="signal-review-score-control signal-review-buffer-control">
          <span>确认缓冲 %</span>
          <input
            type="number"
            min="0"
            max="1"
            step="0.05"
            value={Number((entryConfirmBufferPct * 100).toFixed(2))}
            onChange={e => setEntryConfirmBufferPct(Number(e.target.value) / 100)}
          />
        </label>
        {confirmClearAll ? (
          <div className="signal-review-clear-confirm">
            <span>确认清空全部样本和日志？</span>
            <button className="rule-del-btn" onClick={handleClearAll}>确认清空</button>
            <button className="feed-type-btn" onClick={() => setConfirmClearAll(false)}>取消</button>
          </div>
        ) : (
          <button className="feed-type-btn" disabled={!items.length && !tradeLogs.length} onClick={() => setConfirmClearAll(true)}>清空全部</button>
        )}
      </div>

      {!!crossMarketStats.length && <section className="signal-review-cross-market">
        <b>跨市场效果</b>
        {crossMarketStats.map(group => <div key={group.key}>
          <span>{({ confirmed: '同向确认', diverged: '方向背离', single: '单边信号', none: '无配对' })[group.key]}</span>
          <strong>{group.count} 单</strong>
          <em>胜率 {group.winRate == null ? '-' : `${group.winRate.toFixed(1)}%`}</em>
          <em>平均 {group.avgR == null ? '-' : `${group.avgR >= 0 ? '+' : ''}${group.avgR.toFixed(2)}R`}</em>
          <small>{group.confidence?.sufficient ? `95%区间 ${group.confidence.low.toFixed(0)}–${group.confidence.high.toFixed(0)}%` : `样本不足 ${group.count}/30 · 暂不可校准`}</small>
        </div>)}
      </section>}

      {cleanNotice && (
        <div className="signal-review-clean-notice">
          <span>{cleanNotice}</span>
          <button type="button" onClick={clearCleanNotice}>知道了</button>
        </div>
      )}

      {(replayReport || replayError) && (
        <div className="signal-review-filter-stats">
          <strong>逐根回放</strong>
          {replayError ? <em>{replayError}</em> : <>
            <span>{replayReport.assets} 个标的</span>
            <span>{replayReport.totalSignals} 个计划</span>
            <span>胜 {replayReport.wins}</span>
            <span>负 {replayReport.losses}</span>
            <span>歧义 {replayReport.ambiguous}</span>
            <span>过期 {replayReport.expired}</span>
            <span>胜率 {replayReport.winRate == null ? '-' : `${(replayReport.winRate * 100).toFixed(1)}%`}</span>
            <span>净值 {fmtR(replayReport.netR)}</span>
            {replayReport.profileGroups?.map(group => (
              <em key={group.key}>{group.key} · {group.signals}单 · {group.winRate == null ? '-' : `${(group.winRate * 100).toFixed(0)}%`} · {fmtR(group.netR)}</em>
            ))}
            {replayReport.limitations?.map(item => <em key={item}>限制 · {item}</em>)}
          </>}
        </div>
      )}
      {!replayReport && replayHistory[0] && (
        <div className="signal-review-filter-stats">
          <strong>最近保存回放</strong>
          <span>{new Date(replayHistory[0].createdAt).toLocaleString('zh-CN')}</span>
          <span>{replayHistory[0].totalSignals} 个计划</span>
          <span>胜率 {replayHistory[0].winRate == null ? '-' : `${(replayHistory[0].winRate * 100).toFixed(1)}%`}</span>
          <span>净值 {fmtR(replayHistory[0].netR)}</span>
          <em>历史记录 {replayHistory.length}/90</em>
        </div>
      )}

      {view === 'samples' && captureRejectStats && (
        <div className="signal-review-filter-stats">
          <strong>上轮过滤</strong>
          <span>扫描 {captureRejectStats.total}</span>
          <span>新增 {captureRejectStats.captured}</span>
          {captureRejectRows.length ? captureRejectRows.map(([reason, count]) => (
            <em key={reason}>{reason} {count}</em>
          )) : <em>暂无过滤</em>}
        </div>
      )}

      {view === 'samples' && pendingQualification.length > 0 && (
        <details className="signal-review-qualification">
          <summary>尚未进入复盘的信号 <b>{pendingQualification.length}</b></summary>
          <div className="signal-review-qualification-list">
            {pendingQualification.map(item => (
              <div key={item.key}>
                <strong>{item.symbol}</strong>
                <span>{item.reason}</span>
                <em>{item.next}</em>
                <small>{item.updatedAt ? `最近检查 ${fmtTime(item.updatedAt)}` : '等待首次生命周期检查'}</small>
              </div>
            ))}
          </div>
        </details>
      )}

      {view === 'report' ? (
        <div className="signal-review-report">
          <div className="signal-review-report-head">
            <div>
              <h3>过去{report.periodLabel} SH复盘数据</h3>
              <span>{new Date().toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })}</span>
            </div>
            <button className="feed-type-btn" onClick={copyReport} disabled={!report.total}>复制摘要</button>
          </div>

          <div className="signal-review-report-metrics">
            <div><span>总信号数</span><b>{report.total}</b></div>
            <div><span>有效突破率</span><b>{fmtRate(report.wins.length, report.total)}</b></div>
            <div><span>TP1命中率</span><b>{fmtRate(report.tp1, report.total)}</b></div>
            <div><span>TP2命中率</span><b>{fmtRate(report.tp2, report.total)}</b></div>
            <div><span>TP3命中率</span><b>{fmtRate(report.tp3, report.total)}</b></div>
            <div><span>止损率</span><b>{fmtRate(report.losses.length, report.total)}</b></div>
            <div><span>仅触发</span><b>{fmtRate(report.open.length, report.total)}</b></div>
            <div><span>盈利平均最大涨幅</span><b>{fmtPct(report.avgMaxMove)}</b></div>
          </div>

          <div className="signal-review-report-grid">
            <section>
              <div className="signal-review-report-title">TOP 明星</div>
              <div className="signal-review-rank-list">
                {report.stars.length ? report.stars.slice(0, 5).map((row, index) => (
                  <div key={`${row.key}-${index}`} className="signal-review-rank-row">
                    <b>#{index + 1}</b>
                    <strong>{row.symbol}<small>{signalIdOf(row)}</small></strong>
                    <span>{statusLabel(row)}</span>
                    <em>{fmtPct(rowMaxMove(row))}</em>
                  </div>
                )) : <div className="signal-review-empty compact">暂无{report.periodLabel}明星信号</div>}
              </div>
            </section>

            <section>
              <div className="signal-review-report-title">止损信号</div>
              <div className="signal-review-stop-list">
                {report.losses.length ? report.losses.slice(0, 8).map(row => (
                  <div key={row.key} className="signal-review-stop-row">
                    <strong>{row.symbol}<small>{signalIdOf(row)}</small></strong>
                    <span>{row.score ?? '-'}/10</span>
                    <em>{(row.risks ?? [])[0] || '无额外风险标记'}</em>
                  </div>
                )) : <div className="signal-review-empty compact">过去{report.periodLabel}暂无止损</div>}
              </div>
            </section>
          </div>

          <div className="signal-review-report-table">
            <div className="signal-review-report-title">完整榜单</div>
            <div className="signal-review-report-table-head">
              <span>时间</span><span>标的</span><span>触发价</span><span>状态</span><span>最大涨幅</span>
            </div>
            <div className="signal-review-report-table-body">
              {report.rows.length ? report.rows.map(row => (
                <div key={row.key} className={`signal-review-report-row ${row.result}`}>
                  <span>{fmtTime(row.enteredAt || row.capturedAt)}</span>
                  <strong>{row.symbol}<small>{signalIdOf(row)}</small></strong>
                  <span>{formatPrice(row.entryPrice)}</span>
                  <span>{statusLabel(row)}</span>
                  <em>{fmtPct(rowMaxMove(row))}</em>
                </div>
              )) : <div className="signal-review-empty compact">暂无过去{report.periodLabel}复盘数据</div>}
            </div>
          </div>

          <div className="signal-review-highlights">
            <div className="signal-review-report-title">亮点</div>
            {report.highlights.length ? report.highlights.map(item => <p key={item}>{item}</p>) : <p>暂无足够样本生成亮点。</p>}
          </div>
        </div>
      ) : view === 'samples' ? (
        <>
      <div className="signal-review-toolbar">
        {[
          ['all', '全部'],
          ['entered', '已入场'],
          ['win', '成功'],
          ['loss', '止损'],
          ['ambiguous', '顺序不明'],
          ['not_entered', '未触发'],
          ['tracking', '跟踪中'],
        ].map(([key, label]) => (
          <button key={key} className={`feed-type-btn ${filter === key ? 'active' : ''}`} onClick={() => setFilter(key)}>
            {label}
          </button>
        ))}
        <input
          className="search-input signal-review-sample-search"
          type="search"
          placeholder="搜索名称 / 标的 / 编号 / 形态..."
          value={sampleQuery}
          onChange={e => setSampleQuery(e.target.value)}
        />
        {sampleQuery && <button className="feed-type-btn" onClick={() => setSampleQuery('')}>清除</button>}
        {confirmClear ? (
          <div className="signal-review-clear-confirm">
            <span>确认清空全部样本？</span>
            <button className="rule-del-btn" onClick={handleClear}>确认清空</button>
            <button className="feed-type-btn" onClick={() => setConfirmClear(false)}>取消</button>
          </div>
        ) : (
          <button className="feed-type-btn" disabled={!items.length} onClick={() => setConfirmClear(true)}>清空样本</button>
        )}
      </div>

      <div className="signal-review-list">
        {!filtered.length ? (
          <div className="signal-review-empty">
            暂无复盘样本。等待 SH 页面出现评分 ≥ {minScore}、未被剔除且具备入场价/止损价的信号后，这里会自动开始记录。
          </div>
        ) : filtered.map(item => (
          (() => {
            const targets = targetsOf(item)
            return (
          <article key={item.id} className={`signal-review-card ${resultTone(item.result)}`}>
            <div className="signal-review-card-main">
              <div className="signal-review-title">
                <button type="button" className="signal-review-card-symbol" onClick={() => openLogChart(item)} title="查看K线">{item.symbol}</button>
                <code className="signal-id-badge">{signalIdOf(item)}</code>
                <span>{sideLabel(item.side)}</span>
                <span>{item.timeframe}</span>
                <span>{item.score}/10</span>
                <em>{item.resultLabel}</em>
              </div>
              <p>{displaySetup(item.setup)}</p>
              <small>记录 {fmtTime(item.capturedAt)} · 最近更新 {fmtTime(item.lastUpdatedAt)}</small>
            </div>
            <div className="signal-review-price-grid">
              <span><b>{formatPrice(item.capturedPrice)}</b><small>记录价</small></span>
              <span><b>{formatPrice(item.entryPrice)}</b><small>入场</small></span>
              <span><b>{formatPrice(item.entryObservedPrice)}</b><small>观测价</small></span>
              <span><b>{item.entryTriggerLabel ?? '-'}</b><small>触发方式</small></span>
              <span><b>{formatPrice(item.stopLoss)}</b><small>止损</small></span>
              <span><b>{formatPrice(targets[0])}</b><small>止盈 T1</small></span>
              <span><b>{formatPrice(targets[1])}</b><small>止盈 T2</small></span>
              <span><b>{formatPrice(targets[2])}</b><small>止盈 T3</small></span>
              <span><b>{formatPrice(item.lastPrice)}</b><small>现价</small></span>
            </div>
            <div className="signal-review-result-grid">
              <span><b>{fmtPct(item.currentReturnPct)}</b><small>当前</small></span>
              <span><b>{fmtPct(item.maxReturnPct)}</b><small>最大浮盈</small></span>
              <span><b>{fmtPct(item.minReturnPct)}</b><small>最大回撤</small></span>
              <span><b>{horizonText(item, '1h')}</b><small>1h</small></span>
              <span><b>{horizonText(item, '4h')}</b><small>4h</small></span>
              <span><b>{horizonText(item, '24h')}</b><small>24h</small></span>
            </div>
            <div className="signal-review-tags">
              {item.entryDiagnostic && <span className={item.enteredAt ? '' : 'risk'}>{item.entryDiagnostic}</span>}
              {(item.reasons ?? []).slice(0, 4).map(reason => <span key={reason}>{reason}</span>)}
              {(item.risks ?? []).slice(0, 2).map(risk => <span className="risk" key={risk}>{risk}</span>)}
              <button onClick={() => openInSignalHunter(item)}>去SH定位</button>
              <button onClick={() => remove(item.id)}>删除</button>
            </div>
          </article>
            )
          })()
        ))}
      </div>
        </>
      ) : (
        <div className="signal-review-log-page">
          <div className="signal-review-log-toolbar">
            <div className="signal-review-log-filters">
              {[
                ['all', '全部'],
                ['win', '止盈'],
                ['loss', '止损'],
              ].map(([key, label]) => (
                <button key={key} className={`feed-type-btn ${logFilter === key ? 'active' : ''}`} onClick={() => setLogFilter(key)}>
                  {label}
                </button>
              ))}
              <input
                className="search-input signal-review-log-search"
                type="search"
                placeholder="搜索名称 / 标的 / 编号 / 周期 / 形态..."
                value={logQuery}
                onChange={e => setLogQuery(e.target.value)}
              />
              {logQuery && <button className="feed-type-btn" onClick={() => setLogQuery('')}>清除</button>}
              <label className="signal-review-score-control signal-review-log-score-control">
                <span>分数 ≥</span>
                <input
                  type="number"
                  min="0"
                  max="10"
                  step="0.1"
                  value={logMinScore}
                  onChange={e => setLogMinScore(e.target.value)}
                />
              </label>
            </div>
            <div className="signal-review-log-actions">
              <span>当前 {filteredTradeLogs.length} / 全部 {tradeLogs.length}</span>
              {!confirmClearLogs ? (
                <button className="rule-del-btn" disabled={!tradeLogs.length} onClick={() => setConfirmClearLogs(true)}>清空日志</button>
              ) : (
                <>
                  <span>确认清空交易日志？</span>
                  <button className="rule-del-btn" onClick={handleClearLogs}>确认</button>
                  <button className="feed-type-btn" onClick={() => setConfirmClearLogs(false)}>取消</button>
                </>
              )}
            </div>
          </div>
          <div className="signal-review-log-summary">
            <div className="signal-review-recent-count"><span>最近</span><label><input type="number" min="5" max="200" step="5" value={logWindow} onChange={event => updateLogWindow(event.target.value)} />单</label><b>{logSummary.recent.length}</b></div>
            <div><span>成功</span><b>{logSummary.wins.length} 单 / {fmtR(logSummary.winR)}</b></div>
            <div><span>失败</span><b>{logSummary.losses.length} 单 / {fmtR(-logSummary.lossR)}</b></div>
            <div><span>净收益</span><b>{fmtR(logSummary.netR)}</b></div>
            <div><span>扣滑点</span><b>{fmtR(logSummary.adjustedR)}</b></div>
            <div><span>平均 MFE / MAE</span><b>{fmtR(logSummary.avgMfeR)} / {fmtR(logSummary.avgMaeR)}</b></div>
            <div><span>等待 / 持有</span><b>{fmtDuration(logSummary.avgWaitMs)} / {fmtDuration(logSummary.avgHoldMs)}</b></div>
            <div><span>胜率</span><b>{logSummary.winRate == null ? '-' : `${logSummary.winRate.toFixed(1)}%`}</b></div>
            <button
              type="button"
              className="feed-type-btn signal-review-breakdown-toggle"
              aria-expanded={showLogBreakdown}
              onClick={() => setShowLogBreakdown(value => !value)}
            >
              {showLogBreakdown ? '收起拆解' : '查看拆解'}
            </button>
          </div>
          {showLogBreakdown && <div className="signal-review-log-breakdown">
            <section>
              <div className="signal-review-report-title">按 setup 拆解</div>
              {logBreakdown.setupGroups.length ? logBreakdown.setupGroups.slice(0, 6).map(group => (
                <div key={group.key} className="signal-review-breakdown-row">
                  <strong>{group.label}</strong>
                  <span>{groupCountLabel(group)}</span>
                </div>
              )) : <div className="signal-review-empty compact">暂无可拆解的 setup</div>}
            </section>
            <section>
              <div className="signal-review-report-title">按周期拆解</div>
              {logBreakdown.timeframeGroups.length ? logBreakdown.timeframeGroups.slice(0, 6).map(group => (
                <div key={group.key} className="signal-review-breakdown-row">
                  <strong>{group.label}</strong>
                  <span>{groupCountLabel(group)}</span>
                </div>
              )) : <div className="signal-review-empty compact">暂无可拆解的周期</div>}
            </section>
            <section>
              <div className="signal-review-report-title">按方向拆解</div>
              {logBreakdown.sideGroups.length ? logBreakdown.sideGroups.map(group => (
                <div key={group.key} className="signal-review-breakdown-row">
                  <strong>{group.label}</strong>
                  <span>{groupCountLabel(group)}</span>
                </div>
              )) : <div className="signal-review-empty compact">暂无可拆解的方向</div>}
            </section>
            <section>
              <div className="signal-review-report-title">自动校准 · 90天</div>
              {signalCalibration.entries.length ? signalCalibration.entries.slice(0, 6).map(group => (
                <div key={group.key} className="signal-review-breakdown-row">
                  <strong>{group.timeframe} {sideLabel(group.side)} · {calibrationModeLabel(group.entryMode)}</strong>
                  <span>{group.active
                    ? `${group.delta >= 0 ? '+' : ''}${group.delta.toFixed(2)}分 · T${group.trainingSamples}/V${group.validationSamples}`
                    : `${group.samples}/${signalCalibration.minSamples}单 · 验证未通过`}</span>
                </div>
              )) : <div className="signal-review-empty compact">暂无已完成交易样本</div>}
            </section>
            <section>
              <div className="signal-review-report-title">按市场状态拆解</div>
              {logBreakdown.regimeGroups.length ? logBreakdown.regimeGroups.slice(0, 6).map(group => (
                <div key={group.key} className="signal-review-breakdown-row"><strong>{group.label}</strong><span>{groupCountLabel(group)}</span></div>
              )) : <div className="signal-review-empty compact">暂无市场状态样本</div>}
            </section>
          </div>}
          {!filteredTradeLogs.length ? (
            <div className="signal-review-empty">
              暂无交易日志。SH复盘样本触及 ≥1.5R 止盈或止损后，会自动写入这里。
            </div>
          ) : (
            <div className="signal-review-log-list">
              <div className="signal-review-log-head" aria-hidden="true">
                <span>#</span>
                <span>标的</span>
                <span>方向 / 周期</span>
                <span>形态</span>
                <span>触发</span>
                <span>结果</span>
                <span>入场时间</span>
                <span>出场时间</span>
                <span title="计划价是信号生成时的目标入场价；实际入场价是闭合K线确认触发时观测到的成交参考价。">计划价 / 实际入场价</span>
                <span>离场</span>
                <span>涨跌</span>
                <span>R</span>
                <span>净R / MFE / MAE</span>
              </div>
              {filteredTradeLogs.map((log, index) => (
                <div key={log.id} className={`signal-review-log-row ${log.result}`}>
                  <span className="signal-review-log-index">{index + 1}</span>
                  <button type="button" className="signal-review-log-symbol" onClick={() => openLogChart(log)} title="查看该笔交易对应的K线"><strong>{log.symbol}</strong><small>{log.name ? `${log.name} · ${signalIdOf(log)}` : signalIdOf(log)}</small></button>
                  <span>{sideLabel(log.side)} · {log.timeframe}</span>
                  <span>{displaySetup(log.setup)}</span>
                  <span>{log.entryTriggerLabel ?? '-'}</span>
                  <span>{log.result === 'win' ? `止盈${log.hitTarget ? ` T${log.hitTarget}` : ''}` : '止损'}</span>
                  <small>{fmtTime(log.entryTime ?? log.enteredAt)}</small>
                  <small>{fmtTime(log.exitTime ?? log.closedAt)}</small>
                  <span title="计划价 / 实际入场价">{formatPrice(log.entryPrice)} / {formatPrice(log.entryObservedPrice)}</span>
                  <span>{formatPrice(log.exitPrice)}</span>
                  <span className="signal-review-log-return">{fmtPct(log.returnPct)}</span>
                  <span className="signal-review-log-r">{fmtR(log.rMultiple)}</span>
                  <small>净 {fmtR(log.executionAdjustedR)} · MFE {fmtR(log.mfeR)} / MAE {fmtR(log.maeR)}</small>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
      {chartSelection && <Suspense fallback={null}><ChartModal asset={chartSelection.asset} alertItem={chartSelection.item} onClose={() => setChartSelection(null)} /></Suspense>}
    </div>
  )
}
