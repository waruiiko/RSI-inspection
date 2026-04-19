const { BrowserWindow, screen } = require('electron')
const path = require('path')

let win = null

function ensureWindow() {
  if (win && !win.isDestroyed()) return win

  win = new BrowserWindow({
    width: 320,
    height: 100,
    frame: false,
    resizable: false,
    movable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    focusable: false,
    show: false,
    transparent: true,
    webPreferences: {
      preload: path.join(__dirname, '..', 'notification-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  })

  win.loadFile(path.join(__dirname, '..', 'notification.html'))

  // Park off-screen and show once loaded — avoids transparent-window hide/show bug on Windows
  win.webContents.once('did-finish-load', () => {
    win.setPosition(-400, -400)
    win.showInactive()
    win.setAlwaysOnTop(true, 'screen-saver')
  })

  win.on('closed', () => { win = null })
  return win
}

function reposition(h) {
  if (!win || win.isDestroyed()) return
  const { width, height } = screen.getPrimaryDisplay().workAreaSize
  win.setSize(320, h)
  win.setPosition(width - 328, height - h - 8)
  win.setAlwaysOnTop(true, 'screen-saver')
}

const CARD_H = 100

exports.registerIpc = (ipcMain) => {
  ipcMain.on('notification:height', (_, h) => {
    if (!win || win.isDestroyed() || h <= 0) return
    reposition(h)
  })
  // When all cards gone, park off-screen instead of hide() — avoids transparent-window re-show bug
  ipcMain.on('notification:empty', () => {
    if (win && !win.isDestroyed()) win.setPosition(-400, -400)
  })
}

exports.show = (data) => {
  const w = ensureWindow()
  reposition(CARD_H + 16)
  const send = () => w.webContents.send('notification:add', data)
  if (w.webContents.isLoading()) w.webContents.once('did-finish-load', send)
  else send()
}

exports.showBatch = (items) => {
  const w = ensureWindow()
  reposition(Math.min(items.length, 3) * CARD_H + 16)
  const send = () => w.webContents.send('notification:batch', items)
  if (w.webContents.isLoading()) w.webContents.once('did-finish-load', send)
  else send()
}
