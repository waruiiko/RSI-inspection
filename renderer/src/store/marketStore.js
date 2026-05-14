import { create } from 'zustand'
import useSettingsStore from './settingsStore'
import { assetKey } from '../utils/assetKey'

function mergeAsset(assets, chunk) {
  const key = assetKey(chunk)
  const idx = assets.findIndex(a => assetKey(a) === key)
  if (idx >= 0) {
    const updated = [...assets]
    updated[idx] = mergeAssetData(updated[idx], chunk)
    return updated
  }
  return [...assets, chunk]
}

function mergeAssets(assets, chunks) {
  if (!chunks.length) return assets
  const byKey = new Map(assets.map(a => [assetKey(a), a]))
  for (const chunk of chunks) {
    const key = assetKey(chunk)
    byKey.set(key, byKey.has(key) ? mergeAssetData(byKey.get(key), chunk) : chunk)
  }
  return Array.from(byKey.values())
}

function mergeAssetData(prev, next) {
  if (!prev) return next
  return {
    ...prev,
    ...next,
    price: next.price ?? prev.price,
    change24h: next.change24h ?? prev.change24h,
    quoteVolume24h: next.quoteVolume24h ?? prev.quoteVolume24h,
    rsi: { ...(prev.rsi ?? {}), ...(next.rsi ?? {}) },
    divergence: { ...(prev.divergence ?? {}), ...(next.divergence ?? {}) },
    volumeSignal: { ...(prev.volumeSignal ?? {}), ...(next.volumeSignal ?? {}) },
    signalScore: { ...(prev.signalScore ?? {}), ...(next.signalScore ?? {}) },
    sparkline: next.sparkline?.length ? next.sparkline : prev.sparkline,
  }
}

const ALL_ZONES = ['overbought', 'strong', 'neutral', 'weak', 'oversold']
const DEFAULT_ZONES = ALL_ZONES.filter(z => z !== 'neutral')

const _loadPinned = () => {
  try { return new Set(JSON.parse(localStorage.getItem('rsi:pinned') ?? '[]')) }
  catch { return new Set() }
}

const _loadLayoutPrefs = () => {
  try { return JSON.parse(localStorage.getItem('rsi:layoutPrefs') ?? '{}') }
  catch { return {} }
}

const _saveLayoutPref = (key, value) => {
  const next = { ..._loadLayoutPrefs(), [key]: value }
  localStorage.setItem('rsi:layoutPrefs', JSON.stringify(next))
}

const _prefs = _loadLayoutPrefs()

let _unsubChunk = null
let _unsubDone  = null
let _chunkBuffer = []
let _flushTimer = null
let _activeRequestId = 0
function _cleanupSubs() {
  _unsubChunk?.(); _unsubChunk = null
  _unsubDone?.();  _unsubDone  = null
  if (_flushTimer) { clearTimeout(_flushTimer); _flushTimer = null }
  _chunkBuffer = []
}

function _flushChunks(set) {
  if (!_chunkBuffer.length) return
  const chunks = _chunkBuffer
  _chunkBuffer = []
  set(state => ({ assets: mergeAssets(state.assets, chunks) }))
}

function _scheduleChunkFlush(set, delay = 180) {
  if (_flushTimer) return
  _flushTimer = setTimeout(() => {
    _flushTimer = null
    _flushChunks(set)
  }, delay)
}

function _finishFetch(set, requestId, updatedAt, meta = null) {
  if (requestId !== _activeRequestId) return
  if (_flushTimer) { clearTimeout(_flushTimer); _flushTimer = null }
  _flushChunks(set)
  set({ loading: false, updatedAt, completedAt: updatedAt, completedMeta: meta })
  _cleanupSubs()
}

