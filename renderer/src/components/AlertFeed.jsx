import { Fragment, useMemo, useState } from 'react'
import useAlertStore from '../store/alertStore'
import useMarketStore from '../store/marketStore'
import ChartModal from './ChartModal'

const TYPE_FILTERS = [
  { key: 'all', label: '全部' },
  { key: 'rsi', label: 'RSI' },
  { key: 'price', label: '价格' },
  { key: 'change', label: '涨跌' },
  { key: 'divergence', label: '背离' },
  { key: 'structure', label: '量价' },
  { key: 'ai', label: 'AI' },
]

function fmtTime(ts) {
  const d = new Date(ts)
  const time = d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' })
  const day = String(d.getDate()).padStart(2, '0')
  const mon = String(d.getMonth() + 1).padStart(2, '0')
  return `${time}  ${day}/${mon}`
}

function fmtPrice(v) {
  if (v == null) return '-'
  if (v >= 1000) return v.toLocaleString('en-US', { maximumFractionDigits: 2 })
  if (v >= 1) return v.toFixed(4)
  return v.toPrecision(4)
}

function fmtPct(v, digits = 2) {
  if (v == null || Number.isNaN(v)) return '-'
  return `${v >= 0 ? '+' : ''}${Number(v).toFixed(digits)}%`
}

function fmtDetail(item) {
  if (item.type === 'rsi') {
    const dir = item.condition === 'above' ? '超过' : '低于'
    return ` RSI(${item.timeframe}) ${dir} ${item.threshold}，当前 ${Number(item.value).toFixed(1)}`
  }
  if (item.type === 'price') {
    const dir = item.condition === 'above' ? '突破' : '跌破'
    return ` 价格${dir} ${fmtPrice(item.threshold)}，当前 ${fmtPrice(item.value)}`
  }
  if (item.type === 'divergence') {
    const dir = item.condition === 'bull' ? '牛市背离' : '熊市背离'
    return ` (${item.timeframe}) 检测到 ${dir}`
  }
  if (item.type === 'structure') {
    const ratio = item.volumeRatio != null ? `，量能 ${item.volumeRatio}x` : ''
    const move = item.priceMovePct != null ? `，K线 ${fmtPct(item.priceMovePct)}` : ''
    return ` (${item.timeframe}) ${item.signal ?? '量价结构'}，评分 ${item.value}${ratio}${move}`
  }
  if (item.type === 'ai') {
    const label = item.condition === 'focus' ? '重点' : item.condition === 'risk' ? '风险' : '观察'
    const confidence = item.value != null ? `，置信度 ${item.value}` : ''
    const next = item.nextCheck ? `，看点：${item.nextCheck}` : ''
    return ` AI筛选：${label}${confidence}，${item.reason ?? '等待复核'}${next}`
  }
  const dir = item.condition === 'above' ? '涨超' : '跌超'
  const mag = Math.abs(item.threshold)
  return ` 24h${dir} ${mag}%，当前 ${fmtPct(item.value)}`
}

function levelLabel(item) {
  const level = item.level ?? (item.special ? 3 : 1)
  if (level === 0) return '观察'
  return `${level}级`
}

function itemColor(item) {
  if (item.type === 'rsi') return item.condition === 'above' ? 'feed-orange' : 'feed-sky'
  if (item.type === 'price') return item.condition === 'above' ? 'feed-red' : 'feed-green'
  if (item.type === 'divergence') return item.condition === 'bull' ? 'feed-green' : 'feed-orange'
  if (item.type === 'ai') return item.condition === 'risk' ? 'feed-red' : item.condition === 'focus' ? 'feed-orange' : 'feed-sky'
  if (item.type === 'structure') {
    return item.condition === 'bullish'
      ? 'feed-green'
      : item.condition === 'bearish'
        ? 'feed-red'
        : 'feed-orange'
  }
  return item.value > 0 ? 'feed-green' : 'feed-red'
}

