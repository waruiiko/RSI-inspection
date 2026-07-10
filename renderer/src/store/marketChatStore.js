import { create } from 'zustand'
import { hydrateOperationalData, persistOperationalData } from '../utils/operationalData'

const KEY = 'rsi:marketChat'
const MAX_ITEMS = 40

function loadMessages() {
  try { return JSON.parse(localStorage.getItem(KEY) ?? '[]') }
  catch { return [] }
}

function saveMessages(messages) {
  const next = messages.slice(-MAX_ITEMS)
  localStorage.setItem(KEY, JSON.stringify(next))
  persistOperationalData('marketChat', next)
}

const useMarketChatStore = create((set, get) => ({
  messages: loadMessages(),
  hydrate: async () => {
    const messages = await hydrateOperationalData('marketChat', get().messages)
    if (Array.isArray(messages)) set({ messages })
  },
  addMessage: (message) => {
    const next = [...get().messages, { id: `${Date.now()}_${Math.random().toString(36).slice(2)}`, ts: Date.now(), ...message }].slice(-MAX_ITEMS)
    saveMessages(next)
    set({ messages: next })
  },
  clear: () => {
    saveMessages([])
    set({ messages: [] })
  },
}))

export default useMarketChatStore

setTimeout(() => useMarketChatStore.getState().hydrate(), 0)
