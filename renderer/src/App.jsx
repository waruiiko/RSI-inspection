import { useEffect, useRef, useState } from 'react'
import useMarketStore   from './store/marketStore'
import useAlertStore    from './store/alertStore'
import useSettingsStore from './store/settingsStore'
import useGroupsStore  from './store/groupsStore'
import { isUSMarketOpen } from './utils/marketHours'
import { playAlertSound } from './utils/sound'
import { sendWebhooks }  from './utils/webhook'
import Toolbar      from './components/Toolbar'
import Heatmap      from './components/Heatmap'
import StatsTable   from './components/StatsTable'
import ManagePage   from './components/ManagePage'
import AlertPage    from './components/AlertPage'
import AlertFeed    from './components/AlertFeed'
import SettingsPage from './components/SettingsPage'

function isSilentHours(start, end) {
  if (!start || !end) return false
  const now = new Date()
  const cur = now.getHours() * 60 + now.getMinutes()
  const [sh, sm] = start.split(':').map(Number)
  const [eh, em] = end.split(':').map(Number)
  const s = sh * 60 + sm, e = eh * 60 + em
  return s <= e ? cur >= s && cur < e : cur >= s || cur < e
}

export default function App() {
  const fetchData  = useMarketStore(s => s.fetchData)
  const loading    = useMarketStore(s => s.loading)
  const error      = useMarketStore(s => s.error)
  const assets     = useMarketStore(s => s.assets)
  const updatedAt  = useMarketStore(s => s.updatedAt)
  const setFlash   = useMarketStore(s => s.setFlash)
  const hasData    = assets.length > 0

  const configs         = useAlertStore(s => s.configs)
  const updateLastFired = useAlertStore(s => s.updateLastFired)
  const addFeedItems    = useAlertStore(s => s.addFeedItems)
  const loadAlerts      = useAlertStore(s => s.load)

  const { refreshInterval, alertCooldown, popupEnabled, soundEnabled, silentStart, silentEnd, telegramToken, telegramChatId, discordWebhook, loaded: settingsLoaded, load: loadSettings } = useSettingsStore()

  const configsRef    = useRef(configs)
  const assetsRef     = useRef(assets)
  const prevAssetsRef = useRef(null)
  const cooldownRef   = useRef(alertCooldown * 60 * 60 * 1000)
  const popupRef      = useRef(popupEnabled)
  const soundRef      = useRef(soundEnabled)
  const silentRef     = useRef({ start: silentStart, end: silentEnd })
  const webhookRef    = useRef({ telegramToken, telegramChatId, discordWebhook })
  configsRef.current  = configs
  assetsRef.current   = assets
  cooldownRef.current = alertCooldown * 60 * 60 * 1000
  popupRef.current    = popupEnabled
  soundRef.current    = soundEnabled
  silentRef.current   = { start: silentStart, end: silentEnd }
  webhookRef.current  = { telegramToken, telegramChatId, discordWebhook }

  const focusSearch   = useMarketStore(s => s.focusSearch)
  const setTimeframe  = useMarketStore(s => s.setTimeframe)
  const [activeTab, setActiveTab] = useState('market')

  const loadGroups = useGroupsStore(s => s.load)

  // Load settings first, then data
  useEffect(() => {
    loadSettings()
    loadAlerts()
    loadGroups()
  }, [])

  // Global keyboard shortcuts
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

  // Start/restart refresh interval whenever refreshInterval setting changes
  useEffect(() => {
    if (!settingsLoaded) return
    fetchData()
    const t = setInterval(fetchData, refreshInterval * 60 * 1000)
    return () => clearInterval(t)
  }, [refreshInterval, settingsLoaded])

  useEffect(() => {
    return window.api.onFocusSymbol(symbol => {
      setActiveTab('market')
      setFlash(symbol)
    })
  }, [])

  // Check alert configs whenever data refreshes
  useEffect(() => {
    if (!updatedAt) return

    // First fetch: establish baseline, never alert
    if (!prevAssetsRef.current) {
      prevAssetsRef.current = [...assetsRef.current]
      return
    }

    const now = Date.now()
    const fired = []
    const marketOpen = isUSMarketOpen()
    const COOLDOWN_MS = cooldownRef.current

    const collect = (cfg, key, notifData) => {
      if (now - (cfg.lastFired?.[key] ?? 0) < COOLDOWN_MS) return
      updateLastFired(cfg.id, key)
      fired.push({ ...notifData, special: !!cfg.special })
    }

    for (const cfg of configsRef.current) {
      if (!cfg.enabled) continue
      const asset = assetsRef.current.find(a => a.symbol === cfg.symbol)
      if (!asset) continue
      if (asset.source === 'yahoo' && !marketOpen) continue

      const prev = prevAssetsRef.current.find(a => a.symbol === cfg.symbol)
      if (!prev) continue

      const tfs = cfg.timeframes ?? []
      const ctx = { price: asset.price, change24h: asset.change24h }
      const c = (key, nd) => collect(cfg, key, { ...ctx, ...nd })

      // Per-timeframe RSI alerts (always, regardless of requireAllTf)
      for (const tf of tfs) {
        const rsi     = asset.rsi?.[tf]
        const prevRsi = prev.rsi?.[tf]
        if (rsi == null || prevRsi == null) continue
        if (cfg.rsiAbove != null && rsi > cfg.rsiAbove && prevRsi <= cfg.rsiAbove)
          c(`${tf}_rsi_above`, { symbol: cfg.symbol, type: 'rsi', timeframe: tf, condition: 'above', threshold: cfg.rsiAbove, value: rsi })
        if (cfg.rsiBelow != null && rsi < cfg.rsiBelow && prevRsi >= cfg.rsiBelow)
          c(`${tf}_rsi_below`, { symbol: cfg.symbol, type: 'rsi', timeframe: tf, condition: 'below', threshold: cfg.rsiBelow, value: rsi })
      }

      // Resonance: all TFs simultaneously satisfy → special alert
      if (cfg.requireAllTf && tfs.length > 1) {
        if (cfg.rsiAbove != null) {
          const allNow  = tfs.every(tf => (asset.rsi?.[tf] ?? 0)   > cfg.rsiAbove)
          const allPrev = tfs.every(tf => (prev.rsi?.[tf]  ?? 0)   > cfg.rsiAbove)
          if (allNow && !allPrev)
            c('rsi_above_resonance', { symbol: cfg.symbol, type: 'rsi', timeframe: tfs.join('+'), condition: 'above', threshold: cfg.rsiAbove, value: Math.max(...tfs.map(tf => asset.rsi?.[tf] ?? 0)), special: true })
        }
        if (cfg.rsiBelow != null) {
          const allNow  = tfs.every(tf => (asset.rsi?.[tf] ?? 100) < cfg.rsiBelow)
          const allPrev = tfs.every(tf => (prev.rsi?.[tf]  ?? 100) < cfg.rsiBelow)
          if (allNow && !allPrev)
            c('rsi_below_resonance', { symbol: cfg.symbol, type: 'rsi', timeframe: tfs.join('+'), condition: 'below', threshold: cfg.rsiBelow, value: Math.min(...tfs.map(tf => asset.rsi?.[tf] ?? 100)), special: true })
        }
      }

      const change     = asset.change24h
      const prevChange = prev.change24h
      if (change != null && prevChange != null) {
        if (cfg.changeAbove != null && change > cfg.changeAbove && prevChange <= cfg.changeAbove)
          c('change_above', { symbol: cfg.symbol, type: 'change', condition: 'above', threshold: cfg.changeAbove, value: change })
        if (cfg.changeBelow != null && change < -cfg.changeBelow && prevChange >= -cfg.changeBelow)
          c('change_below', { symbol: cfg.symbol, type: 'change', condition: 'below', threshold: -cfg.changeBelow, value: change })
      }

      const price     = asset.price
      const prevPrice = prev.price
      if (price != null && prevPrice != null) {
        if (cfg.priceAbove != null && price > cfg.priceAbove && prevPrice <= cfg.priceAbove)
          c('price_above', { symbol: cfg.symbol, type: 'price', condition: 'above', threshold: cfg.priceAbove, value: price })
        if (cfg.priceBelow != null && price < cfg.priceBelow && prevPrice >= cfg.priceBelow)
          c('price_below', { symbol: cfg.symbol, type: 'price', condition: 'below', threshold: cfg.priceBelow, value: price })
      }

      if (cfg.divBull || cfg.divBear) {
        for (const tf of tfs) {
          const divNow  = asset.divergence?.[tf]
          const divPrev = prev.divergence?.[tf]
          if (cfg.divBull && divNow === 'bullish' && divPrev !== 'bullish')
            c(`${tf}_div_bull`, { symbol: cfg.symbol, type: 'divergence', timeframe: tf, condition: 'bull' })
          if (cfg.divBear && divNow === 'bearish' && divPrev !== 'bearish')
            c(`${tf}_div_bear`, { symbol: cfg.symbol, type: 'divergence', timeframe: tf, condition: 'bear' })
        }
      }
    }

    prevAssetsRef.current = [...assetsRef.current]

    if (fired.length > 0) {
      addFeedItems(fired)
      const silent = isSilentHours(silentRef.current.start, silentRef.current.end)
      if (!silent && popupRef.current) window.api.showNotificationBatch(fired)
      if (!silent && soundRef.current) playAlertSound()
      sendWebhooks(fired, webhookRef.current)
    }
  }, [updatedAt])

  return (
    <div className="app">
      <Toolbar activeTab={activeTab} setActiveTab={setActiveTab} />

      {activeTab === 'manage' ? (
        <ManagePage onSaved={() => { setActiveTab('market'); fetchData() }} />
      ) : activeTab === 'alerts' ? (
        <AlertPage />
      ) : activeTab === 'settings' ? (
        <SettingsPage />
      ) : (
        <div className="main">
          {loading && !hasData && (
            <div className="splash">
              <div className="spinner" />
              正在获取市场数据…
            </div>
          )}

          {error && !hasData && (
            <div className="splash error">{error}</div>
          )}

          {hasData && (
            <>
              <div className="heatmap-wrapper">
                <Heatmap />
              </div>
              <div className="market-bottom">
                <StatsTable />
                <AlertFeed />
              </div>
            </>
          )}
        </div>
      )}
    </div>
  )
}