function exportFeedCsv(items, assets) {
  const rows = items.map(item => {
    const asset = assets.find(x => x.symbol === item.symbol || x.apiSymbol === item.symbol)
    const current = asset?.price ?? ''
    const move = item.price && asset?.price ? ((asset.price - item.price) / item.price).toFixed(2) : ''
    return [
      new Date(item.ts).toLocaleString('zh-CN'),
      item.symbol,
      item.type,
      item.timeframe ?? '',
      item.condition ?? '',
      item.threshold ?? '',
      item.value ?? '',
      item.price ?? '',
      current,
      move,
      item.outcomes?.['1h']?.changePct?.toFixed(2) ?? '',
      item.outcomes?.['4h']?.changePct?.toFixed(2) ?? '',
      item.outcomes?.['24h']?.changePct?.toFixed(2) ?? '',
    ]
  })
  const headers = ['时间', '品种', '类型', '周期', '条件', '阈值', '触发值', '触发价', '当前价', '当前涨跌%', '1h%', '4h%', '24h%']
  const csv = [headers, ...rows]
    .map(row => row.map(v => `"${String(v).replaceAll('"', '""')}"`).join(','))
    .join('\n')
  const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = `alert-feed-${new Date().toISOString().slice(0, 10)}.csv`
  link.click()
  URL.revokeObjectURL(url)
}

function signalBias(item) {
  if (item.type === 'rsi') return item.condition === 'below' ? '偏反弹观察' : '偏过热观察'
  if (item.type === 'price') return item.condition === 'above' ? '偏突破跟踪' : '偏破位风险'
  if (item.type === 'divergence') return item.condition === 'bull' ? '偏底背离观察' : '偏顶背离风险'
  if (item.type === 'structure') return item.condition === 'bullish' ? '偏强势量价信号' : '偏弱势量价信号'
  return item.value >= 0 ? '偏强波动' : '偏弱波动'
}

function buildLocalReview(payload, detail) {
  const { item, currentAsset, currentMove } = payload
  const lines = [
    `# ${item.symbol} 提醒复盘`,
    '',
    `- 触发时间：${new Date(item.ts).toLocaleString('zh-CN')}`,
    `- 提醒内容：${detail}`,
    `- 信号等级：${levelLabel(item)}`,
    `- 触发价格：${item.price ? fmtPrice(item.price) : '-'}`,
    `- 当前价格：${currentAsset?.price ? fmtPrice(currentAsset.price) : '-'}`,
    `- 触发后变化：${fmtPct(currentMove)}`,
    '',
    '## 本地判断',
    '',
    `这个信号目前更适合归类为：${signalBias(item)}。`,
    '',
    '## 需要继续看的点',
    '',
    '- 价格是否继续沿触发方向延续，还是快速回到触发区间内。',
    '- RSI 是否从极端区间回落/回升，避免只看单点触发。',
    '- 如果有量价信号，优先确认成交量是否持续，而不是只出现一根放量 K 线。',
    '- 如果是背离信号，建议打开 K 线图确认背离标记和价格结构。',
    '',
    '## 原始快照',
    '',
    '```json',
    JSON.stringify(payload, null, 2),
    '```',
    '',
  ]
  return lines.join('\n')
}

function buildAiPrompt(payload, detail) {
  return [
    '你是 RSI-inspection 的交易提醒复盘助手。',
    '请基于下面这条提醒快照，输出一份中文复盘报告。',
    '',
    '报告请包含：',
    '1. 提醒摘要',
    '2. 触发原因',
    '3. 信号偏观察、普通提醒还是强提醒，理由是什么',
    '4. 风险点',
    '5. 下一步应该看哪些指标或价格行为',
    '6. 给非技术交易者也能看懂的结论',
    '',
    '要求：不要编造不存在的数据；数据不足时明确说明。',
    '',
    `提醒描述：${detail}`,
    '',
    '提醒快照 JSON：',
    '```json',
    JSON.stringify(payload, null, 2),
    '```',
  ].join('\n')
}

function downloadMarkdown(filename, text) {
  const blob = new Blob(['\uFEFF' + text], { type: 'text/markdown;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  link.click()
  URL.revokeObjectURL(url)
}

async function copyText(text) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text)
    return
  }
  const el = document.createElement('textarea')
  el.value = text
  el.setAttribute('readonly', '')
  el.style.position = 'fixed'
  el.style.left = '-9999px'
  document.body.appendChild(el)
  el.select()
  document.execCommand('copy')
  document.body.removeChild(el)
}

