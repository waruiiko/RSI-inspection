import { useEffect, useRef, useState, useMemo } from 'react'
import useMarketStore   from './store/marketStore'
import useAlertStore    from './store/alertStore'
import useSettingsStore from './store/settingsStore'
import useGroupsStore   from './store/groupsStore'
import { isUSMarketOpen } from './utils/marketHours'
import { playAlertSound } from './utils/sound'
import { sendWebhooks }  from './utils/webhook'
import { getRsiZone }   from './utils/rsi'
import { matchesAssetRef } from './utils/assetKey'
import { applyLiquidityLimit } from './utils/liquidity'
import { buildCandidates, candidateSignature, makeAiFeedItems } from './utils/aiCandidates'
import Toolbar      from './components/Toolbar'
import Heatmap      from './components/Heatmap'
import StatsTable   from './components/StatsTable'
import ManagePage   from './components/ManagePage'
import AlertPage    from './components/AlertPage'
import AlertFeed    from './components/AlertFeed'
import SettingsPage from './components/SettingsPage'
import AiPage       from './components/AiPage'

function isSilentHours(start, end) {
  if (!start || !end) return false
  const now = new Date()
  const cur = now.getHours() * 60 + now.getMinutes()
  const [sh, sm] = start.split(':').map(Number)
  const [eh, em] = end.split(':').map(Number)
  const s = sh * 60 + sm, e = eh * 60 + em
  return s <= e ? cur >= s && cur < e : cur >= s || cur < e
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
const APP_VERSION = 'v1.0.7'

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
  const filter     = useMarketStore(s => s.filter)
  const timeframe  = useMarketStore(s => s.timeframe)
  const hasData    = assets.length > 0

  const configs         = useAlertStore(s => s.configs)
  const updateLastFired = useAlertStore(s => s.updateLastFired)
  const addFeedItems    = useAlertStore(s => s.addFeedItems)
  const updateFeed      = useAlertStore(s => s.updateFeed)
  const loadAlerts      = useAlertStore(s => s.load)
  const syncFollowTop   = useAlertStore(s => s.syncFollowTop)

  const {
    refreshInterval, alertCooldown, levelCooldowns, popupEnabled, soundEnabled,
    silentStart, silentEnd, telegramToken, telegramChatId, discordWebhook,
    popupMinLevel, soundMinLevel, webhookMinLevel, autoCheckUpdates,
    webhookAiOnly,
    observationEnabled, rsiSensitivity, startupStateAlerts,
    autoAiEnabled, autoAiInterval, autoAiLimit, autoAiStartupDelay,
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

  const loadGroups = useGroupsStore(s => s.load)

  useEffect(() => {
    loadSettings()
    loadAlerts()
    loadGroups()
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
        if (info?.tag && info.tag !== APP_VERSION) setUpdateInfo(info)
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
      fired.push({ ...notifData, level, special: level >= 2 })
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

    prevAssetsRef.current = [...assetsRef.current]

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
      const next = feed.map(item => {
        if (!item.price || !item.ts) return item
        const asset = assetsRef.current.find(a => matchesAssetRef(a, item.symbol))
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
    const candidates = buildCandidates(assetsRef.current, limit)
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

  /* 鈹€鈹€ Filtered assets for summary bar 鈹€鈹€ */
  const filteredAssets = useMemo(() => {
    return filter === 'all'    ? assets
         : filter === 'crypto' ? assets.filter(a => a.type === 'crypto')
         : assets.filter(a => a.type !== 'crypto')
  }, [assets, filter])

  return (
    <div className="app">
      <Toolbar activeTab={activeTab} setActiveTab={setActiveTab} />
      {updateInfo && (
        <div className="update-banner">
          <span>发现新版本：{updateInfo.tag}</span>
          <button onClick={() => window.api.checkForUpdates(true)}>查看发布页</button>
          <button onClick={() => setUpdateInfo(null)}>忽略</button>
        </div>
      )}

      {activeTab === 'manage' ? (
        <ManagePage onSaved={() => { setActiveTab('market'); fetchData() }} />
      ) : activeTab === 'alerts' ? (
        <AlertPage />
      ) : activeTab === 'settings' ? (
        <SettingsPage />
      ) : activeTab === 'ai' ? (
        <AiPage />
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
    </div>
  )
}
