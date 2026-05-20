import useSettingsStore from '../store/settingsStore'
import { AI_DECISION_LABELS, normalizeDecision } from '../utils/aiCandidates'

function fmtTime(ts) {
  if (!ts) return '尚未运行'
  return new Date(ts).toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  })
}

function countBy(items, getKey) {
  const out = {}
  for (const item of items) {
    const key = getKey(item) || 'unknown'
    out[key] = (out[key] ?? 0) + 1
  }
  return out
}

function stageLabel(stage) {
  return {
    early: '早发现',
    entry_window: '入场窗口',
    pullback_watch: '确认/回踩',
    risk: '风险区',
  }[stage] ?? '未分层'
}

export default function AiReviewPage() {
  const snapshot = useSettingsStore(s => s.aiLastSnapshot)
  const lastRunAt = useSettingsStore(s => s.aiLastRunAt)
  const lastRunMode = useSettingsStore(s => s.aiLastRunMode)

  const candidates = snapshot?.candidates ?? []
  const items = snapshot?.result?.items ?? []
  const decisions = countBy(items, item => normalizeDecision(item.decision))
  const stageCounts = countBy(candidates, item => item.opportunityStage)
  const focusItems = items
    .filter(item => ['focus', 'risk'].includes(normalizeDecision(item.decision)) || Number(item.confidence) >= 75)
    .slice(0, 10)

  return (
    <div className="ai-page">
      <div className="ai-header">
        <div>
          <h2>AI复盘</h2>
          <p>汇总最近一次 Codex 筛选结论、共性、风险和下一步观察重点。</p>
          <p className="ai-last-run">
            上次运行：{fmtTime(lastRunAt)}
            {lastRunMode && ` · ${lastRunMode === 'auto' ? '自动' : lastRunMode === 'single' ? '单品种' : '手动'}`}
            {items.length ? ` · ${items.length} 条 AI 结论` : ''}
          </p>
        </div>
      </div>

      {!snapshot ? (
        <div className="ai-table-wrap">
          <div className="ai-empty">暂无 AI 复盘。请先在 AI 候选池运行一次 Codex 筛选。</div>
        </div>
      ) : (
        <>
          <div className="ai-review-grid">
            <div className="ai-review-card wide">
              <span>复盘摘要</span>
              <b>{snapshot.summary || snapshot.result?.summary || '本次 AI 没有返回摘要。'}</b>
            </div>
            {['focus', 'watch', 'risk', 'ignore'].map(key => (
              <div key={key} className="ai-review-card">
                <span>{AI_DECISION_LABELS[key]}</span>
                <b>{decisions[key] ?? 0}</b>
              </div>
            ))}
          </div>

          <div className="ai-review-grid">
            {Object.entries(stageCounts).map(([stage, n]) => (
              <div key={stage} className="ai-review-card">
                <span>{stageLabel(stage)}</span>
                <b>{n}</b>
              </div>
            ))}
          </div>

          <div className="ai-table-wrap">
            <table className="stats-table ai-table">
              <thead>
                <tr>
                  <th>品种</th>
                  <th>AI</th>
                  <th>置信度</th>
                  <th>原因</th>
                  <th>风险</th>
                  <th>下一步</th>
                </tr>
              </thead>
              <tbody>
                {!focusItems.length ? (
                  <tr><td colSpan={6} className="ai-empty">本次没有重点或高置信候选。</td></tr>
                ) : focusItems.map(item => {
                  const decision = normalizeDecision(item.decision)
                  return (
                    <tr key={`${item.symbol}-${decision}`}>
                      <td><b>{item.symbol}</b></td>
                      <td>
                        <span className={`ai-decision ${decision === 'focus' ? 'ai-decision-focus' : decision === 'risk' ? 'ai-decision-risk' : 'ai-decision-watch'}`}>
                          {AI_DECISION_LABELS[decision]}
                        </span>
                      </td>
                      <td>{Number(item.confidence) || 0}</td>
                      <td>{item.reason ?? '-'}</td>
                      <td>{item.risk ?? '-'}</td>
                      <td>{item.next_check ?? '-'}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  )
}