export default function AlertFeed() {
  const feed = useAlertStore(s => s.feed)
  const clearFeed = useAlertStore(s => s.clearFeed)
  const setFlash = useMarketStore(s => s.setFlash)
  const assets = useMarketStore(s => s.assets)

  const [typeFilter, setTypeFilter] = useState('all')
  const [symbolFilter, setSymbolFilter] = useState('')
  const [selectedItem, setSelectedItem] = useState(null)
  const [chartAsset, setChartAsset] = useState(null)
  const [codexState, setCodexState] = useState({ busy: false, msg: '', reviewDir: '', reportPath: '' })

  const visible = useMemo(() => {
    const q = symbolFilter.trim().toUpperCase()
    return feed.filter(item => {
      if (typeFilter !== 'all' && item.type !== typeFilter) return false
      if (q && !item.symbol.toUpperCase().includes(q)) return false
      return true
    })
  }, [feed, typeFilter, symbolFilter])

  const reviewAsset = selectedItem
    ? assets.find(a => a.symbol === selectedItem.symbol || a.apiSymbol === selectedItem.symbol)
    : null
  const currentMove = selectedItem?.price && reviewAsset?.price
    ? ((reviewAsset.price - selectedItem.price) / selectedItem.price) * 100
    : null

  const perf = useMemo(() => {
    const rows = []
    for (const item of feed) {
      const asset = assets.find(x => x.symbol === item.symbol || x.apiSymbol === item.symbol)
      if (!asset?.price || !item.price) continue
      const move = ((asset.price - item.price) / item.price) * 100
      const expectedUp = item.type === 'rsi'
        ? item.condition === 'below'
        : item.type === 'price'
          ? item.condition === 'above'
          : item.type === 'divergence'
            ? item.condition === 'bull'
            : (item.value ?? 0) > 0
      rows.push({ move, hit: expectedUp ? move > 0 : move < 0 })
    }
    const hit = rows.filter(r => r.hit).length
    return { total: rows.length, hit, rate: rows.length ? Math.round(hit / rows.length * 100) : null }
  }, [feed, assets])

  const buildReviewPayload = () => {
    if (!selectedItem) return null
    return {
      createdAt: new Date().toISOString(),
      item: selectedItem,
      currentAsset: reviewAsset ? {
        symbol: reviewAsset.symbol,
        source: reviewAsset.source,
        type: reviewAsset.type,
        price: reviewAsset.price,
        change24h: reviewAsset.change24h,
        rsi: reviewAsset.rsi,
        divergence: reviewAsset.divergence,
        volumeSignal: reviewAsset.volumeSignal,
        signalScore: reviewAsset.signalScore,
      } : null,
      currentMove,
    }
  }

  const handleCopyAiPrompt = async () => {
    const payload = buildReviewPayload()
    if (!payload) return
    const text = buildAiPrompt(payload, fmtDetail(selectedItem))
    try {
      await copyText(text)
      setCodexState(s => ({ ...s, msg: '已复制 AI 复盘提示词，可以直接粘贴到 Codex / Claude / ChatGPT。' }))
    } catch (err) {
      setCodexState(s => ({ ...s, msg: `复制失败：${err.message}` }))
    }
  }

  const handleLocalReview = () => {
    const payload = buildReviewPayload()
    if (!payload) return
    const text = buildLocalReview(payload, fmtDetail(selectedItem))
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')
    downloadMarkdown(`review-${selectedItem.symbol}-${stamp}.md`, text)
    setCodexState(s => ({ ...s, msg: '已生成本地复盘报告。' }))
  }

  const handleCodexReview = async () => {
    const payload = buildReviewPayload()
    if (!payload) return
    setCodexState({ busy: true, msg: '正在运行 Codex 复盘...', reviewDir: '', reportPath: '' })
    try {
      const res = await window.api.runCodexReview(payload)
      setCodexState({
        busy: false,
        msg: res.ok
          ? `Codex 复盘完成：${res.reviewName}`
          : `Codex 复盘失败：${res.stderr || res.stdout || '请检查 Codex CLI 登录状态'}`,
        reviewDir: res.reviewDir,
        reportPath: res.reportPath,
      })
    } catch (err) {
      setCodexState({ busy: false, msg: `Codex 复盘失败：${err.message}`, reviewDir: '', reportPath: '' })
    }
  }

  return (
    <div className="alert-feed">
      <div className="feed-head">
        <span className="feed-title">提醒记录</span>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          {feed.length > 0 && (
            <span style={{ fontSize: 10, color: 'var(--dim)', fontVariantNumeric: 'tabular-nums' }}>
              {feed.length} 条{perf.total ? ` · 命中 ${perf.rate}%` : ''}
            </span>
          )}
          {feed.length > 0 && (
            <button className="feed-clear-btn" onClick={clearFeed}>清除</button>
          )}
          {feed.length > 0 && (
            <button className="feed-clear-btn" onClick={() => exportFeedCsv(visible, assets)}>导出</button>
          )}
        </div>
      </div>

      {feed.length > 0 && (
        <div className="feed-filters">
          <div className="feed-type-btns">
            {TYPE_FILTERS.map(f => (
              <button
                key={f.key}
                className={`feed-type-btn ${typeFilter === f.key ? 'active' : ''}`}
                onClick={() => setTypeFilter(f.key)}
              >
                {f.label}
              </button>
            ))}
          </div>
          <input
            type="search"
            className="feed-sym-search"
            placeholder="品种..."
            value={symbolFilter}
            onChange={e => setSymbolFilter(e.target.value)}
          />
        </div>
      )}

      <div className="feed-list">
        {feed.length === 0
          ? <div className="feed-empty">暂无提醒</div>
          : visible.length === 0
            ? <div className="feed-empty">无匹配记录</div>
            : visible.map(item => (
              <div
                key={item.id}
                className={`feed-item ${itemColor(item)} ${item.level >= 2 || item.special ? 'feed-special' : ''}`}
                onClick={() => setSelectedItem(item)}
              >
                <span className="feed-time">{fmtTime(item.ts)}</span>
                <span className="feed-msg">
                  <span className="feed-star">{levelLabel(item)}</span>
                  <span
                    className="feed-symbol"
                    onClick={e => { e.stopPropagation(); setFlash(item.symbol) }}
                  >
                    {item.symbol}
                  </span>
                  {fmtDetail(item)}
                </span>
              </div>
            ))
        }
      </div>

      {selectedItem && (
        <div className="review-overlay" onClick={() => setSelectedItem(null)}>
          <div className="review-panel" onClick={e => e.stopPropagation()}>
            <div className="review-head">
              <strong>{selectedItem.symbol} 提醒复盘</strong>
              <button className="chart-modal-close" onClick={() => setSelectedItem(null)}>×</button>
            </div>

            <div className="review-grid">
              <span>触发时间</span><b>{new Date(selectedItem.ts).toLocaleString('zh-CN')}</b>
              <span>提醒内容</span><b>{fmtDetail(selectedItem)}</b>
              <span>触发价格</span><b>{selectedItem.price ? fmtPrice(selectedItem.price) : '-'}</b>
              <span>当前价格</span><b>{reviewAsset?.price ? fmtPrice(reviewAsset.price) : '-'}</b>
              <span>触发后变化</span>
              <b style={{ color: currentMove == null ? 'var(--muted)' : currentMove >= 0 ? '#22c55e' : '#ef4444' }}>
                {fmtPct(currentMove)}
              </b>
              {['1h', '4h', '24h'].map(key => {
                const outcome = selectedItem.outcomes?.[key]
                return (
                  <Fragment key={key}>
                    <span>{key} 结果</span>
                    <b style={{ color: outcome == null ? 'var(--muted)' : outcome.changePct >= 0 ? '#22c55e' : '#ef4444' }}>
                      {outcome == null ? '等待记录' : fmtPct(outcome.changePct)}
                    </b>
                  </Fragment>
                )
              })}
            </div>

            <div className="review-actions">
              <button className="zone-btn" onClick={() => setFlash(selectedItem.symbol)}>在首页定位</button>
              <button className="zone-btn" disabled={!reviewAsset} onClick={() => reviewAsset && setChartAsset(reviewAsset)}>
                打开K线并查看标记
              </button>
            </div>

            <div className="review-actions" style={{ paddingTop: 10 }}>
              <button className="zone-btn" disabled={codexState.busy} onClick={handleCodexReview}>
                运行 Codex 复盘
              </button>
              <button className="zone-btn" onClick={handleCopyAiPrompt}>
                复制 AI 提示词
              </button>
              <button className="zone-btn" onClick={handleLocalReview}>
                下载本地复盘
              </button>
              {!!codexState.reviewDir && (
                <button className="zone-btn" onClick={() => window.api.openPath(codexState.reviewDir)}>
                  打开 Codex 目录
                </button>
              )}
              {!!codexState.reportPath && (
                <button className="zone-btn" onClick={() => window.api.openPath(codexState.reportPath)}>
                  打开 Codex 报告
                </button>
              )}
            </div>

            {codexState.msg && (
              <div className="settings-note" style={{ paddingTop: 10 }}>
                {codexState.msg}
              </div>
            )}
          </div>
        </div>
      )}

      {chartAsset && <ChartModal asset={chartAsset} alertItem={selectedItem} onClose={() => setChartAsset(null)} />}
    </div>
  )
}
