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
  popupMinLevel:   1,
  soundMinLevel:   1,
  webhookMinLevel: 1,
  webhookAiOnly:   true,
  levelCooldowns:  { 0: 3, 1: 4, 2: 2, 3: 1 },
  observationEnabled: true,
  rsiSensitivity:  'standard',
  startupStateAlerts: true,
  autoCheckUpdates:false,
  codexCliPath:     'codex',
  autoAiEnabled:    false,
  autoAiInterval:   30,
  autoAiLimit:      20,
  autoAiStartupDelay: 10,
  shAiInterval:     30,
  shExecutionNotional: 5000,
  shParameterMode:  'stable',
  shNightlyReplayEnabled: true,
  watchPoolRetentionDays: 15,
  themeMode:        'light',
  aiLastRunAt:      null,
  aiLastRunMode:    '',
  aiLastRunCount:   0,
  aiLastSnapshot:   null,
  launchReviewLastRunAt: null,
  launchReviewLastReportPath: '',
  launchReviewLastDir: '',
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
