import { useMemo, useState } from 'react'
import useSignalReviewStore from '../store/signalReviewStore'
import { formatPrice } from '../utils/rsi'

const SH_FOCUS_KEY = 'rsi:signalHunter:focus'
const MIN_TAKE_PROFIT_R = 1.5

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

function sideLabel(side) {
  return side === 'short' ? '做空' : '做多'
}

function resultTone(result) {
  if (result === 'win') return 'win'
  if (result === 'loss') return 'loss'
  if (result === 'not_entered') return 'muted'
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

export default function SignalReviewPage({ onNavigate }) {
  const items = useSignalReviewStore(s => s.items)
  const tradeLogs = useSignalReviewStore(s => s.tradeLogs)
  const minScore = useSignalReviewStore(s => s.minScore)
  const remove = useSignalReviewStore(s => s.remove)
  const clear = useSignalReviewStore(s => s.clear)
  const clearTradeLogs = useSignalReviewStore(s => s.clearTradeLogs)
  const setMinScore = useSignalReviewStore(s => s.setMinScore)
  const [view, setView] = useState('samples')
  const [filter, setFilter] = useState('all')
  const [logFilter, setLogFilter] = useState('all')
  const [logQuery, setLogQuery] = useState('')
  const [confirmClear, setConfirmClear] = useState(false)
  const [confirmClearLogs, setConfirmClearLogs] = useState(false)

  const handleClear = () => {
    clear()
    setConfirmClear(false)
  }

  const handleClearLogs = () => {
    clearTradeLogs()
    setConfirmClearLogs(false)
  }

  const openInSignalHunter = (item) => {
    localStorage.setItem(SH_FOCUS_KEY, JSON.stringify({
      symbol: item.symbol,
      timeframe: item.timeframe,
      ts: Date.now(),
    }))
    onNavigate?.('signal-hunter')
  }

  const filtered = useMemo(() => {
    if (filter === 'all') return items
    if (filter === 'entered') return items.filter(item => item.enteredAt)
    return items.filter(item => item.result === filter)
  }, [items, filter])

  const filteredTradeLogs = useMemo(() => {
    const q = logQuery.trim().toUpperCase()
    return tradeLogs
      .filter(log => logFilter === 'all' || log.result === logFilter)
      .filter(log => !q || [
        log.symbol,
        log.timeframe,
        log.side,
        log.setup,
        log.resultLabel,
      ].some(value => String(value ?? '').toUpperCase().includes(q)))
  }, [tradeLogs, logFilter, logQuery])

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
      winRate: closed.length ? (items.filter(item => item.result === 'win').length / closed.length) * 100 : null,
      avgReturn,
      avgMax,
      avgDrawdown,
    }
  }, [items])

  return (
    <div className="signal-review-page">
      <div className="signal-review-head">
        <div>
          <h2>SH复盘</h2>
          <p>自动记录 Signal Hunter 高分信号；样本负责跟踪，交易日志负责归档止盈/止损结果。</p>
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
      </div>

      {view === 'samples' ? (
        <>
      <div className="signal-review-toolbar">
        {[
          ['all', '全部'],
          ['entered', '已入场'],
          ['win', '成功'],
          ['loss', '止损'],
          ['not_entered', '未触发'],
          ['tracking', '跟踪中'],
        ].map(([key, label]) => (
          <button key={key} className={`feed-type-btn ${filter === key ? 'active' : ''}`} onClick={() => setFilter(key)}>
            {label}
          </button>
        ))}
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
            暂无复盘样本。等待 SH 页面出现评分 ≥ {minScore}、且具备入场价/止损价的信号后，这里会自动开始记录。
          </div>
        ) : filtered.map(item => (
          (() => {
            const targets = targetsOf(item)
            return (
          <article key={item.id} className={`signal-review-card ${resultTone(item.result)}`}>
            <div className="signal-review-card-main">
              <div className="signal-review-title">
                <strong>{item.symbol}</strong>
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
                placeholder="搜索标的 / 周期 / 形态..."
                value={logQuery}
                onChange={e => setLogQuery(e.target.value)}
              />
              {logQuery && <button className="feed-type-btn" onClick={() => setLogQuery('')}>清除</button>}
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
          {!filteredTradeLogs.length ? (
            <div className="signal-review-empty">
              暂无交易日志。SH复盘样本触及 ≥1.5R 止盈或止损后，会自动写入这里。
            </div>
          ) : (
            <div className="signal-review-log-list">
              {filteredTradeLogs.map(log => (
                <div key={log.id} className={`signal-review-log-row ${log.result}`}>
                  <strong>{log.symbol}</strong>
                  <span>{sideLabel(log.side)} · {log.timeframe}</span>
                  <span>{displaySetup(log.setup)}</span>
                  <span>{log.result === 'win' ? `止盈${log.hitTarget ? ` T${log.hitTarget}` : ''}` : '止损'}</span>
                  <span>入场 {formatPrice(log.entryPrice)}</span>
                  <span>离场 {formatPrice(log.exitPrice)}</span>
                  <span>{fmtPct(log.returnPct)}</span>
                  <span>{fmtR(log.rMultiple)}</span>
                  <small>{fmtTime(log.closedAt)}</small>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
