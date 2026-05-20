import { useMemo, useState } from 'react'
import useMarketStore from '../store/marketStore'
import useAlertStore from '../store/alertStore'
import useSettingsStore from '../store/settingsStore'
import useSignalTrailStore from '../store/signalTrailStore'
import useMarketChatStore from '../store/marketChatStore'
import { buildCandidates } from '../utils/aiCandidates'
import { getQuoteVolume } from '../utils/liquidity'

const QUICK_QUESTIONS = [
  '总结当前最值得继续观察的 5 个标的',
  '哪些候选已经过热或风险最高？',
  '从资金结构看，哪些更像早期启动？',
  '帮我整理接下来 1-4 小时观察清单',
  '比较 AI 结果和信号轨迹，找出重合标的',
]

function compactAsset(a) {
  return {
    symbol: a.symbol,
    source: a.source,
    type: a.type,
    price: a.price,
    change24h: a.change24h,
    quoteVolume24h: getQuoteVolume(a),
    rsi: a.rsi,
    divergence: a.divergence,
    volumeSignal: a.volumeSignal,
    signalScore: a.signalScore,
    derivatives: a.derivatives,
  }
}

function compactFeed(item) {
  return {
    ts: item.ts,
    symbol: item.symbol,
    type: item.type,
    timeframe: item.timeframe,
    condition: item.condition,
    value: item.value,
    reason: item.reason,
    risk: item.risk,
    nextCheck: item.nextCheck,
  }
}

function tabLabel(tab) {
  return {
    market: '市场',
    manage: '管理品种',
    alerts: '提醒',
    ai: 'AI候选池',
    'ai-review': 'AI复盘',
    trail: '信号轨迹',
    'launch-review': '启动复盘',
    settings: '设置',
  }[tab] ?? tab
}

function pageContextFor(activeTab, data) {
  const { candidates, aiSnapshot, trail, feed, assets, timeframe } = data
  if (activeTab === 'market') {
    return {
      visibleIntent: '用户正在看市场首页、热力图和列表',
      timeframe,
      topCandidates: candidates.slice(0, 15),
      strongestDerivatives: assets
        .filter(a => a.derivatives)
        .sort((a, b) => Math.abs(b.derivatives?.score ?? 0) - Math.abs(a.derivatives?.score ?? 0))
        .slice(0, 15)
        .map(compactAsset),
    }
  }
  if (activeTab === 'ai') {
    return {
      visibleIntent: '用户正在看 AI 候选池',
      aiSnapshot,
      currentCandidates: candidates,
    }
  }
  if (activeTab === 'ai-review') {
    return {
      visibleIntent: '用户正在看 AI 复盘',
      aiSnapshot,
    }
  }
  if (activeTab === 'trail') {
    return {
      visibleIntent: '用户正在看信号轨迹',
      signalTrail: trail.slice(0, 80),
    }
  }
  if (activeTab === 'launch-review') {
    return {
      visibleIntent: '用户正在看启动复盘',
      launchCandidates: trail
        .filter(item => item.status !== 'retired')
        .filter(item => item.stage === 'entry' || item.stage === 'pullback' || item.stage === 'risk' || Math.abs(item.launchChangePct ?? 0) >= 5)
        .slice(0, 80),
    }
  }
  if (activeTab === 'alerts') {
    return {
      visibleIntent: '用户正在看提醒规则和提醒记录',
      recentAlerts: feed.slice(0, 80).map(compactFeed),
    }
  }
  return {
    visibleIntent: `用户正在看 ${tabLabel(activeTab)} 页面`,
  }
}

