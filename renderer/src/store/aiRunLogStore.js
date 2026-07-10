import { create } from 'zustand'
import { hydrateOperationalData, persistOperationalData } from '../utils/operationalData'

const KEY = 'rsi:aiRunLog'

function loadLog() {
  try { return JSON.parse(localStorage.getItem(KEY) || '[]') }
  catch { return [] }
}

function saveLog(items) {
  const next = items.slice(0, 80)
  localStorage.setItem(KEY, JSON.stringify(next))
  persistOperationalData('aiRunLog', next)
}

const useAiRunLogStore = create((set, get) => ({
  items: loadLog(),
  hydrate: async () => {
    const items = await hydrateOperationalData('aiRunLog', get().items)
    if (Array.isArray(items)) set({ items })
  },

  add: (entry) => {
    const next = [{
      id: `${Date.now()}_${Math.random().toString(36).slice(2)}`,
      ts: Date.now(),
      ...entry,
    }, ...get().items].slice(0, 80)
    set({ items: next })
    saveLog(next)
  },

  clear: () => {
    set({ items: [] })
    saveLog([])
  },
}))

export default useAiRunLogStore

setTimeout(() => useAiRunLogStore.getState().hydrate(), 0)
