import { lazy, Suspense, useDeferredValue, useEffect, useRef, useState, useMemo } from 'react'
import useMarketStore   from './store/marketStore'
import useAlertStore    from './store/alertStore'
import useSettingsStore from './store/settingsStore'
import useGroupsStore   from './store/groupsStore'
import useSignalTrailStore from './store/signalTrailStore'
import useWatchPoolStore from './store/watchPoolStore'
import useSignalReviewStore from './store/signalReviewStore'
import useShadowStrategyStore from './store/shadowStrategyStore'
import useRuleDriftStore from './store/ruleDriftStore'
import { isUSMarketOpen } from './utils/marketHours'
import { playAlertSound } from './utils/sound'
import { sendWebhooks }  from './utils/webhook'
import { getRsiZone }   from './utils/rsi'
import { matchesAssetRef, underlyingKey } from './utils/assetKey'
import { applyLiquidityLimit, getQuoteVolume } from './utils/liquidity'
import { buildCandidates, candidateSignature, makeAiFeedItems } from './utils/aiCandidates'
import { advanceSignalLifecycleItems } from './utils/signalLifecycle'
import Toolbar      from './components/Toolbar'
const Heatmap = lazy(() => import('./components/Heatmap'))
const StatsTable = lazy(() => import('./components/StatsTable'))
const ManagePage = lazy(() => import('./components/ManagePage'))
const AlertPage = lazy(() => import('./components/AlertPage'))
const AlertEventPage = lazy(() => import('./components/AlertEventPage'))
const AlertFeed = lazy(() => import('./components/AlertFeed'))
const SettingsPage = lazy(() => import('./components/SettingsPage'))
const AiPage = lazy(() => import('./components/AiPage'))
const SignalTrailPage = lazy(() => import('./components/SignalTrailPage'))
const AiReviewPage = lazy(() => import('./components/AiReviewPage'))
const LaunchReviewPage = lazy(() => import('./components/LaunchReviewPage'))
const SignalReviewPage = lazy(() => import('./components/SignalReviewPage'))
const MarketChatPage = lazy(() => import('./components/MarketChatPage'))
const WatchPoolPage = lazy(() => import('./components/WatchPoolPage'))
const OpportunityPage = lazy(() => import('./components/OpportunityPage'))
const SignalHunterPage = lazy(() => import('./components/SignalHunterPage'))
const AssetWorkspacePage = lazy(() => import('./components/AssetWorkspacePage'))
const CrossMarketAuditPage = lazy(() => import('./components/CrossMarketAuditPage'))
const CompanyEventsPage = lazy(() => import('./components/CompanyEventsPage'))
const DataGapPage = lazy(() => import('./components/DataGapPage'))
const RuntimeCenterPage = lazy(() => import('./components/RuntimeCenterPage'))

function LazyFallback({ label = '正在加载...' }) {
  return <div className="lazy-fallback">{label}</div>
}

function isSilentHours(start, end) {
  if (!start || !end) return false
  const now = new Date()
  const cur = now.getHours() * 60 + now.getMinutes()
  const [sh, sm] = start.split(':').map(Number)
  const [eh, em] = end.split(':').map(Number)
  const s = sh * 60 + sm, e = eh * 60 + em
  return s <= e ? cur >= s && cur < e : cur >= s || cur < e
}

function lifecycleTransitionReason(state) {
  return {
    triggered: '闭合K线已确认冻结计划触发',
    stopped: '冻结计划已触及失效位',
    completed: '冻结计划全部目标已完成',
    expired: '冻结计划未触发并已过期',
    ambiguous: '同K线触及目标与失效位，顺序不明',
  }[state] ?? 'Signal Hunter 生命周期已更新'
}

function matchesStrategy(cfg, sig, observation = false) {
  if (!sig || sig.direction === 'neutral') return false
  if (observation) return true
  const strategies = Array.isArray(cfg.strategies)
    ? cfg.strategies
    : cfg.strategy
      ? [cfg.strategy]
      : cfg.volumeSignal
        ? ['breakout', 'breakdown', 'volume_divergence']
        : []
  if (!strategies.length) return !!cfg.volumeSignal
  return strategies.some(strategy => {
    if (strategy === 'volume_structure') return !!cfg.volumeSignal
    if (strategy === 'breakout') return sig.type === 'breakout_confirmed'
    if (strategy === 'breakdown') return sig.type === 'breakdown_confirmed'
    if (strategy === 'volume_divergence') return ['bearish_volume_divergence', 'bullish_seller_exhaustion'].includes(sig.type)
    return false
  })
}

function rsiMargin(mode) {
  if (mode === 'strict') return 2
  if (mode === 'loose') return -2
  return 0
}

function defaultLevelForTimeframe(tf) {
  if (tf === '1d') return 3
  if (tf === '4h') return 2
  return 1
}

function observationTimeframes(tfs, enabled) {
  if (!enabled) return tfs
  const next = new Set(tfs)
  next.add('1h')
  return [...next]
}

function slowOversoldStage(asset, prev, tf, threshold, strong) {
  const rsi = asset.rsi?.[tf]
  const prevRsi = prev?.rsi?.[tf]
  if (rsi == null) return null
  if (prevRsi != null && prevRsi > threshold && rsi <= threshold) {
    return { key: 'enter', label: '初次进入低位', level: rsi <= strong ? 1 : 0 }
  }
  if (prevRsi != null && rsi > prevRsi + 1.5 && rsi <= threshold + 6) {
    const priceHeld = asset.price != null && prev?.price != null && asset.price >= prev.price * 0.995
    const score = Math.abs(asset.signalScore?.[tf] ?? 0)
    const hasStructure = score >= 1 || !!asset.volumeSignal?.[tf] || !!asset.divergence?.[tf]
    if (!priceHeld && !hasStructure) return null
    return {
      key: priceHeld && hasStructure ? 'rsi_lift_price_hold_structure' : priceHeld ? 'rsi_lift_price_hold' : 'rsi_lift_structure',
      label: priceHeld && hasStructure ? '价格未破低且 RSI 抬高，结构改善' : priceHeld ? '价格未破低且 RSI 抬高' : 'RSI 低位回升且结构改善',
      level: 1,
    }
  }
  if (rsi <= strong) return { key: 'deep', label: '深度低位', level: 1 }
  return { key: 'base', label: '持续低位横盘', level: 0 }
}