export default function MarketChatPage({ activeTab = 'market', drawer = false, onClose }) {
  const assets = useMarketStore(s => s.assets)
  const timeframe = useMarketStore(s => s.timeframe)
  const filter = useMarketStore(s => s.filter)
  const liquidityLimit = useMarketStore(s => s.liquidityLimit)
  const updatedAt = useMarketStore(s => s.updatedAt)
  const feed = useAlertStore(s => s.feed)
  const aiSnapshot = useSettingsStore(s => s.aiLastSnapshot)
  const trail = useSignalTrailStore(s => s.items)
  const messages = useMarketChatStore(s => s.messages)
  const addMessage = useMarketChatStore(s => s.addMessage)
  const clear = useMarketChatStore(s => s.clear)

  const [question, setQuestion] = useState('')
  const [busy, setBusy] = useState(false)
  const [lastDir, setLastDir] = useState('')

  const candidates = useMemo(() => buildCandidates(assets, 25), [assets])

  const buildContext = () => ({
    createdAt: new Date().toISOString(),
    activeTab,
    pageContext: pageContextFor(activeTab, { candidates, aiSnapshot, trail, feed, assets, timeframe }),
    market: {
      timeframe,
      filter,
      liquidityLimit,
      updatedAt: updatedAt ? new Date(updatedAt).toISOString() : null,
      assetCount: assets.length,
    },
    topCandidates: candidates,
    aiSnapshot: aiSnapshot ? {
      ts: aiSnapshot.ts,
      mode: aiSnapshot.mode,
      summary: aiSnapshot.summary,
      result: aiSnapshot.result,
      candidates: aiSnapshot.candidates?.slice(0, 30),
    } : null,
    signalTrail: trail.slice(0, 50),
    recentAlerts: feed.slice(0, 30).map(compactFeed),
    marketSample: assets.slice(0, 80).map(compactAsset),
  })

  const ask = async (text = question) => {
    const q = text.trim()
    if (!q || busy) return
    addMessage({ role: 'user', text: q })
    setQuestion('')
    setBusy(true)
    try {
      const res = await window.api.runCodexMarketChat({
        scope: activeTab || 'market',
        question: q,
        context: buildContext(),
      })
      if (res.ok) {
        addMessage({ role: 'assistant', text: res.answer, reportPath: res.reportPath, chatDir: res.chatDir })
        setLastDir(res.chatDir)
      } else {
        addMessage({ role: 'assistant', text: `Codex 回答失败：${res.stderr || res.stdout || '请检查 Codex 登录状态'}` })
      }
    } catch (err) {
      addMessage({ role: 'assistant', text: `Codex 回答失败：${err.message}` })
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className={`ai-page market-chat-page ${drawer ? 'drawer' : ''}`}>
      <div className="ai-header">
        <div>
          <h2>AI对话</h2>
          <p>当前界面：{tabLabel(activeTab)}。AI 会带上当前页面上下文，只做筛选、解释和风险提示。</p>
        </div>
        <div className="ai-actions">
          <button className="zone-btn" onClick={clear} disabled={!messages.length}>清空对话</button>
          {lastDir && <button className="zone-btn" onClick={() => window.api.openPath(lastDir)}>打开目录</button>}
          {drawer && <button className="zone-btn" onClick={onClose}>收起</button>}
        </div>
      </div>

      <div className="chat-context-strip">
        <span>当前候选 {candidates.length}</span>
        <span>AI快照 {aiSnapshot?.candidates?.length ?? 0}</span>
        <span>信号轨迹 {trail.length}</span>
        <span>提醒记录 {feed.length}</span>
      </div>

      <div className="chat-quick-row">
        {QUICK_QUESTIONS.map(q => (
          <button key={q} className="feed-type-btn" disabled={busy} onClick={() => ask(q)}>{q}</button>
        ))}
      </div>

      <div className="market-chat-list">
        {!messages.length ? (
          <div className="ai-empty">可以直接问：现在最值得盯的是哪几个？或者点击上面的快捷问题。</div>
        ) : messages.map(msg => (
          <div key={msg.id} className={`chat-message ${msg.role}`}>
            <div className="chat-message-role">{msg.role === 'user' ? '你' : 'Codex'}</div>
            <div className="chat-message-body">{msg.text}</div>
            {msg.reportPath && (
              <button className="ai-row-btn" onClick={() => window.api.openPath(msg.reportPath)}>打开回答</button>
            )}
          </div>
        ))}
      </div>

      <div className="chat-input-row">
        <textarea
          value={question}
          onChange={e => setQuestion(e.target.value)}
          placeholder="就当前界面提问，比如：哪些更像早期启动？哪些风险最高？"
          onKeyDown={e => {
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) ask()
          }}
        />
        <button className="zone-btn" disabled={busy || !question.trim()} onClick={() => ask()}>
          {busy ? '思考中...' : '发送'}
        </button>
      </div>
    </div>
  )
}
