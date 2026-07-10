import { create } from 'zustand'
import { hydrateOperationalData, persistOperationalData } from '../utils/operationalData'

const KEY = 'rsi:watchPool'

function loadItems() {
  try { return JSON.parse(localStorage.getItem(KEY) || '[]') }
  catch { return [] }
}

function saveItems(items) {
  const next = items.slice(0, 500)
  localStorage.setItem(KEY, JSON.stringify(next))
  persistOperationalData('watchPool', next)
}

function normalizeStatus(status) {
  return ['unmarked', 'watch', 'interesting', 'ignore'].includes(status) ? status : 'unmarked'
}

const useWatchPoolStore = create((set, get) => ({
  items: loadItems(),
  hydrate: async () => {
    const items = await hydrateOperationalData('watchPool', get().items)
    if (Array.isArray(items)) set({ items })
  },

  addOrUpdate: (entry) => {
    const now = Date.now()
    const symbol = String(entry.symbol || '').toUpperCase()
    if (!symbol) return
    const existing = get().items.find(i => i.symbol === symbol)
    let next
    if (existing) {
      next = get().items.map(i => i.symbol !== symbol ? i : {
        ...i,
        ...entry,
        symbol,
        status: normalizeStatus(i.status),
        firstSeenAt: i.firstSeenAt ?? entry.ts ?? now,
        lastSeenAt: entry.ts ?? now,
        reasons: [...new Set([...(i.reasons ?? []), entry.reason].filter(Boolean))].slice(-6),
        snapshots: [entry.snapshot, ...(i.snapshots ?? [])].filter(Boolean).slice(0, 8),
      })
    } else {
      next = [{
        id: `watch-${symbol}-${now}`,
        symbol,
        status: 'unmarked',
        source: entry.source ?? 'auto',
        reason: entry.reason ?? '',
        reasons: [entry.reason].filter(Boolean),
        note: '',
        firstSeenAt: entry.ts ?? now,
        lastSeenAt: entry.ts ?? now,
        snapshot: entry.snapshot ?? null,
        snapshots: [entry.snapshot].filter(Boolean),
      }, ...get().items]
    }
    set({ items: next })
    saveItems(next)
  },

  setStatus: (symbol, status) => {
    const sym = String(symbol || '').toUpperCase()
    const next = get().items
      .map(i => i.symbol === sym ? { ...i, status: normalizeStatus(status), markedAt: Date.now() } : i)
      .filter(i => i.status !== 'ignore')
    set({ items: next })
    saveItems(next)
  },

  setNote: (symbol, note) => {
    const sym = String(symbol || '').toUpperCase()
    const next = get().items.map(i => i.symbol === sym ? { ...i, note } : i)
    set({ items: next })
    saveItems(next)
  },

  remove: (symbol) => {
    const sym = String(symbol || '').toUpperCase()
    const next = get().items.filter(i => i.symbol !== sym)
    set({ items: next })
    saveItems(next)
  },

  cleanup: (retentionDays) => {
    const days = Number(retentionDays)
    if (!Number.isFinite(days) || days <= 0) return
    const cutoff = Date.now() - days * 24 * 60 * 60 * 1000
    const next = get().items.filter(i => i.status !== 'unmarked' || (i.lastSeenAt ?? i.firstSeenAt ?? 0) >= cutoff)
    if (next.length === get().items.length) return
    set({ items: next })
    saveItems(next)
  },

  clear: () => {
    set({ items: [] })
    saveItems([])
  },
}))

export default useWatchPoolStore
