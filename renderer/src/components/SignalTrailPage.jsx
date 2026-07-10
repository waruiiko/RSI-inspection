import { useState } from 'react'
import useSignalTrailStore from '../store/signalTrailStore'

const STAGE_LABELS = {
  early: '早发现',
  entry: '入场窗口',
  pullback: '确认/回踩',
  risk: '风险区',
}

const STATUS_LABELS = {
  new: '新触发',
  active: '有效',
  retired: '退回观察',
}

function fmtTime(ts) {
  if (!ts) return '-'
  return new Date(ts).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
}

function fmtPct(v) {
  if (v == null || Number.isNaN(v)) return '-'
  return `${v >= 0 ? '+' : ''}${Number(v).toFixed(2)}%`
}

export default function SignalTrailPage() {
  const items = useSignalTrailStore(s => s.items)
  const clear = useSignalTrailStore(s => s.clear)
  const [expanded, setExpanded] = useState(null)

  return (
    <div className="ai-page">
      <div className="ai-header">
        <div>
          <h2>信号轨迹</h2>
          <p>保留刚触发、仍有效和退回观察的资金结构信号，避免候选从列表里静默消失。</p>
        </div>
        <button className="zone-btn" onClick={clear} disabled={!items.length}>清空轨迹</button>
      </div>

      <div className="ai-table-wrap">
        <table className="stats-table ai-table">
          <thead>
            <tr>
              <th>品种</th>
              <th>阶段</th>
              <th>状态</th>
              <th>首次出现</th>
              <th>最后更新</th>
              <th>价格</th>
              <th>24H</th>
              <th>资金结构</th>
              <th>原因</th>
              <th>轨迹</th>
            </tr>
          </thead>
          <tbody>
            {!items.length ? (
              <tr><td colSpan={10} className="ai-empty">暂无信号轨迹。资金结构信号出现后会自动记录。</td></tr>
            ) : items.map(item => (
              <tr key={item.key} className={expanded === item.key ? 'signal-trail-expanded' : ''}>
                <td><b>{item.symbol}</b></td>
                <td>{STAGE_LABELS[item.stage] ?? item.stage}</td>
                <td>
                  <span className={`ai-decision ${item.status === 'retired' ? 'ai-decision-ignore' : item.stage === 'risk' ? 'ai-decision-risk' : 'ai-decision-watch'}`}>
                    {STATUS_LABELS[item.status] ?? item.status}
                  </span>
                </td>
                <td>{fmtTime(item.firstSeenAt)}</td>
                <td>{fmtTime(item.updatedAt)}</td>
                <td>{item.price ?? '-'}</td>
                <td className={(item.change24h ?? 0) >= 0 ? 'pos' : 'neg'}>{fmtPct(item.change24h)}</td>
                <td>{item.derivatives?.label ?? '-'}</td>
                <td>{item.localReasons?.join('，') || '-'}</td>
                <td>
                  <button className="zone-btn" onClick={() => setExpanded(expanded === item.key ? null : item.key)}>{item.events?.length ?? 0} 节点</button>
                  {expanded === item.key && <div className="signal-trail-timeline">
                    {(item.events ?? []).map((event, index) => <div key={`${event.ts}-${index}`}>
                      <i />
                      <b>{fmtTime(event.ts)} · {event.label}</b>
                      <span>{event.price ?? '-'} · OI4H {fmtPct(event.oiChange4h)} · 费率 {fmtPct(event.fundingRate)}</span>
                    </div>)}
                  </div>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
