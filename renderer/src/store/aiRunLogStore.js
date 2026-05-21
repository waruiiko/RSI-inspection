import { create } from 'zustand'

const KEY = 'rsi:aiRunLog'

function loadLog() {
  try { return JSON.parse(localStorage.getItem(KEY) || '[]') }
  catch { return [] }
}

function saveLog(items) {
  localStorage.setItem(KEY, JSON.stringify(items.slice(0, 80)))
}

const useAiRunLogStore = create((set, get) => ({
  items: loadLog(),

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
