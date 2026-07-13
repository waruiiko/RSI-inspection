import { useEffect, useMemo, useState } from 'react'
import useMarketStore from '../store/marketStore'
import useSignalReviewStore from '../store/signalReviewStore'
import useShadowStrategyStore from '../store/shadowStrategyStore'
import useRuleDriftStore from '../store/ruleDriftStore'

function ageLabel(value) {
  if (!value) return '尚未完成'
  const minutes = Math.max(0, Math.round((Date.now() - value) / 60000))
  return minutes < 1 ? '刚刚' : `${minutes}分钟前`
}

function metric(label, value, tone = '') {
  return <div className={`runtime-metric ${tone}`}><span>{label}</span><b>{value}</b></div>
}

export default function RuntimeCenterPage({ onNavigate }) {
  const assets = useMarketStore(state => state.assets)
  const updatedAt = useMarketStore(state => state.updatedAt)
  const loading = useMarketStore(state => state.loading)
  const statusEvents = useMarketStore(state => state.statusEvents)
  const fetchData = useMarketStore(state => state.fetchData)
  const captureRejectStats = useSignalReviewStore(state => state.captureRejectStats)
  const shadow = useShadowStrategyStore(state => state.observations)
  const shadowPlans = useShadowStrategyStore(state => state.plans)
  const drift = useRuleDriftStore(state => state.snapshots)
  const [diagnostics, setDiagnostics] = useState(null)
  const [jobs, setJobs] = useState([])
  const [runtime, setRuntime] = useState(null)

  const refreshDiagnostics = async () => {
    const [nextDiagnostics, nextJobs, nextRuntime] = await Promise.all([
      window.api.getDiagnostics?.(), window.api.getCodexJobs?.() ?? [], window.api.getCodexScreenRuntime?.() ?? null,
    ])
    setDiagnostics(nextDiagnostics)
    setJobs(Array.isArray(nextJobs) ? nextJobs : [])
    setRuntime(nextRuntime)
  }
  useEffect(() => { refreshDiagnostics().catch(() => {}) }, [])

  const summary = useMemo(() => {
    const signals = assets.filter(asset => asset.signalHunter)
    const accepted = signals.filter(asset => !asset.signalHunter.rejected && asset.signalHunter.status !== 'rejected')
    const executable = accepted.filter(asset => asset.signalHunter.executionEligible !== false)
    const blocked = assets.filter(asset => asset.dataQuality?.ok === false).length
    const shadowDisagreements = shadow.filter(item => item.stablePassed !== item.shadowPassed).length
    return { signals: signals.length, accepted: accepted.length, executable: executable.length, blocked, shadowDisagreements }
  }, [assets, shadow])
  const runningJobs = jobs.filter(job => job.status === 'running' || job.status === 'queued')

  return <div className="runtime-center-page">
    <header><div><h2>统一运行控制台</h2><p>集中查看数据、Signal Hunter、复盘、影子策略、漂移和AI运行状态。</p></div><div className="runtime-actions"><button className="zone-btn" disabled={loading} onClick={() => fetchData({ scope: 'runtime-center' })}>{loading ? '刷新中' : '刷新市场'}</button><button className="zone-btn" onClick={refreshDiagnostics}>刷新诊断</button></div></header>
    <section className="runtime-metrics">
      {metric('最后刷新', ageLabel(updatedAt), updatedAt ? 'ok' : 'warn')}
      {metric('数据阻断', summary.blocked, summary.blocked ? 'warn' : 'ok')}
      {metric('形成结构', summary.signals)}
      {metric('通过硬筛', summary.accepted)}
      {metric('状态可执行', summary.executable)}
      {metric('影子分歧', summary.shadowDisagreements, summary.shadowDisagreements ? 'warn' : '')}
    </section>
    <div className="runtime-grid">
      <section><header><b>数据与存储</b><button onClick={() => onNavigate('data-gaps')}>数据缺口</button></header><div className="runtime-list">{diagnostics?.checks?.map(item => <div key={item.key} className={item.ok ? 'ok' : 'warn'}><b>{item.label}</b><span>{item.detail}</span><em>{item.ok ? '正常' : '检查'}</em></div>) ?? <span>正在读取诊断…</span>}</div></section>
      <section><header><b>最近数据异常</b><small>{statusEvents.length}条</small></header><div className="runtime-list">{statusEvents.slice(0, 8).map((item, index) => <div className="warn" key={`${item.ts}-${index}`}><b>{item.scope}</b><span>{item.message}</span><em>{ageLabel(item.ts)}</em></div>)}{!statusEvents.length && <span>当前没有数据异常记录。</span>}</div></section>
      <section><header><b>复盘资格</b><small>上轮扫描</small></header><div className="runtime-list"><div><b>扫描</b><span>{captureRejectStats?.total ?? 0}</span><em>新增 {captureRejectStats?.captured ?? 0}</em></div>{Object.entries(captureRejectStats?.reasons ?? {}).sort((a, b) => b[1] - a[1]).slice(0, 6).map(([reason, count]) => <div key={reason}><b>{reason}</b><span>{count}个</span><em>阻断</em></div>)}</div></section>
      <section><header><b>影子与漂移</b><small>{drift.length}轮快照</small></header><div className="runtime-list"><div><b>影子对照</b><span>{shadow.length}个</span><em>{summary.shadowDisagreements}分歧</em></div><div><b>影子计划</b><span>{shadowPlans.length}个</span><em>{shadowPlans.filter(item => item.status === 'triggered').length}触发</em></div><div><b>影子结果</b><span>{shadowPlans.filter(item => item.status === 'win').length}胜 / {shadowPlans.filter(item => item.status === 'loss').length}负</span><em>{shadowPlans.filter(item => item.status === 'ambiguous').length}歧义</em></div><div><b>7天漂移样本</b><span>{drift.filter(item => Date.now() - item.scanAt <= 7 * 86400000).length}轮</span><em>只观察</em></div><div><b>30天基线</b><span>{drift.filter(item => Date.now() - item.scanAt <= 30 * 86400000).length}轮</span><em>只观察</em></div></div></section>
      <section className="runtime-ai-panel"><header><b>AI任务</b><div><button disabled={!runningJobs.length} onClick={async () => { await window.api.cancelCodexJobs?.(); refreshDiagnostics() }}>取消任务</button><button onClick={() => onNavigate('settings')}>AI设置</button></div></header><div className="runtime-list"><div className={runtime?.circuitOpen ? 'warn' : 'ok'}><b>熔断状态</b><span>{runtime?.circuitOpen ? '已开启' : '正常'}</span><em>{runtime?.failureStreak ?? 0}连续失败</em></div>{jobs.slice(0, 8).map(job => <div className={job.status === 'failed' ? 'warn' : ''} key={job.id}><b>{job.type}</b><span>{job.status}</span><em>{job.durationMs ? `${(job.durationMs / 1000).toFixed(1)}秒` : '-'}</em></div>)}</div></section>
    </div>
  </div>
}
