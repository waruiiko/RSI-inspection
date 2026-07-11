import { create } from 'zustand'

let _feedSaveTimer = null

function _saveFeedDebounced(feed, delay = 800) {
  if (_feedSaveTimer) clearTimeout(_feedSaveTimer)
  _feedSaveTimer = setTimeout(() => {
    _feedSaveTimer = null
    window.api.saveFeed(feed)
  }, delay)
}

function _saveFeedNow(feed) {
  if (_feedSaveTimer) {
    clearTimeout(_feedSaveTimer)
    _feedSaveTimer = null
  }
  window.api.saveFeed(feed)
}

// Config shape:
// { id, symbol, special: bool, timeframes: ['1h','4h','1d'],
//   rsiAbove: number|null, rsiBelow: number|null,
//   changeAbove: number|null, changeBelow: number|null (magnitude, check: change < -val),
//   priceAbove: number|null, priceBelow: number|null,
//   requireAllTf: bool, enabled: bool,
//   lastFired: { [key]: timestamp } (persisted — cooldown survives restarts) }
// One alert rule per symbol. "special" only changes notification weight.

const useAlertStore = create((set, get) => ({
  configs: [],

  load: async () => {
    const [saved, feed] = await Promise.all([
      window.api.loadAlertRules(),
      window.api.loadFeed(),
    ])
    if (Array.isArray(saved)) {
      const configs = normalizeAlertConfigs(saved)
      set({ configs })
      if (configs.length !== saved.length) _persist(configs)
    }
    if (Array.isArray(feed)) set({ feed })
  },

  upsert: (symbols, fields) => {
    const result = normalizeAlertConfigs(get().configs)
    for (const symbol of symbols) {
      const key = symbolKey(symbol)
      const idx = result.findIndex(c => symbolKey(c.symbol) === key)
      const base = {
        id: idx >= 0 ? result[idx].id : makeId(),
        symbol,
        enabled: true,
        lastFired: idx >= 0 ? result[idx].lastFired : {},
      }
      if (idx >= 0) result[idx] = { ...base, ...fields }
      else result.push({ ...base, ...fields })
    }
    const configs = normalizeAlertConfigs(result)
    set({ configs })
    _persist(configs)
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

  replaceAll: (configs) => {
    const next = normalizeAlertConfigs(Array.isArray(configs) ? configs : [])
    set({ configs: next })
    _persist(next)
  },

  bulkSetTimeframes: (timeframes) => {
    const configs = get().configs.map(c => ({ ...c, timeframes }))
    set({ configs })
    _persist(configs)
  },

  syncFollowTop: (symbols) => {
    const current = normalizeAlertConfigs(get().configs)
    const template = current.find(c => c.followTop)
    if (!template) return
    const limit = template.followTopLimit ?? 50
    if (symbols.length < limit) return
    const top = new Set(symbols.map(symbolKey))
    const fields = {
      timeframes: template.timeframes,
      requireAllTf: template.requireAllTf,
      alertLevel: template.alertLevel ?? (template.special ? 3 : 1),
      special: !!template.special,
      rsiAbove: template.rsiAbove ?? null,
      rsiBelow: template.rsiBelow ?? null,
      changeAbove: template.changeAbove ?? null,
      changeBelow: template.changeBelow ?? null,
      priceAbove: null,
      priceBelow: null,
      divBull: !!template.divBull,
      divBear: !!template.divBear,
      volumeSignal: !!template.volumeSignal,
      strategies: template.strategies ?? null,
      strategy: template.strategy ?? null,
      minScore: template.minScore ?? null,
      followTop: true,
      followTopLimit: limit,
    }
    const kept = current.filter(c => !c.followTop || top.has(symbolKey(c.symbol)))
    for (const symbol of symbols) {
      const idx = kept.findIndex(c => symbolKey(c.symbol) === symbolKey(symbol))
      const base = {
        id: idx >= 0 ? kept[idx].id : makeId(),
        symbol,
        enabled: idx >= 0 ? kept[idx].enabled : true,
        lastFired: idx >= 0 ? kept[idx].lastFired : {},
      }
      if (idx >= 0) kept[idx] = { ...base, ...fields }
      else kept.push({ ...base, ...fields })
    }
    const configs = normalizeAlertConfigs(kept)
    set({ configs })
    _persist(configs)
  },

  // ── Feed ──────────────────────────────────────────────────
  feed: [],   // [{ id, ts, symbol, type, timeframe, condition, threshold, value }]

  addFeedItems: (items) => {
    const ts = Date.now()
    const current = get().feed
    const stamped = []
    const replaced = new Set()
    for (const [i, item] of items.entries()) {
      const identity = item.underlyingKey || `${item.source ?? ''}:${item.apiSymbol ?? item.symbol ?? ''}`
      const eventKey = [identity, item.type ?? '', item.timeframe ?? '', item.side ?? '', item.signal ?? item.condition ?? ''].join('|')
      const duplicate = current.find(row => row.eventKey === eventKey && ts - (row.ts ?? 0) <= 30 * 60 * 1000)
      if (duplicate) {
        replaced.add(duplicate.id)
        const escalated = Number(item.level ?? 0) > Number(duplicate.level ?? 0)
        stamped.push({
          ...duplicate, ...item, id: duplicate.id, eventKey, ts,
          firstSeenAt: duplicate.firstSeenAt ?? duplicate.ts,
          occurrenceCount: (duplicate.occurrenceCount ?? 1) + 1,
          eventStatus: escalated ? 'pending' : duplicate.eventStatus ?? 'pending',
          escalation: escalated ? { from: duplicate.level ?? 0, to: item.level ?? 0, at: ts } : duplicate.escalation,
        })
      } else {
        stamped.push({ ...item, id: `${ts}_${i}`, ts, firstSeenAt: ts, eventKey, occurrenceCount: 1, eventStatus: 'pending' })
      }
    }
    const next = [...stamped, ...current.filter(item => !replaced.has(item.id))].slice(0, 200)
    set({ feed: next })
    _saveFeedDebounced(next)
  },

  clearFeed: () => {
    set({ feed: [] })
    _saveFeedNow([])
  },

  updateFeed: (updater) => {
    const current = get().feed
    const next = typeof updater === 'function' ? updater(current) : updater
    if (next === current) return
    set({ feed: next })
    _saveFeedDebounced(next)
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

function makeId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2)
}

function symbolKey(symbol) {
  return String(symbol ?? '').trim().toUpperCase()
}

function normalizeAlertConfigs(configs) {
  const bySymbol = new Map()
  for (const rule of configs) {
    const key = symbolKey(rule.symbol)
    if (!key) continue
    const previous = bySymbol.get(key)
    bySymbol.set(key, {
      ...previous,
      ...rule,
      symbol: rule.symbol,
      id: previous?.id ?? rule.id ?? makeId(),
      alertLevel: rule.alertLevel ?? (rule.special ? 3 : 1),
      special: rule.special ?? ((rule.alertLevel ?? 1) >= 2),
      lastFired: {
        ...(previous?.lastFired ?? {}),
        ...(rule.lastFired ?? {}),
      },
      fireCount: Math.max(previous?.fireCount ?? 0, rule.fireCount ?? 0),
      lastFiredAt: Math.max(previous?.lastFiredAt ?? 0, rule.lastFiredAt ?? 0) || undefined,
    })
  }
  return [...bySymbol.values()]
}

export default useAlertStore
