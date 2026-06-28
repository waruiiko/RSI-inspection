import { Fragment, lazy, Suspense, useMemo, useState } from 'react'
import useAlertStore from '../store/alertStore'
import useMarketStore from '../store/marketStore'
const ChartModal = lazy(() => import('./ChartModal'))

const TYPE_FILTERS = [
  { key: 'all', label: '全部' },
  { key: 'opportunity', label: '机会' },
  { key: 'risk', label: '风险' },
  { key: 'cooldown', label: '冷却' },
  { key: 'ai', label: 'AI' },
]

const BUCKET_LABELS = {
  opportunity: '机会',
  risk: '风险',
  cooldown: '冷却',
  ai: 'AI',
}

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
  if (item.type === 'market_report') {
    return ` ${item.signal ?? '启动健康报告'}：${item.reason ?? '-'}`
  }
  if (item.type === 'rsi') {
    if (item.signal) {
      return ` ${item.signal}(${item.timeframe})，RSI ${Number(item.value).toFixed(1)}${item.change24h != null ? `，24H ${fmtPct(item.change24h)}` : ''}`
    }
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
  if (item.type === 'signal_hunter') {
    const label = item.condition === 'triggered' ? '触发' : '预埋'
    const side = item.side === 'short' ? '做空' : '做多'
    const risk = item.risk ? `，风险：${item.risk}` : ''
    return ` Signal Hunter ${side}${label}(${item.timeframe})，现价 ${fmtPrice(item.value)}，触发价 ${fmtPrice(item.threshold)}，${item.reason ?? '等待确认'}${risk}`
  }
  if (item.type === 'signal_hunter_ai') {
    const label = item.condition === 'risk' ? '风险' : item.condition === 'focus' ? '重点' : '观察'
    const side = item.side === 'short' ? '做空' : '做多'
    const score = item.score != null ? `，评分 ${item.score}` : ''
    const status = item.status ? `，状态 ${item.status}` : ''
    const risk = item.risk ? `，风险：${item.risk}` : ''
    const next = item.nextCheck ? `，${item.nextCheck}` : ''
    return ` SH AI：${side}${label}${score}${status}，${item.reason ?? '等待复核'}${risk}${next}`
  }
  if (item.type === 'ai') {
    const label = item.condition === 'focus' ? '重点' : item.condition === 'risk' ? '风险' : '观察'
    const confidence = item.value != null ? `，置信度 ${item.value}` : ''
    const next = item.nextCheck ? `，看点：${item.nextCheck}` : ''
    return ` AI筛选：${label}${confidence}，${item.reason ?? '等待复核'}${next}`
  }
  if (item.type === 'watch_pool') {
    return ` ${item.signal ?? '观察池复看'}，${item.reason ?? '波动冷却后可重新观察'}`
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
  if (item.type === 'market_report') return 'feed-sky'
  if (item.type === 'rsi') return item.condition === 'above' ? 'feed-orange' : 'feed-sky'
  if (item.type === 'price') return item.condition === 'above' ? 'feed-red' : 'feed-green'
  if (item.type === 'divergence') return item.condition === 'bull' ? 'feed-green' : 'feed-orange'
  if (item.type === 'signal_hunter_ai') return item.condition === 'risk' ? 'feed-red' : item.condition === 'focus' ? 'feed-orange' : 'feed-sky'
  if (item.type === 'ai') return item.condition === 'risk' ? 'feed-red' : item.condition === 'focus' ? 'feed-orange' : 'feed-sky'
  if (item.type === 'watch_pool') return 'feed-sky'
  if (item.type === 'signal_hunter') return item.side === 'short' ? 'feed-red' : item.condition === 'triggered' ? 'feed-green' : 'feed-orange'
  if (item.type === 'structure') {
    return item.condition === 'bullish'
      ? 'feed-green'
      : item.condition === 'bearish'
        ? 'feed-red'
        : 'feed-orange'
  }
  return item.value > 0 ? 'feed-green' : 'feed-red'
}

function feedBucket(item) {
  if (item.type === 'signal_hunter_ai') return item.condition === 'risk' ? 'risk' : item.condition === 'focus' ? 'opportunity' : 'ai'
  if (item.type === 'ai') return 'ai'
  if (item.type === 'watch_pool') return 'cooldown'
  if (item.type === 'signal_hunter') return 'opportunity'
  if (item.type === 'market_report') return 'opportunity'
  if (item.condition === 'risk') return 'risk'
  if (item.type === 'rsi') return item.condition === 'below' ? 'opportunity' : 'risk'
  if (item.type === 'price') return item.condition === 'above' ? 'opportunity' : 'risk'
  if (item.type === 'divergence') return item.condition === 'bull' ? 'opportunity' : 'risk'
  if (item.type === 'structure') return item.condition === 'bearish' ? 'risk' : 'opportunity'
  if (item.type === 'change') return item.condition === 'above' ? 'opportunity' : 'risk'
  return (item.value ?? 0) >= 0 ? 'opportunity' : 'risk'
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
  if (String(item.signal || '').startsWith('慢速超卖观察')) return '偏中长线反弹观察'
  if (item.type === 'watch_pool') return '冷却后复看观察'
  if (item.type === 'signal_hunter') return `${item.side === 'short' ? '做空' : '做多'} Signal Hunter ${item.condition === 'triggered' ? '触发' : '预埋'}`
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
  const configs = useAlertStore(s => s.configs)
  const clearFeed = useAlertStore(s => s.clearFeed)
  const updateFeed = useAlertStore(s => s.updateFeed)
  const setFlash = useMarketStore(s => s.setFlash)
  const assets = useMarketStore(s => s.assets)

  const [typeFilter, setTypeFilter] = useState('all')
  const [symbolFilter, setSymbolFilter] = useState('')
  const [selectedItem, setSelectedItem] = useState(null)
  const [chartAsset, setChartAsset] = useState(null)
  const [codexState, setCodexState] = useState({ busy: false, msg: '', reviewDir: '', reportPath: '' })

  const assetMap = useMemo(() => {
    const map = new Map()
    for (const asset of assets) {
      if (asset.symbol) map.set(String(asset.symbol).toUpperCase(), asset)
      if (asset.apiSymbol) map.set(String(asset.apiSymbol).toUpperCase(), asset)
    }
    return map
  }, [assets])

  const findAsset = (symbol) => assetMap.get(String(symbol ?? '').toUpperCase()) ?? null

  const markFeedback = (value) => {
    if (!selectedItem) return
    updateFeed(items => items.map(item => item.id === selectedItem.id
      ? { ...item, feedback: value, feedbackAt: Date.now() }
      : item))
    setSelectedItem(item => item ? { ...item, feedback: value, feedbackAt: Date.now() } : item)
  }

  const feedbackStats = useMemo(() => {
    const tally = {}
    for (const item of feed) {
      if (!item.feedback) continue
      tally[item.feedback] = (tally[item.feedback] ?? 0) + 1
    }
    return tally
  }, [feed])

  const visible = useMemo(() => {
    const q = symbolFilter.trim().toUpperCase()
    return feed.filter(item => {
      if (typeFilter !== 'all' && feedBucket(item) !== typeFilter) return false
      if (q && !item.symbol.toUpperCase().includes(q)) return false
      return true
    })
  }, [feed, typeFilter, symbolFilter])

  const reviewAsset = selectedItem
    ? findAsset(selectedItem.symbol)
    : null
  const currentMove = selectedItem?.price && reviewAsset?.price
    ? ((reviewAsset.price - selectedItem.price) / selectedItem.price) * 100
    : null

  const perf = useMemo(() => {
    const rows = []
    for (const item of feed) {
      const asset = findAsset(item.symbol)
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
  }, [feed, assetMap])

  const bucketPerf = useMemo(() => {
    const stats = {}
    for (const item of feed) {
      const asset = findAsset(item.symbol)
      if (!asset?.price || !item.price) continue
      const move = ((asset.price - item.price) / item.price) * 100
      const bucket = feedBucket(item)
      const expectedUp = bucket === 'opportunity' || bucket === 'ai'
      const hit = expectedUp ? move > 0 : move < 0
      const row = stats[bucket] ?? { total: 0, hit: 0 }
      row.total += 1
      if (hit) row.hit += 1
      stats[bucket] = row
    }
    return stats
  }, [feed, assetMap])

  const rulePerf = useMemo(() => {
    const names = new Map(configs.map(c => [c.id, c.symbol]))
    const stats = {}
    for (const item of feed) {
      if (!item.ruleId || !item.price) continue
      const outcome = item.outcomes?.['4h'] ?? item.outcomes?.['1h'] ?? item.outcomes?.['24h']
      let move = outcome?.changePct
      if (move == null) {
        const asset = findAsset(item.symbol)
        if (!asset?.price) continue
        move = ((asset.price - item.price) / item.price) * 100
      }
      const bucket = feedBucket(item)
      const expectedUp = bucket === 'opportunity' || bucket === 'ai'
      const hit = expectedUp ? move > 0 : move < 0
      const row = stats[item.ruleId] ?? {
        ruleId: item.ruleId,
        label: names.get(item.ruleId) ?? item.ruleSymbol ?? item.symbol,
        total: 0,
        hit: 0,
        lastTs: 0,
      }
      row.total += 1
      if (hit) row.hit += 1
      row.lastTs = Math.max(row.lastTs, item.ts ?? 0)
      stats[item.ruleId] = row
    }
    return Object.values(stats)
      .filter(row => row.total >= 2)
      .map(row => ({ ...row, rate: Math.round(row.hit / row.total * 100) }))
      .sort((a, b) => a.rate - b.rate || b.total - a.total)
      .slice(0, 4)
  }, [feed, assetMap, configs])

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
          {Object.keys(feedbackStats).length > 0 && (
            <span className="feed-feedback-summary">
              {Object.entries(feedbackStats).map(([k, v]) => `${k}${v}`).join(' · ')}
            </span>
          )}
          {Object.keys(bucketPerf).length > 0 && (
            <span className="feed-feedback-summary">
              {Object.entries(bucketPerf).map(([k, v]) => `${BUCKET_LABELS[k] ?? k} ${Math.round(v.hit / v.total * 100)}%`).join(' · ')}
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

      {rulePerf.length > 0 && (
        <div className="feed-rule-perf">
          <span>规则复盘</span>
          {rulePerf.map(row => (
            <button
              key={row.ruleId}
              className={row.rate < 40 ? 'weak' : row.rate >= 60 ? 'good' : ''}
              title={`${row.label}：${row.total} 条，命中 ${row.hit} 条`}
              onClick={() => setSymbolFilter(row.label)}
            >
              {row.label} {row.rate}%
            </button>
          ))}
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
                  {item.feedback && <span className="feed-feedback-badge">{item.feedback}</span>}
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

            <div className="review-actions feedback-actions">
              {['有用', '噪音', '太早', '太晚'].map(label => (
                <button
                  key={label}
                  className={`zone-btn ${selectedItem.feedback === label ? 'filtered' : ''}`}
                  onClick={() => markFeedback(label)}
                >
                  {label}
                </button>
              ))}
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

      {chartAsset && (
        <Suspense fallback={null}>
          <ChartModal asset={chartAsset} alertItem={selectedItem} onClose={() => setChartAsset(null)} />
        </Suspense>
      )}
    </div>
  )
}
