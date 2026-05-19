import { useMemo, useState } from 'react'
import useMarketStore from '../store/marketStore'
import useAlertStore from '../store/alertStore'
import useSettingsStore from '../store/settingsStore'
import { formatTurnover } from '../utils/liquidity'
import {
  AI_DECISION_LABELS as DECISION_LABELS,
  AI_TFS as TFS,
  buildCandidates,
  makeAiFeedItems,
  normalizeDecision,
} from '../utils/aiCandidates'

const DECISION_CLASSES = {
  focus: 'ai-decision-focus',
  watch: 'ai-decision-watch',
  ignore: 'ai-decision-ignore',
  risk: 'ai-decision-risk',
}

function fmtPrice(v) {
  if (v == null || Number.isNaN(v)) return '-'
  if (v >= 1000) return v.toLocaleString('en-US', { maximumFractionDigits: 2 })
  if (v >= 1) return Number(v).toFixed(4)
  return Number(v).toPrecision(4)
}

function fmtPct(v) {
  if (v == null || Number.isNaN(v)) return '-'
  return `${v >= 0 ? '+' : ''}${Number(v).toFixed(2)}%`
}

function fmtLastRun(ts) {
  if (!ts) return '尚未运行'
  return new Date(ts).toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  })
}

export default function AiPage() {
  const assets = useMarketStore(s => s.assets)
  const updatedAt = useMarketStore(s => s.updatedAt)
  const addFeedItems = useAlertStore(s => s.addFeedItems)
  const aiLastRunAt = useSettingsStore(s => s.aiLastRunAt)
  const aiLastRunMode = useSettingsStore(s => s.aiLastRunMode)
  const aiLastRunCount = useSettingsStore(s => s.aiLastRunCount)
  const aiLastSnapshot = useSettingsStore(s => s.aiLastSnapshot)
  const updateSetting = useSettingsStore(s => s.update)
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState('')
  const [result, setResult] = useState(null)
  const [localSnapshot, setLocalSnapshot] = useState(null)
  const [paths, setPaths] = useState({})
  const [decisionFilter, setDecisionFilter] = useState('all')
  const [rowBusy, setRowBusy] = useState('')
  const [viewMode, setViewMode] = useState(aiLastSnapshot ? 'result' : 'current')

  const candidates = useMemo(() => buildCandidates(assets), [assets])
  const activeSnapshot = localSnapshot ?? aiLastSnapshot
  const snapshotCandidates = activeSnapshot?.candidates ?? []
  const hasSnapshot = snapshotCandidates.length > 0
  const showingResult = viewMode === 'result' && hasSnapshot
  const tableCandidates = showingResult ? snapshotCandidates : candidates
  const decisionMap = useMemo(() => {
    const map = new Map()
    for (const item of activeSnapshot?.result?.items ?? []) {
      map.set(String(item.symbol).toUpperCase(), item)
    }
    return map
  }, [activeSnapshot])

  const visible = useMemo(() => {
    if (decisionFilter === 'all') return tableCandidates
    return tableCandidates.filter(c => normalizeDecision(decisionMap.get(c.symbol)?.decision) === decisionFilter)
  }, [tableCandidates, decisionFilter, decisionMap])

  const runScreen = async () => {
    if (!candidates.length || busy) return
    const runCandidates = candidates
    const runStartedAt = Date.now()
    setLocalSnapshot({
      ts: runStartedAt,
      mode: 'manual',
      candidates: runCandidates,
      result: null,
      summary: '筛选中...',
    })
    setResult(null)
    setBusy(true)
    setStatus('正在运行 Codex 筛选...')
    setViewMode('result')
    setPaths({})
    try {
      const payload = {
        scope: 'market',
        createdAt: new Date(runStartedAt).toISOString(),
        updatedAt: updatedAt ? new Date(updatedAt).toISOString() : null,
        note: 'AI 只做筛选和提醒，不给交易指令。',
        candidates: runCandidates,
      }
      const res = await window.api.runCodexScreen(payload)
      setPaths({ screenDir: res.screenDir, reportPath: res.reportPath, resultPath: res.resultPath })
      if (res.ok && res.result) {
        setResult(res.result)
        const snapshot = {
          ts: Date.now(),
          mode: 'manual',
          candidates: runCandidates,
          result: res.result,
          summary: res.result.summary ?? '',
        }
        setLocalSnapshot(snapshot)
        setViewMode('result')
        updateSetting('aiLastRunAt', snapshot.ts)
        updateSetting('aiLastRunMode', 'manual')
        updateSetting('aiLastRunCount', res.result.items?.length ?? 0)
        updateSetting('aiLastSnapshot', snapshot)
        setStatus(`筛选完成：${res.result.summary ?? res.screenName}`)
      } else {
        setStatus(`筛选失败：${res.parseError || res.stderr || res.stdout || '请检查 Codex 登录状态'}`)
      }
    } catch (err) {
      setStatus(`筛选失败：${err.message}`)
    } finally {
      setBusy(false)
    }
  }

  const mergeRowResult = (candidate, aiItem, res) => {
    const base = activeSnapshot ?? {
      ts: Date.now(),
      mode: 'single',
      candidates: tableCandidates.length ? tableCandidates : [candidate],
      result: { summary: '', items: [] },
      summary: '',
    }
    const candidatesNext = base.candidates.some(c => c.symbol === candidate.symbol)
      ? base.candidates
      : [candidate, ...base.candidates]
    const items = (base.result?.items ?? []).filter(i => String(i.symbol).toUpperCase() !== candidate.symbol.toUpperCase())
    const snapshot = {
      ...base,
      ts: Date.now(),
      mode: 'single',
      candidates: candidatesNext,
      result: {
        ...(base.result ?? {}),
        summary: res.result?.summary ?? base.result?.summary ?? '',
        items: [aiItem, ...items],
      },
      summary: res.result?.summary ?? base.summary ?? '',
    }
    setLocalSnapshot(snapshot)
    setResult(snapshot.result)
    updateSetting('aiLastRunAt', snapshot.ts)
    updateSetting('aiLastRunMode', 'single')
    updateSetting('aiLastRunCount', snapshot.result.items.length)
    updateSetting('aiLastSnapshot', snapshot)
  }

  const runSingle = async (candidate) => {
    if (busy || rowBusy) return
    setRowBusy(candidate.symbol)
    setStatus(`正在单独筛选 ${candidate.symbol}...`)
    try {
      const payload = {
        scope: `single-${candidate.symbol}`,
        createdAt: new Date().toISOString(),
        updatedAt: updatedAt ? new Date(updatedAt).toISOString() : null,
        note: '单品种 AI 筛选：只做噪音过滤和提醒归类，不给交易指令。',
        candidates: [candidate],
      }
      const res = await window.api.runCodexScreen(payload)
      setPaths({ screenDir: res.screenDir, reportPath: res.reportPath, resultPath: res.resultPath })
      const aiItem = res.result?.items?.[0]
      if (res.ok && aiItem) {
        mergeRowResult(candidate, aiItem, res)
        setViewMode('result')
        setStatus(`${candidate.symbol} 筛选完成：${res.result.summary ?? aiItem.reason ?? ''}`)
      } else {
        setStatus(`${candidate.symbol} 筛选失败：${res.parseError || res.stderr || res.stdout || '请检查 Codex 登录状态'}`)
      }
    } catch (err) {
      setStatus(`${candidate.symbol} 筛选失败：${err.message}`)
    } finally {
      setRowBusy('')
    }
  }

  const writeFocusAlerts = () => {
    const now = Date.now()
    const items = makeAiFeedItems(tableCandidates, activeSnapshot?.result?.items, now)
    if (!items.length) {
      setStatus('没有可写入提醒记录的重点候选。')
      return
    }
    addFeedItems(items)
    setStatus(`已写入 ${items.length} 条 AI 筛选提醒。`)
  }

  return (
    <div className="ai-page">
      <div className="ai-header">
        <div>
          <h2>AI 候选池</h2>
          <p>本地规则先筛出候选，Codex 只做二次过滤和提醒归类。</p>
          <p className="ai-last-run">
            上次运行：{fmtLastRun(aiLastRunAt)}
            {aiLastRunMode && ` · ${aiLastRunMode === 'auto' ? '自动' : '手动'}`}
            {aiLastRunAt && ` · ${aiLastRunCount} 条结果`}
            {snapshotCandidates.length > 0 && ` · 快照 ${snapshotCandidates.length} 个候选`}
          </p>
        </div>
        <div className="ai-actions">
          <button className="zone-btn" onClick={runScreen} disabled={busy || !candidates.length}>
            {busy ? '筛选中...' : '运行 Codex 筛选'}
          </button>
          <button className="zone-btn" onClick={writeFocusAlerts} disabled={!activeSnapshot?.result?.items?.length}>
            写入重点提醒
          </button>
          {paths.reportPath && (
            <button className="zone-btn" onClick={() => window.api.openPath(paths.reportPath)}>
              打开报告
            </button>
          )}
          {paths.screenDir && (
            <button className="zone-btn" onClick={() => window.api.openPath(paths.screenDir)}>
              打开目录
            </button>
          )}
        </div>
      </div>

      <div className="ai-filter-row">
        <div className="feed-type-btns">
          <button
            className={`feed-type-btn ${viewMode === 'result' ? 'active' : ''}`}
            disabled={!hasSnapshot}
            onClick={() => setViewMode('result')}
          >
            AI结果
          </button>
          <button
            className={`feed-type-btn ${viewMode === 'current' ? 'active' : ''}`}
            onClick={() => setViewMode('current')}
          >
            当前候选
          </button>
        </div>
        {showingResult && ['all', 'focus', 'watch', 'risk', 'ignore'].map(key => (
          <button
            key={key}
            className={`feed-type-btn ${decisionFilter === key ? 'active' : ''}`}
            onClick={() => setDecisionFilter(key)}
          >
            {key === 'all' ? '全部' : DECISION_LABELS[key]}
          </button>
        ))}
        <span>
          当前 {candidates.length} 个候选
          {showingResult
            ? ` · 正在显示 AI 结果快照 ${snapshotCandidates.length} 个`
            : ' · 正在显示实时候选池'}
        </span>
      </div>

      {status && <div className="settings-note ai-status">{status}</div>}

      <div className="ai-table-wrap">
        <table className="stats-table ai-table">
          <thead>
            <tr>
              <th>品种</th>
              <th>价格</th>
              <th>24H</th>
              {TFS.map(tf => <th key={tf}>RSI {tf.toUpperCase()}</th>)}
              <th>量能</th>
              <th>本地原因</th>
              <th>操作</th>
              {showingResult && <th>AI</th>}
              {showingResult && <th>原因 / 风险 / 下一步</th>}
            </tr>
          </thead>
          <tbody>
            {visible.length === 0 ? (
              <tr>
                <td colSpan={showingResult ? 12 : 10} className="ai-empty">
                  {showingResult ? '暂无 AI 结果。先运行一次 Codex 筛选。' : '暂无候选。市场越平静，这里越空是正常的。'}
                </td>
              </tr>
            ) : visible.map(c => {
              const ai = decisionMap.get(c.symbol)
              const decision = normalizeDecision(ai?.decision)
              return (
                <tr key={c.symbol}>
                  <td><b>{c.symbol}</b></td>
                  <td>{fmtPrice(c.price)}</td>
                  <td className={(c.change24h ?? 0) >= 0 ? 'pos' : 'neg'}>{fmtPct(c.change24h)}</td>
                  {TFS.map(tf => (
                    <td key={tf}>{c.rsi[tf] == null ? '-' : Number(c.rsi[tf]).toFixed(1)}</td>
                  ))}
                  <td>{c.turnover ? formatTurnover(c.turnover) : '-'}</td>
                  <td>{c.localReasons.join('，') || '-'}</td>
                  <td>
                    <button
                      className="ai-row-btn"
                      disabled={busy || !!rowBusy}
                      onClick={() => runSingle(c)}
                    >
                      {rowBusy === c.symbol ? '筛选中' : '筛选'}
                    </button>
                  </td>
                  {showingResult && (
                    <td>
                      {ai ? (
                        <span className={`ai-decision ${DECISION_CLASSES[decision]}`}>
                          {DECISION_LABELS[decision]} {Number(ai.confidence) || 0}
                        </span>
                      ) : (
                        <span className="ai-decision ai-decision-pending">待筛选</span>
                      )}
                    </td>
                  )}
                  {showingResult && (
                    <td className="ai-reason">
                      {ai ? (
                        <>
                          <b>{ai.reason}</b>
                          <span>{ai.risk}</span>
                          <span>{ai.next_check}</span>
                        </>
                      ) : '运行 Codex 后显示'}
                    </td>
                  )}
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}
