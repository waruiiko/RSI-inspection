const { BrowserWindow, screen } = require('electron')
const path = require('path')

let win = null

function park() {
  if (!win || win.isDestroyed()) return
  win.setIgnoreMouseEvents(true)
  win.setPosition(-400, -400)
}

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

  win.webContents.once('did-finish-load', () => {
    win.setIgnoreMouseEvents(true)
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
  win.setIgnoreMouseEvents(false)
  win.setAlwaysOnTop(true, 'screen-saver')
}

const CARD_H = 100

exports.registerIpc = (ipcMain) => {
  ipcMain.on('notification:height', (_, h) => {
    if (!win || win.isDestroyed() || h <= 0) return
    reposition(h)
  })
  ipcMain.on('notification:empty', () => park())
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