function findSlowOversoldSignals(assets, prevAssets, now, notified) {
  const candidates = assets
    .filter(a => a.type === 'crypto' || a.type === 'tradfi')
    .filter(a => getQuoteVolume(a) >= 1_000_000)
    .filter(a => Math.abs(a.change24h ?? 0) <= 8)

  const top = applyLiquidityLimit(candidates, 160)
  const out = []
  for (const asset of top) {
    const prev = prevAssets?.find(a => matchesAssetRef(a, asset.symbol))
    for (const rule of [
      { tf: '4h', threshold: 35, strong: 32 },
      { tf: '1d', threshold: 38, strong: 35 },
    ]) {
      const rsi = asset.rsi?.[rule.tf]
      if (rsi == null || rsi > rule.threshold) continue
      const prevRsi = prev?.rsi?.[rule.tf]
      const stage = slowOversoldStage(asset, prev, rule.tf, rule.threshold, rule.strong)
      if (!stage) continue
      const changedEnough = prevRsi == null || prevRsi > rule.threshold || Math.abs(prevRsi - rsi) >= 1.5 || stage.level >= 1
      if (!changedEnough) continue
      const key = `${asset.symbol}|${rule.tf}|slow_oversold|${stage.key}`
      if (now - (notified[key] ?? 0) < 12 * 60 * 60 * 1000) continue
      notified[key] = now
      out.push({
        id: `slow-rsi-${asset.symbol}-${rule.tf}-${now}`,
        ts: now,
        symbol: asset.symbol,
        type: 'rsi',
        timeframe: rule.tf,
        condition: 'below',
        signal: `慢速超卖观察 · ${stage.label}`,
        threshold: rule.threshold,
        value: rsi,
        price: asset.price,
        change24h: asset.change24h,
        level: stage.level,
        reason: `${rule.tf} ${stage.label}，RSI ${rsi.toFixed(1)}，24H 波动不剧烈，适合加入观察而不是追急跌。`,
      })
      if (out.length >= 8) return out
    }
  }
  return out
}

function findWatchPoolReviewSignals(watchItems, assets, now, notified) {
  const out = []
  for (const item of watchItems) {
    if (item.status === 'ignore') continue
    const enteredAt = item.firstSeenAt ?? item.lastSeenAt
    if (!enteredAt || now - enteredAt < 36 * 60 * 60 * 1000) continue
    const asset = assets.find(a => matchesAssetRef(a, item.symbol))
    if (!asset) continue
    const move = Math.abs(asset.change24h ?? 0)
    const rsi4h = asset.rsi?.['4h']
    const rsi1d = asset.rsi?.['1d']
    const cooled = move <= 6
    const rsiNormalized = (rsi4h != null && rsi4h >= 38 && rsi4h <= 58) || (rsi1d != null && rsi1d >= 38 && rsi1d <= 58)
    const stillLiquid = getQuoteVolume(asset) >= 1_000_000
    if (!cooled || !rsiNormalized || !stillLiquid) continue
    const key = `${item.symbol}|watch_pool_review`
    if (now - (notified[key] ?? 0) < 24 * 60 * 60 * 1000) continue
    notified[key] = now
    out.push({
      id: `watch-pool-review-${item.symbol}-${now}`,
      ts: now,
      symbol: item.symbol,
      type: 'watch_pool',
      condition: 'cooled',
      signal: '观察池冷却复看',
      value: rsi4h ?? rsi1d ?? null,
      price: asset.price,
      change24h: asset.change24h,
      level: item.status === 'interesting' ? 1 : 0,
      reason: `已冷却 ${Math.floor((now - enteredAt) / 864e5)} 天，24H 波动收敛到 ${asset.change24h?.toFixed?.(2) ?? '-'}%，RSI 回到可复看区间。`,
    })
    if (out.length >= 8) return out
  }
  return out
}

function buildStartupHealthReport(assets, timeframe = '4h') {
  const valid = assets.filter(a => a.rsi?.[timeframe] != null)
  if (!valid.length) return null
  const oversold = valid.filter(a => a.rsi[timeframe] <= 30).length
  const low = valid.filter(a => a.rsi[timeframe] > 30 && a.rsi[timeframe] <= 40).length
  const overbought = valid.filter(a => a.rsi[timeframe] >= 70).length
  const volatile = valid.filter(a => Math.abs(a.change24h ?? 0) >= 12).length
  const up = valid.filter(a => (a.change24h ?? 0) > 0).length
  const avg = valid.reduce((sum, a) => sum + a.rsi[timeframe], 0) / valid.length
  const mood = avg <= 42 ? '偏弱，低位标的较多'
    : avg >= 58 ? '偏强，注意追高风险'
      : '中性，适合等待结构信号'
  return {
    id: `startup-health-${Date.now()}`,
    symbol: 'MARKET',
    type: 'market_report',
    condition: 'startup',
    signal: '启动健康报告',
    value: Number(avg.toFixed(1)),
    level: 0,
    reason: `${timeframe} 均值 RSI ${avg.toFixed(1)}，超卖 ${oversold}，低位 ${low}，超买 ${overbought}，剧烈波动 ${volatile}，上涨 ${Math.round(up / valid.length * 100)}%；市场${mood}。`,
  }
}

function getTodayPicks({ assets, feed, watchPoolItems }) {
  const picks = []
  const push = (item) => {
    if (!item?.symbol || picks.some(p => p.symbol === item.symbol && p.type === item.type)) return
    picks.push(item)
  }

  const liquid = applyLiquidityLimit(
    assets.filter(a => (a.type === 'crypto' || a.type === 'tradfi') && getQuoteVolume(a) >= 1_000_000),
    220
  )

  liquid
    .filter(a => Math.abs(a.change24h ?? 0) <= 8)
    .filter(a => (a.rsi?.['4h'] ?? 100) <= 35 || (a.rsi?.['1d'] ?? 100) <= 38)
    .sort((a, b) => Math.min(a.rsi?.['4h'] ?? 100, a.rsi?.['1d'] ?? 100) - Math.min(b.rsi?.['4h'] ?? 100, b.rsi?.['1d'] ?? 100))
    .slice(0, 4)
    .forEach(a => push({
      type: 'opportunity',
      symbol: a.symbol,
      label: '慢速低位',
      detail: `4h ${a.rsi?.['4h']?.toFixed?.(1) ?? '-'} / 1d ${a.rsi?.['1d']?.toFixed?.(1) ?? '-'}`,
      tone: 'green',
    }))

  watchPoolItems
    .filter(i => i.status === 'interesting' || i.status === 'watch')
    .map(i => {
      const asset = assets.find(a => matchesAssetRef(a, i.symbol))
      if (!asset) return null
      const ageH = (Date.now() - (i.firstSeenAt ?? i.lastSeenAt ?? Date.now())) / 36e5
      const cooled = ageH >= 36 && Math.abs(asset.change24h ?? 0) <= 6
      const rsiOk = ((asset.rsi?.['4h'] ?? 0) >= 38 && (asset.rsi?.['4h'] ?? 100) <= 58)
        || ((asset.rsi?.['1d'] ?? 0) >= 38 && (asset.rsi?.['1d'] ?? 100) <= 58)
      return cooled && rsiOk ? { item: i, asset } : null
    })
    .filter(Boolean)
    .slice(0, 3)
    .forEach(({ item, asset }) => push({
      type: 'cooldown',
      symbol: item.symbol,
      label: '观察池复看',
      detail: `24H ${asset.change24h?.toFixed?.(2) ?? '-'}%`,
      tone: 'blue',
    }))

  feed
    .filter(i => i.type === 'ai' && (i.condition === 'focus' || i.value >= 80))
    .slice(0, 3)
    .forEach(i => push({
      type: 'ai',
      symbol: i.symbol,
      label: 'AI重点',
      detail: `置信 ${i.value ?? '-'}`,
      tone: 'orange',
    }))

  liquid
    .filter(a => Math.abs(a.change24h ?? 0) >= 12 || (a.rsi?.['4h'] ?? 50) >= 76 || (a.rsi?.['4h'] ?? 50) <= 24)
    .slice(0, 3)
    .forEach(a => push({
      type: 'risk',
      symbol: a.symbol,
      label: '风险集中',
      detail: `24H ${a.change24h?.toFixed?.(2) ?? '-'}%`,
      tone: 'red',
    }))

  return picks.slice(0, 8)
}

