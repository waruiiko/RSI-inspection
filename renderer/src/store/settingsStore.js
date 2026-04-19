import { create } from 'zustand'

const useSettingsStore = create((set, get) => ({
  refreshInterval: 5,
  alertCooldown:   4,
  popupEnabled:    true,
  soundEnabled:    false,
  startMinimized:  false,
  rsiPeriod:       14,
  rsiOverbought:   70,
  rsiOversold:     30,
  silentStart:     '',
  silentEnd:       '',
  telegramToken:   '',
  telegramChatId:  '',
  discordWebhook:  '',
  rsiMaType:       'SMA',
  rsiMaLength:     14,
  rsiBbMult:       2.0,
  loaded:          false,

  load: async () => {
    const s = await window.api.getSettings()
    set({ ...s, loaded: true })
  },

  update: async (key, value) => {
    set({ [key]: value })
    const { loaded, load, update, ...toSave } = { ...get(), [key]: value }
    await window.api.saveSettings(toSave)
  },
}))

export default useSettingsStore
