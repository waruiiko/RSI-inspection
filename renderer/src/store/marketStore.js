import { create } from 'zustand'
import useSettingsStore from './settingsStore'

function mergeAsset(assets, chunk) {
  const idx = assets.findIndex(a => a.symbol === chunk.symbol)
  if (idx >= 0) {
    const updated = [...assets]
    updated[idx] = chunk
    return updated
  }
  return [...assets, chunk]
}

const ALL_ZONES = ['overbought', 'strong', 'neutral', 'weak', 'oversold']

const _loadPinned = () => {
  try { return new Set(JSON.parse(localStorage.getItem('rsi:pinned') ?? '[]')) }
  catch { return new Set() }
}

let _unsubChunk = null
let _unsubDone  = null
function _cleanupSubs() {
  _unsubChunk?.(); _unsubChunk = null
  _unsubDone?.();  _unsubDone  = null
}

const useMarketStore = create((set, get) => ({
  assets:        [],
  prevRsi:       {},             // { [symbol]: { [tf]: number } } snapshot before last refresh
  loading:       false,
  error:         null,
  updatedAt:     null,
  filter:        'all',
  timeframe:     '4h',
  layout:        'random',
  rsiZones:      ALL_ZONES,      // visible RSI zones
  hoveredSymbol: null,           // table row hover → chart highlight
  flashSymbol:   null,           // table row click  → chart flash { symbol, ts }
  pinnedSymbols: _loadPinned(),  // Set<string>, persisted to localStorage

  searchFocusTick: 0,
  focusSearch: () => set(s => ({ searchFocusTick: s.searchFocusTick + 1 })),

  setFilter:    (filter)    => set({ filter }),
  setTimeframe: (timeframe) => set({ timeframe }),
  setLayout:    (layout)    => set({ layout }),
  setRsiZones:  (zones)     => set({ rsiZones: zones }),
  setHovered:   (symbol)    => set({ hoveredSymbol: symbol }),
  setFlash:     (symbol)    => set({ flashSymbol: symbol ? { symbol, ts: Date.now() } : null }),
  togglePin: (symbol) => {
    const next = new Set(get().pinnedSymbols)
    if (next.has(symbol)) next.delete(symbol); else next.add(symbol)
    localStorage.setItem('rsi:pinned', JSON.stringify([...next]))
    set({ pinnedSymbols: next })
  },

  async fetchData() {
    if (!window.api) {
      set({ error: '请在 Electron 应用中运行，而非浏览器', loading: false })
      return
    }

    _cleanupSubs()
    // Snapshot current RSI before overwriting with new data
    const snapshot = {}
    for (const a of get().assets) snapshot[a.symbol] = { ...a.rsi }
    set({ loading: true, error: null, prevRsi: snapshot })

    _unsubChunk = window.api.onMarketChunk(chunk => {
      set(state => ({ assets: mergeAsset(state.assets, chunk) }))
    })

    _unsubDone = window.api.onMarketDone(({ updatedAt }) => {
      set({ loading: false, updatedAt })
      _cleanupSubs()
    })

    try {
      const { rsiPeriod } = useSettingsStore.getState()
      await window.api.fetchMarketData({ timeframes: ['15m', '1h', '4h', '1d'], rsiPeriod })
    } catch (err) {
      set({ loading: false, error: err.message })
      _cleanupSubs()
    }
  },
}))

export default useMarketStore
export { ALL_ZONES }