function findVolatileWatchPoolEntries(assets, prevAssets, now) {
  const out = []
  for (const asset of assets) {
    if (asset.type !== 'crypto' && asset.type !== 'tradfi') continue
    const turnover = getQuoteVolume(asset)
    if (turnover < 1_000_000) continue
    const move = asset.change24h ?? 0
    const absMove = Math.abs(move)
    const shortHot = (asset.rsi?.['15m'] ?? 50) >= 80 || (asset.rsi?.['1h'] ?? 50) >= 80
    const shortCold = (asset.rsi?.['15m'] ?? 50) <= 20 || (asset.rsi?.['1h'] ?? 50) <= 20
    const violent = absMove >= 12 || shortHot || shortCold
    if (!violent) continue
    const prev = prevAssets?.find(a => matchesAssetRef(a, asset.symbol))
    const prevMove = Math.abs(prev?.change24h ?? 0)
    if (prev && prevMove >= 12 && absMove >= 12 && Math.abs(prevMove - absMove) < 2 && !shortHot && !shortCold) continue
    const reasons = []
    if (absMove >= 12) reasons.push(`24H ${move >= 0 ? '上涨' : '下跌'} ${move.toFixed(2)}%`)
    if (shortHot) reasons.push('短周期 RSI 过热')
    if (shortCold) reasons.push('短周期 RSI 过冷')
    out.push({
      symbol: asset.symbol,
      source: 'auto',
      reason: reasons.join('，'),
      ts: now,
      snapshot: {
        price: asset.price,
        change24h: asset.change24h,
        rsi: asset.rsi,
        turnover,
        signalScore: asset.signalScore,
      },
    })
  }
  return out.slice(0, 30)
}

