import { create } from 'zustand'

const KEY = 'rsi:marketChat'
const MAX_ITEMS = 40

function loadMessages() {
  try { return JSON.parse(localStorage.getItem(KEY) ?? '[]') }
  catch { return [] }
}

function saveMessages(messages) {
  localStorage.setItem(KEY, JSON.stringify(messages.slice(-MAX_ITEMS)))
}

const useMarketChatStore = create((set, get) => ({
  messages: loadMessages(),
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
