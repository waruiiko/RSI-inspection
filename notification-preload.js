const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('notif', {
  onAdd:        (cb) => ipcRenderer.on('notification:add',   (_, data)  => cb(data)),
  onBatch:      (cb) => ipcRenderer.on('notification:batch', (_, items) => cb(items)),
  updateHeight: (h)  => ipcRenderer.send('notification:height', h),
  reportEmpty:  ()   => ipcRenderer.send('notification:empty'),
  focusSymbol:  (s)  => ipcRenderer.send('notif:focus-symbol', s),
})