const useMarketStore = create((set, get) => ({
  assets:        [],
  prevRsi:       {},             // { [symbol]: { [tf]: number } } snapshot before last refresh
  loading:       false,
  error:         null,
  statusEvents:  [],
  updatedAt:     null,
  completedAt:   null,
  completedMeta: null,
  filter:        _prefs.filter ?? 'all',
  liquidityLimit: _prefs.liquidityLimit ?? 100,
  timeframe:     _prefs.timeframe ?? '4h',
  layout:        _prefs.layout ?? 'random',
  rsiZones:      Array.isArray(_prefs.rsiZones) ? _prefs.rsiZones : DEFAULT_ZONES, // visible RSI zones
  hoveredSymbol: null,           // table row hover → chart highlight
  flashSymbol:   null,           // table row click  → chart flash { symbol, ts }
  pinnedSymbols: _loadPinned(),  // Set<string>, persisted to localStorage

  searchFocusTick: 0,
  focusSearch: () => set(s => ({ searchFocusTick: s.searchFocusTick + 1 })),

  setFilter:    (filter)    => { _saveLayoutPref('filter', filter); set({ filter }) },
  setLiquidityLimit: (liquidityLimit) => { _saveLayoutPref('liquidityLimit', liquidityLimit); set({ liquidityLimit }) },
  setTimeframe: (timeframe) => { _saveLayoutPref('timeframe', timeframe); set({ timeframe }) },
  setLayout:    (layout)    => { _saveLayoutPref('layout', layout); set({ layout }) },
  setRsiZones:  (zones)     => { _saveLayoutPref('rsiZones', zones); set({ rsiZones: zones }) },
  setHovered:   (symbol)    => set({ hoveredSymbol: symbol }),
  setFlash:     (symbol)    => set({ flashSymbol: symbol ? { symbol, ts: Date.now() } : null }),
  clearStatus:  ()          => set({ statusEvents: [] }),
  togglePin: (symbol) => {
    const next = new Set(get().pinnedSymbols)
    if (next.has(symbol)) next.delete(symbol); else next.add(symbol)
    localStorage.setItem('rsi:pinned', JSON.stringify([...next]))
    set({ pinnedSymbols: next })
  },

  async fetchData(options = {}) {
    if (!window.api) {
      set({ error: '请在 Electron 应用中运行，而非浏览器', loading: false })
      return
    }
    if (get().loading) return

    _cleanupSubs()
    // Snapshot current RSI before overwriting with new data
    const snapshot = {}
    for (const a of get().assets) snapshot[assetKey(a)] = { ...a.rsi }
    set({ loading: true, error: null, prevRsi: snapshot })

    const requestId = Date.now()
    _activeRequestId = requestId

    _unsubChunk = window.api.onMarketChunk(payload => {
      if (payload?.requestId !== _activeRequestId) return
      const chunk = payload.data ?? payload
      _chunkBuffer.push(chunk)
      _scheduleChunkFlush(set)
    })

    _unsubDone = window.api.onMarketDone(({ requestId: doneRequestId, updatedAt, meta }) => {
      _finishFetch(set, doneRequestId, updatedAt, meta)
    })

    const unsubStatus = window.api.onMarketStatus?.(({ requestId: statusRequestId, item }) => {
      if (statusRequestId !== _activeRequestId || !item) return
      set(state => ({ statusEvents: [item, ...state.statusEvents].slice(0, 20) }))
    })

    try {
      const { rsiPeriod } = useSettingsStore.getState()
      const result = await window.api.fetchMarketData({
        timeframes: options.timeframes ?? ['15m', '1h', '4h', '1d'],
        rsiPeriod,
        requestId,
        limit: options.limit ?? null,
        scope: options.scope ?? 'manual',
        suppressAlerts: !!options.suppressAlerts,
      })
      if (get().loading && result?.ok) _finishFetch(set, result.requestId, result.updatedAt ?? Date.now(), result.meta)
    } catch (err) {
      set({ loading: false, error: err.message })
      _cleanupSubs()
    } finally {
      unsubStatus?.()
    }
  },
}))

export default useMarketStore
export { ALL_ZONES }