function StatusBanner() {
  const events = useMarketStore(s => s.statusEvents)
  const clearStatus = useMarketStore(s => s.clearStatus)
  const [open, setOpen] = useState(false)
  if (!events.length) return null
  const latest = events[0]
  return (
    <div className="status-banner">
      <span>数据状态：{latest.scope} - {latest.message}</span>
      {events.length > 1 && <span className="status-count">另有 {events.length - 1} 条</span>}
      <button onClick={() => setOpen(true)}>详情</button>
      <button onClick={clearStatus}>清除</button>
      {open && (
        <div className="status-overlay" onClick={() => setOpen(false)}>
          <div className="status-panel" onClick={e => e.stopPropagation()}>
            <div className="review-head">
              <strong>异常提醒中心</strong>
              <button className="chart-modal-close" onClick={() => setOpen(false)}>×</button>
            </div>
            <div className="status-list">
              {events.map((e, i) => (
                <div key={`${e.ts}-${i}`} className="status-row">
                  <b>{e.scope}</b>
                  <span>{e.message}</span>
                  <em>{new Date(e.ts).toLocaleTimeString('zh-CN')}</em>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
/* 鈹€鈹€ Summary stat cards 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€ */
const ZONE_COLORS = {
  overbought: '#ef4444', strong: '#f97316',
  neutral: '#64748b', weak: '#4ade80', oversold: '#22c55e',
}
const ZONE_LABELS = {
  overbought: '超买', strong: '强势', neutral: '中性', weak: '弱势', oversold: '超卖',
}
const APP_VERSION = 'v1.2.4'

function normalizeVersionTag(v) {
  return String(v || '').trim().replace(/^v/i, '')
}

function isNewerVersion(candidate, current) {
  const a = normalizeVersionTag(candidate).split('.').map(value => Number(value) || 0)
  const b = normalizeVersionTag(current).split('.').map(value => Number(value) || 0)
  for (let index = 0; index < Math.max(a.length, b.length); index++) {
    if ((a[index] ?? 0) !== (b[index] ?? 0)) return (a[index] ?? 0) > (b[index] ?? 0)
  }
  return false
}

function SummaryBar({ assets, timeframe }) {
  const counts = useMemo(() => {
    const valid = assets.filter(a => a.rsi[timeframe] != null)
    if (!valid.length) return null
    const t = { overbought: 0, strong: 0, neutral: 0, weak: 0, oversold: 0 }
    for (const a of valid) { const z = getRsiZone(a.rsi[timeframe]); if (z) t[z]++ }
    return { t, total: valid.length }
  }, [assets, timeframe])

  if (!counts) return null
  const { t, total } = counts
  const ob  = t.overbought
  const os  = t.oversold
  const up  = assets.filter(a => (a.change24h ?? 0) > 0).length
  const avg = assets.length
    ? (assets.reduce((s, a) => s + (a.rsi[timeframe] ?? 50), 0) / assets.length).toFixed(1)
    : '-'

  const StatCard = ({ label, value, sub, color, bg }) => (
    <div style={{
      padding: '8px 14px',
      background: bg,
      border: `1px solid ${color}22`,
      borderRadius: 10,
      display: 'flex', flexDirection: 'column', gap: 2,
      minWidth: 72, flexShrink: 0,
    }}>
      <span style={{ fontSize: 10, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.05em', fontWeight: 600 }}>
        {label}
      </span>
      <span style={{ fontSize: 22, fontWeight: 700, color, lineHeight: 1.1, fontVariantNumeric: 'tabular-nums' }}>
        {value}
      </span>
      {sub && <span style={{ fontSize: 10, color: 'var(--dim)' }}>{sub}</span>}
    </div>
  )

  return (
    <div style={{ display: 'flex', gap: 8, flexShrink: 0, alignItems: 'stretch' }}>
      {/* Average RSI gauge */}
      <div style={{
        padding: '8px 14px', background: 'var(--bg2)',
        border: '1px solid var(--border)', borderRadius: 10,
        display: 'flex', flexDirection: 'column', gap: 3, minWidth: 90,
      }}>
        <span style={{ fontSize: 10, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.05em', fontWeight: 600 }}>
          均值 RSI
        </span>
        <span style={{ fontSize: 22, fontWeight: 700, color: 'var(--text)', lineHeight: 1.1, fontVariantNumeric: 'tabular-nums' }}>
          {avg}
        </span>
        <span style={{ fontSize: 10, color: 'var(--dim)' }}>{total} 个品种</span>
      </div>

      <StatCard label="超买" value={ob} sub={`≥70`}       color="#ef4444" bg="rgba(239,68,68,0.07)" />
      <StatCard label="超卖" value={os} sub={`≤30`}       color="#22c55e" bg="rgba(34,197,94,0.07)" />
      <StatCard label="上涨" value={up} sub={`${Math.round(up/assets.length*100)}%`} color="#22c55e" bg="rgba(34,197,94,0.05)" />
      <StatCard label="下跌" value={assets.length-up} sub={`${Math.round((assets.length-up)/assets.length*100)}%`} color="#ef4444" bg="rgba(239,68,68,0.05)" />

      {/* Sentiment bar */}
      <div style={{
        flex: 1, padding: '8px 14px',
        background: 'var(--bg2)', border: '1px solid var(--border)',
        borderRadius: 10, display: 'flex', flexDirection: 'column', justifyContent: 'center', gap: 5,
        minWidth: 160,
      }}>
        <span style={{ fontSize: 10, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.05em', fontWeight: 600 }}>
          市场情绪分布
        </span>
        <div style={{
          height: 7, borderRadius: 4, overflow: 'hidden',
          display: 'flex', gap: 1, background: 'var(--bg4)',
        }}>
          {Object.entries(t).map(([zone, n]) => n > 0 && (
            <div key={zone} style={{ flex: n, background: ZONE_COLORS[zone], borderRadius: 2 }} />
          ))}
        </div>
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
          {Object.entries(t).map(([zone, n]) => n > 0 && (
            <div key={zone} style={{ display: 'flex', alignItems: 'center', gap: 3 }}>
              <div style={{ width: 5, height: 5, borderRadius: '50%', background: ZONE_COLORS[zone] }} />
              <span style={{ fontSize: 9, color: ZONE_COLORS[zone] }}>
                {ZONE_LABELS[zone]}&nbsp;{n}
              </span>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

function TodayPicks({ picks, onSelect }) {
  if (!picks.length) return null
  return (
    <div className="today-picks">
      <div className="today-picks-head">
        <b>今日值得看</b>
        <span>{picks.length} 个线索</span>
      </div>
      <div className="today-picks-list">
        {picks.map(item => (
          <button
            key={`${item.type}-${item.symbol}`}
            className={`today-pick today-pick-${item.tone}`}
            onClick={() => onSelect(item.symbol)}
            title={item.detail}
          >
            <b>{item.symbol}</b>
            <span>{item.label}</span>
            <em>{item.detail}</em>
          </button>
        ))}
      </div>
    </div>
  )
}
/* 鈹€鈹€ Main App 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€ */
export default function App() {
  const fetchData  = useMarketStore(s => s.fetchData)
  const loading    = useMarketStore(s => s.loading)
  const error      = useMarketStore(s => s.error)
  const assets     = useMarketStore(s => s.assets)
  const updatedAt  = useMarketStore(s => s.updatedAt)
  const completedAt = useMarketStore(s => s.completedAt)
  const completedMeta = useMarketStore(s => s.completedMeta)
  const setFlash   = useMarketStore(s => s.setFlash)
  const applySignalHunterAiResults = useMarketStore(s => s.applySignalHunterAiResults)
  const filter     = useMarketStore(s => s.filter)
  const timeframe  = useMarketStore(s => s.timeframe)
  const hasData    = assets.length > 0

  const configs         = useAlertStore(s => s.configs)
  const feed            = useAlertStore(s => s.feed)
  const updateLastFired = useAlertStore(s => s.updateLastFired)
  const addFeedItems    = useAlertStore(s => s.addFeedItems)
  const updateFeed      = useAlertStore(s => s.updateFeed)
  const loadAlerts      = useAlertStore(s => s.load)
  const syncFollowTop   = useAlertStore(s => s.syncFollowTop)
  const addWatchPool    = useWatchPoolStore(s => s.addOrUpdate)
  const cleanupWatchPool = useWatchPoolStore(s => s.cleanup)
  const watchPoolItems  = useWatchPoolStore(s => s.items)

  const {
    refreshInterval, alertCooldown, levelCooldowns, popupEnabled, soundEnabled,
    silentStart, silentEnd, telegramToken, telegramChatId, discordWebhook,
    popupMinLevel, soundMinLevel, webhookMinLevel, autoCheckUpdates,
    webhookAiOnly,
    observationEnabled, rsiSensitivity, startupStateAlerts,
    autoAiEnabled, autoAiInterval, autoAiLimit, autoAiStartupDelay,
    watchPoolRetentionDays, themeMode, shNightlyReplayEnabled,
    loaded: settingsLoaded, load: loadSettings,
  } = useSettingsStore()

  const configsRef    = useRef(configs)
  const assetsRef     = useRef(assets)
  const prevAssetsRef = useRef(null)
  const cooldownRef   = useRef(alertCooldown * 60 * 60 * 1000)
  const levelCooldownRef = useRef(levelCooldowns)
  const popupRef      = useRef(popupEnabled)
  const soundRef      = useRef(soundEnabled)
  const silentRef     = useRef({ start: silentStart, end: silentEnd })
  const webhookRef    = useRef({ telegramToken, telegramChatId, discordWebhook, webhookAiOnly })
  const minLevelRef   = useRef({ popup: popupMinLevel, sound: soundMinLevel, webhook: webhookMinLevel })
  const alertModeRef  = useRef({ observationEnabled, rsiSensitivity, startupStateAlerts })
  const autoAiRef     = useRef({ enabled: autoAiEnabled, interval: autoAiInterval, limit: autoAiLimit, startupDelay: autoAiStartupDelay })
  const aiRunRef      = useRef({ busy: false, lastRun: 0, lastSignature: '', notified: {} })
  const slowRsiRef    = useRef({})
  const watchPoolReviewRef = useRef({})
  const backgroundScanRef = useRef({ slowRsiAt: 0, watchPoolAt: 0 })
  const startupReportRef = useRef(false)
  const signalLifecycleRef = useRef(null)
  const nightlyReplayRef = useRef(false)
  useEffect(() => {
    const applyTheme = () => {
      const systemDark = window.matchMedia?.('(prefers-color-scheme: dark)').matches
      const resolved = themeMode === 'system' ? (systemDark ? 'dark' : 'light') : (themeMode || 'light')
      document.documentElement.dataset.theme = resolved
    }
    applyTheme()
    if (themeMode !== 'system' || !window.matchMedia) return
    const media = window.matchMedia('(prefers-color-scheme: dark)')
    media.addEventListener?.('change', applyTheme)
    return () => media.removeEventListener?.('change', applyTheme)
  }, [themeMode])
  const appStartedAtRef = useRef(Date.now())
  configsRef.current  = configs
  assetsRef.current   = assets
  cooldownRef.current = alertCooldown * 60 * 60 * 1000
  levelCooldownRef.current = levelCooldowns
  popupRef.current    = popupEnabled
  soundRef.current    = soundEnabled
  silentRef.current   = { start: silentStart, end: silentEnd }
  webhookRef.current  = { telegramToken, telegramChatId, discordWebhook, webhookAiOnly }
  minLevelRef.current = { popup: popupMinLevel, sound: soundMinLevel, webhook: webhookMinLevel }
  alertModeRef.current = { observationEnabled, rsiSensitivity, startupStateAlerts }
  autoAiRef.current = { enabled: autoAiEnabled, interval: autoAiInterval, limit: autoAiLimit, startupDelay: autoAiStartupDelay }

  const focusSearch  = useMarketStore(s => s.focusSearch)
  const setTimeframe = useMarketStore(s => s.setTimeframe)
  const [activeTab, setActiveTab] = useState('market')
  const [updateInfo, setUpdateInfo] = useState(null)
  const [chatOpen, setChatOpen] = useState(false)
  const [aiPlanRequest, setAiPlanRequest] = useState(null)

  const loadGroups = useGroupsStore(s => s.load)
  const updateSignalTrail = useSignalTrailStore(s => s.updateFromAssets)
  const hydrateSignalTrail = useSignalTrailStore(s => s.hydrate)
  const syncSignalReviews = useSignalReviewStore(s => s.syncFromAssets)
  const updateSignalReviews = useSignalReviewStore(s => s.updateFromAssets)
  const hydrateSignalReviews = useSignalReviewStore(s => s.hydrate)
  const hydrateWatchPool = useWatchPoolStore(s => s.hydrate)
  const hydrateStatusEvents = useMarketStore(s => s.hydrateStatusEvents)
  const hydrateShadowStrategy = useShadowStrategyStore(s => s.hydrate)
  const recordShadowStrategy = useShadowStrategyStore(s => s.recordFromAssets)
  const hydrateRuleDrift = useRuleDriftStore(s => s.hydrate)
  const recordRuleDrift = useRuleDriftStore(s => s.recordFromAssets)

  useEffect(() => {
    loadSettings()
    loadAlerts()
    loadGroups()
    hydrateSignalTrail()
    hydrateSignalReviews()
    hydrateWatchPool()
    hydrateStatusEvents()
    hydrateShadowStrategy()
    hydrateRuleDrift()
  }, [])

  useEffect(() => {
    const TF_KEYS = { '1': '15m', '2': '1h', '3': '4h', '4': '1d' }
    const onKey = e => {
      if (activeTab !== 'market') return
      if (e.ctrlKey && e.key === 'f') { e.preventDefault(); focusSearch(); return }
      if (!e.ctrlKey && !e.altKey && !e.metaKey && TF_KEYS[e.key]) {
        const tag = e.target.tagName
        if (tag === 'INPUT' || tag === 'TEXTAREA') return
        setTimeframe(TF_KEYS[e.key])
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [activeTab, focusSearch, setTimeframe])

  useEffect(() => {
    if (!settingsLoaded) return
    const fullFetch = () => fetchData({ scope: 'scheduled-full' })
    const timers = []
    fetchData({ timeframes: ['4h'], limit: 50, scope: 'startup-top50-4h', suppressAlerts: true })
    timers.push(setTimeout(() => {
      fetchData({ timeframes: ['15m', '1h', '1d'], limit: 50, scope: 'startup-top50-rest', suppressAlerts: true })
    }, 2 * 60 * 1000))
    timers.push(setTimeout(() => {
      fetchData({ timeframes: ['15m', '1h', '4h', '1d'], scope: 'startup-full', suppressAlerts: true })
    }, 5 * 60 * 1000))
    const intervalDelay = Math.max(refreshInterval * 60 * 1000, 6 * 60 * 1000)
    timers.push(setTimeout(() => {
      fullFetch()
      const interval = setInterval(fullFetch, refreshInterval * 60 * 1000)
      timers.push(interval)
    }, intervalDelay))
    return () => timers.forEach(clearTimeout)
  }, [refreshInterval, settingsLoaded])

  useEffect(() => {
    if (!settingsLoaded || !autoCheckUpdates) return
    window.api.checkForUpdates?.(false)
      .then(info => {
        if (info?.tag && isNewerVersion(info.tag, APP_VERSION)) setUpdateInfo(info)
      })
      .catch(err => console.warn('[update-check]', err))
  }, [settingsLoaded, autoCheckUpdates])

  useEffect(() => {
    return window.api.onFocusSymbol(symbol => {
      setActiveTab('market')
      setFlash(symbol)
    })
  }, [])

  useEffect(() => {
    if (!completedAt) return
    const startupStateCheck = completedMeta?.scope === 'startup-full' && alertModeRef.current.startupStateAlerts
    if (completedMeta?.suppressAlerts && !startupStateCheck) {
      prevAssetsRef.current = [...assetsRef.current]
      return
    }
    if (!prevAssetsRef.current) {
      prevAssetsRef.current = [...assetsRef.current]
      return
    }

    const now = Date.now()
    const fired = []
    const firedBatchKeys = new Set()
    const marketOpen = isUSMarketOpen()
    const margin = rsiMargin(alertModeRef.current.rsiSensitivity)
    const observationOn = alertModeRef.current.observationEnabled
    const legacyAlertsEnabled = false
    if (completedMeta?.scope === 'startup-full' && !startupReportRef.current) {
      const report = buildStartupHealthReport(assetsRef.current, '4h')
      if (report) fired.push(report)
      startupReportRef.current = true
    }
    findVolatileWatchPoolEntries(assetsRef.current, prevAssetsRef.current, now)
      .forEach(entry => addWatchPool(entry))
    cleanupWatchPool(watchPoolRetentionDays)
    const cooldownFor = level => {
      const hours = levelCooldownRef.current?.[level] ?? alertCooldown
      return hours * 60 * 60 * 1000
    }

    const followLimit = configsRef.current.find(c => c.followTop)?.followTopLimit
    if (followLimit) {
      const candidates = assetsRef.current
        .filter(a => a.type === 'crypto' || a.type === 'tradfi')
        .filter(a => a.rsi?.['4h'] != null || a.rsi?.['1d'] != null)
      const topSymbols = applyLiquidityLimit(candidates, followLimit).map(a => a.symbol)
      if (topSymbols.length >= followLimit) syncFollowTop(topSymbols)
    }

    const collect = (cfg, key, notifData) => {
      const batchKey = [
        notifData.symbol,
        notifData.timeframe ?? '24h',
        notifData.type,
        notifData.signal ?? notifData.condition ?? key,
      ].join('|')
      if (firedBatchKeys.has(batchKey)) return
      const level = notifData.level ?? cfg.alertLevel ?? (cfg.special ? 3 : 1)
      if (now - (cfg.lastFired?.[key] ?? 0) < cooldownFor(level)) return
      updateLastFired(cfg.id, key)
      firedBatchKeys.add(batchKey)
      fired.push({
        ...notifData,
        ruleId: cfg.id,
        ruleSymbol: cfg.symbol,
        ruleLevel: cfg.alertLevel ?? (cfg.special ? 3 : 1),
        level,
        special: level >= 2,
      })
    }

    for (const cfg of configsRef.current) {
      if (!cfg.enabled) continue
      const asset = assetsRef.current.find(a => matchesAssetRef(a, cfg.symbol))
      if (!asset) continue
      if (asset.source === 'yahoo' && !marketOpen) continue

      const prev = prevAssetsRef.current.find(a => matchesAssetRef(a, cfg.symbol))
      if (!prev) continue

      const tfs = cfg.timeframes ?? []
      const observeTfs = observationTimeframes(tfs, observationOn)
      const ctx = { price: asset.price, change24h: asset.change24h }
      const c = (key, nd) => collect(cfg, key, { ...ctx, ...nd })

      for (const tf of tfs) {
        const rsi     = asset.rsi?.[tf]
        const prevRsi = prev.rsi?.[tf]
        if (rsi == null || prevRsi == null) continue
        if (cfg.rsiAbove != null && rsi > cfg.rsiAbove + margin && (startupStateCheck || prevRsi <= cfg.rsiAbove))
          c(`${tf}_rsi_above`, { symbol: cfg.symbol, type: 'rsi', timeframe: tf, condition: 'above', threshold: cfg.rsiAbove, value: rsi, level: cfg.alertLevel ?? defaultLevelForTimeframe(tf) })
        if (cfg.rsiBelow != null && rsi < cfg.rsiBelow - margin && (startupStateCheck || prevRsi >= cfg.rsiBelow))
          c(`${tf}_rsi_below`, { symbol: cfg.symbol, type: 'rsi', timeframe: tf, condition: 'below', threshold: cfg.rsiBelow, value: rsi, level: cfg.alertLevel ?? defaultLevelForTimeframe(tf) })
      }

      if (observationOn) {
        for (const tf of observeTfs) {
          const rsi = asset.rsi?.[tf]
          if (rsi == null) continue
          if (cfg.rsiAbove != null && rsi > cfg.rsiAbove + margin) {
            c(`${tf}_rsi_above_observe`, {
              symbol: cfg.symbol,
              type: 'rsi',
              timeframe: tf,
              condition: 'above',
              threshold: cfg.rsiAbove,
              value: rsi,
              level: 0,
            })
          }
          if (cfg.rsiBelow != null && rsi < cfg.rsiBelow - margin) {
            c(`${tf}_rsi_below_observe`, {
              symbol: cfg.symbol,
              type: 'rsi',
              timeframe: tf,
              condition: 'below',
              threshold: cfg.rsiBelow,
              value: rsi,
              level: 0,
            })
          }
        }
      }

      if (cfg.requireAllTf && tfs.length > 1) {
        if (cfg.rsiAbove != null) {
          const allNow  = tfs.every(tf => (asset.rsi?.[tf] ?? 0)   > cfg.rsiAbove + margin)
          const allPrev = tfs.every(tf => (prev.rsi?.[tf]  ?? 0)   > cfg.rsiAbove)
          if (allNow && (startupStateCheck || !allPrev))
            c('rsi_above_resonance', { symbol: cfg.symbol, type: 'rsi', timeframe: tfs.join('+'), condition: 'above', threshold: cfg.rsiAbove, value: Math.max(...tfs.map(tf => asset.rsi?.[tf] ?? 0)), special: true })
        }
        if (cfg.rsiBelow != null) {
          const allNow  = tfs.every(tf => (asset.rsi?.[tf] ?? 100) < cfg.rsiBelow - margin)
          const allPrev = tfs.every(tf => (prev.rsi?.[tf]  ?? 100) < cfg.rsiBelow)
          if (allNow && (startupStateCheck || !allPrev))
            c('rsi_below_resonance', { symbol: cfg.symbol, type: 'rsi', timeframe: tfs.join('+'), condition: 'below', threshold: cfg.rsiBelow, value: Math.min(...tfs.map(tf => asset.rsi?.[tf] ?? 100)), special: true })
        }
      }

      const change = asset.change24h, prevChange = prev.change24h
      if (change != null && prevChange != null) {
        if (cfg.changeAbove != null && change > cfg.changeAbove && prevChange <= cfg.changeAbove)
          c('change_above', { symbol: cfg.symbol, type: 'change', condition: 'above', threshold: cfg.changeAbove, value: change })
        if (cfg.changeBelow != null && change < -cfg.changeBelow && prevChange >= -cfg.changeBelow)
          c('change_below', { symbol: cfg.symbol, type: 'change', condition: 'below', threshold: -cfg.changeBelow, value: change })
      }

      const price = asset.price, prevPrice = prev.price
      if (price != null && prevPrice != null) {
        if (cfg.priceAbove != null && price > cfg.priceAbove && prevPrice <= cfg.priceAbove)
          c('price_above', { symbol: cfg.symbol, type: 'price', condition: 'above', threshold: cfg.priceAbove, value: price })
        if (cfg.priceBelow != null && price < cfg.priceBelow && prevPrice >= cfg.priceBelow)
          c('price_below', { symbol: cfg.symbol, type: 'price', condition: 'below', threshold: cfg.priceBelow, value: price })
      }

      if (cfg.divBull || cfg.divBear) {
        for (const tf of observeTfs) {
          const strongTf = tfs.includes(tf)
          const divNow  = asset.divergence?.[tf]
          const divPrev = prev.divergence?.[tf]
          if (strongTf && cfg.divBull && divNow === 'bullish' && (startupStateCheck || divPrev !== 'bullish'))
            c(`${tf}_div_bull`, { symbol: cfg.symbol, type: 'divergence', timeframe: tf, condition: 'bull', level: cfg.alertLevel ?? defaultLevelForTimeframe(tf) })
          if (strongTf && cfg.divBear && divNow === 'bearish' && (startupStateCheck || divPrev !== 'bearish'))
            c(`${tf}_div_bear`, { symbol: cfg.symbol, type: 'divergence', timeframe: tf, condition: 'bear', level: cfg.alertLevel ?? defaultLevelForTimeframe(tf) })
          if (observationOn && cfg.divBull && divNow === 'bullish')
            c(`${tf}_div_bull_observe`, { symbol: cfg.symbol, type: 'divergence', timeframe: tf, condition: 'bull', level: 0 })
          if (observationOn && cfg.divBear && divNow === 'bearish')
            c(`${tf}_div_bear_observe`, { symbol: cfg.symbol, type: 'divergence', timeframe: tf, condition: 'bear', level: 0 })
        }
      }

      if (cfg.volumeSignal) {
        for (const tf of observeTfs) {
          const strongTf = tfs.includes(tf)
          const sig = asset.volumeSignal?.[tf]
          const prevSig = prev.volumeSignal?.[tf]
          const score = asset.signalScore?.[tf] ?? 0
          const strongMatch = strongTf && matchesStrategy(cfg, sig, false) && Math.abs(score) >= (cfg.minScore ?? 3)
          const observeMatch = observationOn && matchesStrategy(cfg, sig, true) && Math.abs(score) >= 1
          if (!strongMatch && !observeMatch) continue
          if (strongMatch && !startupStateCheck && sig.type === prevSig?.type) continue
          c(`${tf}_structure_${sig.type}${strongMatch ? '' : '_observe'}`, {
            symbol: cfg.symbol,
            type: 'structure',
            timeframe: tf,
            condition: sig.direction,
            signal: sig.label,
            value: score,
            volumeRatio: sig.volumeRatio,
            priceMovePct: sig.priceMovePct,
            level: strongMatch ? (cfg.alertLevel ?? defaultLevelForTimeframe(tf)) : 0,
          })
        }
      }
    }

    const bgScan = backgroundScanRef.current
    const shouldScanSlowRsi = startupStateCheck || now - bgScan.slowRsiAt >= 30 * 60 * 1000
    if (shouldScanSlowRsi) {
      bgScan.slowRsiAt = now
      const slowOversold = findSlowOversoldSignals(assetsRef.current, prevAssetsRef.current, now, slowRsiRef.current)
      if (slowOversold.length) {
        for (const item of slowOversold) {
          const batchKey = [item.symbol, item.timeframe, item.type, item.signal].join('|')
          if (firedBatchKeys.has(batchKey)) continue
          firedBatchKeys.add(batchKey)
          fired.push(item)
        }
      }
    }

    const shouldScanWatchPool = startupStateCheck || now - bgScan.watchPoolAt >= 15 * 60 * 1000
    if (shouldScanWatchPool) {
      bgScan.watchPoolAt = now
      const watchPoolReviews = findWatchPoolReviewSignals(watchPoolItems, assetsRef.current, now, watchPoolReviewRef.current)
      if (watchPoolReviews.length) {
        for (const item of watchPoolReviews) {
          const batchKey = [item.symbol, item.type, item.signal].join('|')
          if (firedBatchKeys.has(batchKey)) continue
          firedBatchKeys.add(batchKey)
          fired.push(item)
        }
      }
    }

    prevAssetsRef.current = [...assetsRef.current]

    if (!legacyAlertsEnabled) fired.length = 0

    if (fired.length > 0) {
      addFeedItems(fired)
      const silent = isSilentHours(silentRef.current.start, silentRef.current.end)
      const popupItems = fired.filter(i => (i.level ?? 1) >= (minLevelRef.current.popup ?? 1))
      const soundItems = fired.filter(i => (i.level ?? 1) >= (minLevelRef.current.sound ?? 1))
      const webhookItems = fired.filter(i =>
        (i.level ?? 1) >= (minLevelRef.current.webhook ?? 1) &&
        (!webhookRef.current.webhookAiOnly || i.type === 'ai')
      )
      if (!silent && popupRef.current && popupItems.length) window.api.showNotificationBatch(popupItems)
      if (!silent && soundRef.current && soundItems.length) playAlertSound()
      if (webhookItems.length) sendWebhooks(webhookItems, webhookRef.current)
    }

    updateFeed(feed => {
      let changed = false
      const bySymbol = new Map()
      for (const asset of assetsRef.current) {
        if (asset.symbol) bySymbol.set(String(asset.symbol).toUpperCase(), asset)
        if (asset.apiSymbol) bySymbol.set(String(asset.apiSymbol).toUpperCase(), asset)
      }
      const next = feed.map(item => {
        if (!item.price || !item.ts) return item
        const asset = bySymbol.get(String(item.symbol).toUpperCase())
        if (!asset?.price) return item
        const outcomes = { ...(item.outcomes ?? {}) }
        let itemChanged = false
        for (const [key, ms] of Object.entries({ '1h': 60 * 60 * 1000, '4h': 4 * 60 * 60 * 1000, '24h': 24 * 60 * 60 * 1000 })) {
          if (outcomes[key] || now - item.ts < ms) continue
          outcomes[key] = {
            price: asset.price,
            changePct: ((asset.price - item.price) / item.price) * 100,
            ts: now,
          }
          itemChanged = true
          changed = true
        }
        return itemChanged ? { ...item, outcomes } : item
      })
      return changed ? next : feed
    })
  }, [completedAt])

  useEffect(() => {
    if (!completedAt || !settingsLoaded) return
    const cfg = autoAiRef.current
    if (!cfg.enabled) return

    const now = Date.now()
    const startupDelayMs = Math.max(1, Number(cfg.startupDelay) || 10) * 60 * 1000
    if (now - appStartedAtRef.current < startupDelayMs) return

    const state = aiRunRef.current
    if (state.busy) return

    const intervalMs = Math.max(5, Number(cfg.interval) || 30) * 60 * 1000
    if (now - state.lastRun < intervalMs) return

    const limit = Math.max(5, Number(cfg.limit) || 20)
    const candidates = buildCandidates(assetsRef.current, limit, watchPoolItems)
    if (!candidates.length) return

    const sig = candidateSignature(candidates)
    if (sig && sig === state.lastSignature) return

    state.busy = true
    state.lastRun = now
    state.lastSignature = sig

    const payload = {
      scope: 'auto-market',
      createdAt: new Date(now).toISOString(),
      updatedAt: updatedAt ? new Date(updatedAt).toISOString() : null,
      note: '自动 AI 筛选：AI 只做噪音过滤和提醒归类，不给交易指令。',
      candidates,
    }

    window.api.runCodexScreen(payload)
      .then(res => {
        if (!res?.ok || !res.result?.items?.length) return
        const finishedAt = Date.now()
        const settingsApi = useSettingsStore.getState()
        settingsApi.update('aiLastRunAt', finishedAt)
        settingsApi.update('aiLastRunMode', 'auto')
        settingsApi.update('aiLastRunCount', res.result.items.length)
        settingsApi.update('aiLastSnapshot', {
          ts: finishedAt,
          mode: 'auto',
          candidates,
          result: res.result,
          summary: res.result.summary ?? '',
        })
        const rawItems = makeAiFeedItems(candidates, res.result.items, Date.now())
        const filtered = rawItems.filter(item => {
          const key = `${item.symbol}|${item.condition}`
          const prev = state.notified[key] ?? 0
          if (Date.now() - prev < 2 * 60 * 60 * 1000) return false
          state.notified[key] = Date.now()
          return true
        })
        if (!filtered.length) return

        addFeedItems(filtered)
        const silent = isSilentHours(silentRef.current.start, silentRef.current.end)
        const popupItems = filtered.filter(i => (i.level ?? 1) >= (minLevelRef.current.popup ?? 1))
        const soundItems = filtered.filter(i => (i.level ?? 1) >= (minLevelRef.current.sound ?? 1))
        const webhookItems = filtered.filter(i =>
          (i.level ?? 1) >= (minLevelRef.current.webhook ?? 1) &&
          (!webhookRef.current.webhookAiOnly || i.type === 'ai')
        )
        if (!silent && popupRef.current && popupItems.length) window.api.showNotificationBatch(popupItems)
        if (!silent && soundRef.current && soundItems.length) playAlertSound()
        if (webhookItems.length) sendWebhooks(webhookItems, webhookRef.current)
      })
      .catch(err => console.warn('[auto-ai-screen]', err))
      .finally(() => {
        aiRunRef.current.busy = false
      })
  }, [completedAt, settingsLoaded, updatedAt, addFeedItems])

  useEffect(() => {
    if (!completedAt || !assets.length || !settingsLoaded || !shNightlyReplayEnabled || nightlyReplayRef.current) return
    const now = new Date()
    if (now.getHours() < 2) return
    const dayKey = `${now.getFullYear()}-${now.getMonth() + 1}-${now.getDate()}`
    if (localStorage.getItem('rsi:signalHunter:lastNightlyReplay') === dayKey) return
    nightlyReplayRef.current = true
    const selected = assets
      .filter(asset => asset.signalHunter?.structureCandidates?.length)
      .slice(0, 20)
      .map(({ symbol, apiSymbol, source, type, name }) => ({ symbol, apiSymbol, source, type, name }))
    if (!selected.length) {
      nightlyReplayRef.current = false
      return
    }
    window.api.runSignalHunterReplay({ assets: selected, maxAssets: 20 })
      .then(() => localStorage.setItem('rsi:signalHunter:lastNightlyReplay', dayKey))
      .catch(err => console.warn('[signal-nightly-replay]', err))
      .finally(() => { nightlyReplayRef.current = false })
  }, [completedAt, assets.length, settingsLoaded, shNightlyReplayEnabled])

  useEffect(() => {
    if (!completedAt || !assets.length || signalLifecycleRef.current === completedAt) return
    signalLifecycleRef.current = completedAt
    advanceSignalLifecycleItems(assets, completedAt).then(advanced => {
      if (!advanced.items.length) return
      applySignalHunterAiResults(advanced.items)
      const transitions = advanced.transitions
      if (!transitions.length) return
      const lifecycleItems = transitions.map(item => ({
        id: `signal-hunter-lifecycle-${item.symbol}-${item.to}-${completedAt}`,
        ts: completedAt,
        symbol: item.symbol,
        apiSymbol: item.apiSymbol,
        source: item.source,
        assetType: item.type,
        underlyingKey: underlyingKey(item),
        type: 'signal_hunter_ai',
        condition: item.to === 'triggered' ? 'focus' : item.to === 'completed' ? 'completed' : 'risk',
        value: item.signalHunter.score?.total ?? 0,
        price: item.signalHunter.currentPrice ?? null,
        level: item.to === 'stopped' || item.to === 'ambiguous' ? 3 : 2,
        special: true,
        status: item.to,
        side: item.signalHunter.side,
        timeframe: item.signalHunter.timeframe,
        signal: item.signalHunter.setupLabel || item.signalHunter.setup || 'Signal Hunter',
        reason: lifecycleTransitionReason(item.to),
        risk: item.signalHunter.riskFlags?.[0] ?? '',
        nextCheck: item.to === 'triggered' ? '继续跟踪失效位与目标位' : '本轮计划已结束，等待新结构',
        entryPrice: item.signalHunter.entryPrice ?? null,
        stopLoss: item.signalHunter.stopLoss ?? null,
        rewardRisk: item.signalHunter.rewardRisk ?? null,
        score: item.signalHunter.score?.total ?? null,
      }))
      addFeedItems(lifecycleItems)
      const silent = isSilentHours(silentRef.current.start, silentRef.current.end)
      const popupItems = lifecycleItems.filter(item => item.level >= (minLevelRef.current.popup ?? 1))
      const soundItems = lifecycleItems.filter(item => item.level >= (minLevelRef.current.sound ?? 1))
      const webhookItems = lifecycleItems.filter(item => item.level >= (minLevelRef.current.webhook ?? 1))
      if (!silent && popupRef.current && popupItems.length) window.api.showNotificationBatch(popupItems)
      if (!silent && soundRef.current && soundItems.length) playAlertSound()
      if (webhookItems.length) sendWebhooks(webhookItems, webhookRef.current)
    }).catch(err => console.warn('[signal-lifecycle]', err))
  }, [completedAt, assets.length, applySignalHunterAiResults, addFeedItems])

  useEffect(() => {
    if (!completedAt || !assets.length) return
    updateSignalTrail(assets)
    syncSignalReviews(assets)
    updateSignalReviews(assets)
    recordShadowStrategy(assets, completedAt)
    recordRuleDrift(assets, completedAt)
  }, [completedAt, assets, updateSignalTrail, syncSignalReviews, updateSignalReviews, recordShadowStrategy, recordRuleDrift])

  /* 鈹€鈹€ Filtered assets for summary bar 鈹€鈹€ */
  const filteredAssets = useMemo(() => {
    return filter === 'all'    ? assets
         : filter === 'crypto' ? assets.filter(a => a.type === 'crypto')
         : assets.filter(a => a.type !== 'crypto')
  }, [assets, filter])
  const deferredAssets = useDeferredValue(filteredAssets)
  const todayPicks = useMemo(() => getTodayPicks({ assets: deferredAssets, feed, watchPoolItems }), [deferredAssets, feed, watchPoolItems])

  return (
    <div className={`app app-tab-${activeTab}`}>
      <Toolbar activeTab={activeTab} setActiveTab={setActiveTab} />
      {updateInfo && isNewerVersion(updateInfo.tag, APP_VERSION) && (
        <div className="update-banner">
          <span>发现新版本：{updateInfo.tag}</span>
          <button onClick={() => window.api.checkForUpdates(true)}>查看发布页</button>
          <button onClick={() => setUpdateInfo(null)}>忽略</button>
        </div>
      )}

      <div className={`app-shell ${chatOpen ? 'chat-open' : ''}`}>
        <div className="app-content">
          <Suspense fallback={<LazyFallback />}>
            {activeTab === 'manage' ? (
              <ManagePage aiRequest={aiPlanRequest?.target === 'manage' ? aiPlanRequest : null} onSaved={() => { setActiveTab('market'); fetchData() }} />
            ) : activeTab === 'alerts' ? (
              <AlertEventPage onNavigate={setActiveTab} />
            ) : activeTab === 'alert-settings' ? (
              <AlertPage aiRequest={aiPlanRequest?.target === 'alerts' ? aiPlanRequest : null} />
            ) : activeTab === 'settings' ? (
              <SettingsPage />
            ) : activeTab === 'ai' ? (
              <AiPage />
            ) : activeTab === 'opportunities' ? (
              <OpportunityPage onNavigate={setActiveTab} />
            ) : activeTab === 'signal-hunter' ? (
              <SignalHunterPage />
            ) : activeTab === 'workspace' ? (
              <AssetWorkspacePage />
            ) : activeTab === 'cross-market-audit' ? (
              <CrossMarketAuditPage />
            ) : activeTab === 'company-events' ? (
              <CompanyEventsPage />
            ) : activeTab === 'data-gaps' ? (
              <DataGapPage />
            ) : activeTab === 'runtime-center' ? (
              <RuntimeCenterPage onNavigate={setActiveTab} />
            ) : activeTab === 'ai-review' ? (
              <AiReviewPage />
            ) : activeTab === 'trail' ? (
              <SignalTrailPage />
            ) : activeTab === 'watch-pool' ? (
              <WatchPoolPage />
            ) : activeTab === 'launch-review' ? (
              <LaunchReviewPage />
            ) : activeTab === 'signal-review' ? (
              <SignalReviewPage onNavigate={setActiveTab} />
            ) : (
            <div className="main">
              {loading && !hasData && (
                <div className="splash">
                  <div className="spinner" />
                  正在获取市场数据...
                </div>
              )}

              {error && !hasData && (
                <div className="splash error">{error}</div>
              )}

              {hasData && (
                <div className="market-layout">
                  <div className="market-main-column">
                    {/* Summary cards */}
                    <SummaryBar assets={filteredAssets} timeframe={timeframe} />
                    <TodayPicks picks={todayPicks} onSelect={setFlash} />
                    <StatusBanner />

                    {/* Heatmap */}
                    <div className="heatmap-wrapper">
                      <Heatmap />
                    </div>

                    {/* Table */}
                    <div className="market-table-wrap">
                      <StatsTable />
                    </div>
                  </div>
                  <AlertFeed />
                </div>
              )}
            </div>
            )}
          </Suspense>
        </div>
        {chatOpen && (
          <aside className="chat-drawer">
            <Suspense fallback={<LazyFallback label="正在加载 AI 对话..." />}>
              <MarketChatPage
                activeTab={activeTab}
                drawer
                onClose={() => setChatOpen(false)}
                onGeneratePlan={(target, instruction) => {
                  const tab = target === 'manage' ? 'manage' : 'alerts'
                  setAiPlanRequest({ id: Date.now(), target: tab, instruction })
                  setActiveTab(tab)
                }}
              />
            </Suspense>
          </aside>
        )}
      </div>
      {!chatOpen && (
        <button className="chat-fab" onClick={() => setChatOpen(true)} title="打开 AI 对话">
          AI
        </button>
      )}
    </div>
  )
}
