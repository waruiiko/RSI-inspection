import { create } from 'zustand'

// Config shape:
// { id, symbol, special: bool, timeframes: ['1h','4h','1d'],
//   rsiAbove: number|null, rsiBelow: number|null,
//   changeAbove: number|null, changeBelow: number|null (magnitude, check: change < -val),
//   priceAbove: number|null, priceBelow: number|null,
//   requireAllTf: bool, enabled: bool,
//   lastFired: { [key]: timestamp } (persisted — cooldown survives restarts) }
// Regular alerts (special=false): one per symbol, upsert overwrites.
// Special alerts (special=true): multiple per symbol, managed by ID.

const useAlertStore = create((set, get) => ({
  configs: [],

  load: async () => {
    const [saved, feed] = await Promise.all([
      window.api.loadAlertRules(),
      window.api.loadFeed(),
    ])
    if (Array.isArray(saved)) {
      set({ configs: saved.map(c => ({ ...c, lastFired: c.lastFired ?? {} })) })
    }
    if (Array.isArray(feed)) set({ feed })
  },

  upsert: (symbols, fields) => {
    const result = [...get().configs]
    for (const symbol of symbols) {
      if (fields.special) {
        // Special: always create a new entry (multiple allowed per symbol)
        result.push({
          id: Date.now().toString(36) + Math.random().toString(36).slice(2),
          symbol, enabled: true, lastFired: {}, ...fields,
        })
      } else {
        // Regular: one per symbol — overwrite existing regular alert
        const idx = result.findIndex(c => c.symbol === symbol && !c.special)
        const base = {
          id: idx >= 0 ? result[idx].id : (Date.now().toString(36) + Math.random().toString(36).slice(2)),
          symbol, enabled: true,
          lastFired: idx >= 0 ? result[idx].lastFired : {},
        }
        if (idx >= 0) result[idx] = { ...base, ...fields }
        else result.push({ ...base, ...fields })
      }
    }
    set({ configs: result })
    _persist(result)
  },

  // Update an existing alert by ID (used when editing any alert in-place)
  updateById: (id, fields) => {
    const configs = get().configs.map(c => c.id === id ? { ...c, ...fields } : c)
    set({ configs })
    _persist(configs)
  },

  remove: (id) => {
    const configs = get().configs.filter(c => c.id !== id)
    set({ configs })
    _persist(configs)
  },

  clearAll: () => {
    set({ configs: [] })
    _persist([])
  },

  toggle: (id) => {
    const configs = get().configs.map(c => c.id === id ? { ...c, enabled: !c.enabled } : c)
    set({ configs })
    _persist(configs)
  },

  setAllEnabled: (enabled) => {
    const configs = get().configs.map(c => ({ ...c, enabled }))
    set({ configs })
    _persist(configs)
  },

  // ── Feed ──────────────────────────────────────────────────
  feed: [],   // [{ id, ts, symbol, type, timeframe, condition, threshold, value }]

  addFeedItems: (items) => {
    const ts = Date.now()
    const stamped = items.map((item, i) => ({ ...item, id: `${ts}_${i}`, ts }))
    const next = [...stamped, ...get().feed].slice(0, 200)
    set({ feed: next })
    window.api.saveFeed(next)
  },

  clearFeed: () => {
    set({ feed: [] })
    window.api.saveFeed([])
  },

  updateLastFired: (id, key) => {
    const now = Date.now()
    const next = get().configs.map(c => c.id !== id ? c : {
      ...c,
      lastFired:   { ...c.lastFired, [key]: now },
      fireCount:   (c.fireCount ?? 0) + 1,
      lastFiredAt: now,
    })
    set({ configs: next })
    _persist(next)
  },
}))

function _persist(configs) {
  window.api.saveAlertRules(configs)
}

export default useAlertStore
