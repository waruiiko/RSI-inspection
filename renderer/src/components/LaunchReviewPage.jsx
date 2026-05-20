import { useState } from 'react'
import useSignalTrailStore from '../store/signalTrailStore'
import useSettingsStore from '../store/settingsStore'

function fmtTime(ts) {
  if (!ts) return '-'
  return new Date(ts).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
}

function fmtPct(v) {
  if (v == null || Number.isNaN(v)) return '-'
  return `${v >= 0 ? '+' : ''}${Number(v).toFixed(2)}%`
}

function reviewState(item) {
  const move = item.launchChangePct ?? 0
  if (item.stage === 'risk' || item.derivatives?.stage === 'crowded') return { label: '风险过热', cls: 'ai-decision-risk' }
  if (move >= 8) return { label: '已启动', cls: 'ai-decision-focus' }
  if (item.stage === 'pullback') return { label: '等回踩', cls: 'ai-decision-watch' }
  if (item.stage === 'entry') return { label: '入场窗口', cls: 'ai-decision-focus' }
  return { label: '观察中', cls: 'ai-decision-watch' }
}

function nextNote(item) {
  const state = reviewState(item).label
  if (state === '已启动') return '不追高，观察 OI 和量能是否接力，优先等回踩。'
  if (state === '风险过热') return '注意费率、涨幅和 RSI 是否拥挤，优先防回撤。'
  if (state === '等回踩') return '看回踩后 OI 是否维持，量能是否缩而不破。'
  if (state === '入场窗口') return '看价格是否仍未过热，资金结构能否延续。'
  return '继续观察是否从早期蓄势转为量价确认。'
}

export default function LaunchReviewPage() {
  const items = useSignalTrailStore(s => s.items)
  const updateSetting = useSettingsStore(s => s.update)
  const lastRunAt = useSettingsStore(s => s.launchReviewLastRunAt)
  const lastReportPath = useSettingsStore(s => s.launchReviewLastReportPath)
  const lastDir = useSettingsStore(s => s.launchReviewLastDir)
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState('')
  const candidates = items
    .filter(item => item.status !== 'retired')
    .filter(item =>
      item.stage === 'entry' ||
      item.stage === 'pullback' ||
      item.stage === 'risk' ||
      Math.abs(item.launchChangePct ?? 0) >= 5
    )
    .sort((a, b) => Math.abs(b.launchChangePct ?? 0) - Math.abs(a.launchChangePct ?? 0))
    .slice(0, 80)

  const runLaunchReview = async () => {
    if (!candidates.length || busy) return
    setBusy(true)
    setStatus('正在运行 Codex 启动复盘...')
    try {
      const payload = {
        scope: 'launch-review',
        createdAt: new Date().toISOString(),
        candidates: candidates.slice(0, 30).map(item => ({
          symbol: item.symbol,
          stage: item.stage,
          status: item.status,
          firstSeenAt: item.firstSeenAt,
          updatedAt: item.updatedAt,
          firstPrice: item.firstPrice,
          price: item.price,
          launchChangePct: item.launchChangePct,
          change24h: item.change24h,
          derivatives: item.derivatives,
          rsi: item.rsi,
          localReasons: item.localReasons,
          reviewState: reviewState(item).label,
          nextNote: nextNote(item),
        })),
      }
      const res = await window.api.runCodexLaunchReview(payload)
      if (res.ok) {
        const now = Date.now()
        updateSetting('launchReviewLastRunAt', now)
        updateSetting('launchReviewLastReportPath', res.reportPath)
        updateSetting('launchReviewLastDir', res.reviewDir)
        setStatus(`启动复盘完成：${res.reviewName}`)
      } else {
        setStatus(`启动复盘失败：${res.stderr || res.stdout || '请检查 Codex 登录状态'}`)
      }
    } catch (err) {
      setStatus(`启动复盘失败：${err.message}`)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="ai-page">
      <div className="ai-header">
        <div>
          <h2>启动复盘</h2>
          <p>把已经从早发现推进到启动、回踩或风险阶段的标的集中保留，主要用于复盘和等二次机会。</p>
          <p className="ai-last-run">
            上次 Codex 复盘：{fmtTime(lastRunAt)}
          </p>
        </div>
        <div className="ai-actions">
          <button className="zone-btn" onClick={runLaunchReview} disabled={busy || !candidates.length}>
            {busy ? '复盘中...' : '运行 Codex 启动复盘'}
          </button>
          {lastReportPath && (
            <button className="zone-btn" onClick={() => window.api.openPath(lastReportPath)}>
              打开报告
            </button>
          )}
          {lastDir && (
            <button className="zone-btn" onClick={() => window.api.openPath(lastDir)}>
              打开目录
            </button>
          )}
        </div>
      </div>

      {status && <div className="settings-note ai-status">{status}</div>}

      <div className="ai-table-wrap">
        <table className="stats-table ai-table">
          <thead>
            <tr>
              <th>品种</th>
              <th>复盘状态</th>
              <th>首次出现</th>
              <th>最后更新</th>
              <th>首次价</th>
              <th>当前价</th>
              <th>启动后</th>
              <th>24H</th>
              <th>资金结构</th>
              <th>观察重点</th>
            </tr>
          </thead>
          <tbody>
            {!candidates.length ? (
              <tr><td colSpan={10} className="ai-empty">暂无启动复盘候选。等资金结构信号推进后会自动出现。</td></tr>
            ) : candidates.map(item => {
              const state = reviewState(item)
              return (
                <tr key={item.key}>
                  <td><b>{item.symbol}</b></td>
                  <td><span className={`ai-decision ${state.cls}`}>{state.label}</span></td>
                  <td>{fmtTime(item.firstSeenAt)}</td>
                  <td>{fmtTime(item.updatedAt)}</td>
                  <td>{item.firstPrice ?? '-'}</td>
                  <td>{item.price ?? '-'}</td>
                  <td className={(item.launchChangePct ?? 0) >= 0 ? 'pos' : 'neg'}>{fmtPct(item.launchChangePct)}</td>
                  <td className={(item.change24h ?? 0) >= 0 ? 'pos' : 'neg'}>{fmtPct(item.change24h)}</td>
                  <td>{item.derivatives?.label ?? '-'}</td>
                  <td>{nextNote(item)}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}
