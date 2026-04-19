const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('api', {
  // Streaming fetch — returns quickly, data arrives via onChunk / onDone
  fetchMarketData: (opts) => ipcRenderer.invoke('market:fetch', opts),

  onMarketChunk: (cb) => {
    const handler = (_, data) => cb(data)
    ipcRenderer.on('market:chunk', handler)
    return () => ipcRenderer.off('market:chunk', handler)
  },

  onMarketDone: (cb) => {
    const handler = (_, data) => cb(data)
    ipcRenderer.once('market:done', handler)
    return () => ipcRenderer.off('market:done', handler)
  },

  fetchRawOHLCV: (symbol, source, timeframes) =>
    ipcRenderer.invoke('market:ohlcv', { symbol, source, timeframes }),

  // Asset management
  getAssetsConfig:  ()       => ipcRenderer.invoke('assets:getConfig'),
  saveAssetsConfig: (cfg)    => ipcRenderer.invoke('assets:saveConfig', cfg),
  getBinancePairs:  ()       => ipcRenderer.invoke('assets:getBinancePairs'),
  validateStock:    (ticker) => ipcRenderer.invoke('assets:validateStock', ticker),

  // Alert rules
  loadAlertRules:   ()       => ipcRenderer.invoke('alerts:load'),
  saveAlertRules:   (rules)  => ipcRenderer.invoke('alerts:save', rules),
  showNotification:      (data)  => ipcRenderer.invoke('alerts:show', data),
  showNotificationBatch: (items) => ipcRenderer.invoke('alerts:showBatch', items),

  onFocusSymbol: (cb) => {
    const handler = (_, symbol) => cb(symbol)
    ipcRenderer.on('market:focus-symbol', handler)
    return () => ipcRenderer.off('market:focus-symbol', handler)
  },

  // Alert feed persistence
  loadFeed: ()       => ipcRenderer.invoke('feed:load'),
  saveFeed: (feed)   => ipcRenderer.invoke('feed:save', feed),

  // Settings
  getSettings:     ()        => ipcRenderer.invoke('settings:get'),
  saveSettings:    (s)       => ipcRenderer.invoke('settings:save', s),
  getAutoLaunch:   ()        => ipcRenderer.invoke('settings:getAutoLaunch'),
  setAutoLaunch:   (enabled) => ipcRenderer.invoke('settings:setAutoLaunch', enabled),
})
