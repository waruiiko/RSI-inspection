const { app, BrowserWindow, ipcMain, Tray, Menu, nativeImage } = require('electron')
const notificationWindow = require('./src/notificationWindow')
const path = require('path')
const http = require('http')
const zlib = require('zlib')

const isDev = process.env.NODE_ENV === 'development'

// Try candidate ports until one responds — handles Vite auto-port fallback
function findVitePort(candidates = [5173, 4000, 3000, 5174, 5175]) {
  return new Promise(resolve => {
    let remaining = candidates.length
    const tryPort = port => {
      const req = http.get(`http://localhost:${port}/`, res => {
        req.destroy()
        resolve(port)
      })
      req.on('error', () => {
        if (--remaining === 0) resolve(candidates[0])
      })
      req.setTimeout(1000, () => req.destroy())
    }
    candidates.forEach(tryPort)
  })
}

// Build a 16x16 bar-chart PNG entirely in memory — no external icon file needed
function buildTrayIcon() {
  const crcTable = new Int32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = (c & 1) ? 0xEDB88320 ^ (c >>> 1) : c >>> 1
    crcTable[n] = c
  }
  const crc32 = buf => {
    let c = 0xFFFFFFFF
    for (const b of buf) c = crcTable[(c ^ b) & 0xFF] ^ (c >>> 8)
    return (c ^ 0xFFFFFFFF) >>> 0
  }
  const chunk = (type, data) => {
    const lenBuf = Buffer.alloc(4); lenBuf.writeUInt32BE(data.length)
    const typeBuf = Buffer.from(type)
    const crcBuf  = Buffer.alloc(4); crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])))
    return Buffer.concat([lenBuf, typeBuf, data, crcBuf])
  }

  const W = 16, H = 16
  const px = new Uint8Array(W * H * 4) // RGBA, default transparent

  // Simple bar chart: [x, barHeight, r, g, b]
  const bars = [
    [1,  5,  63, 185,  80],
    [4,  9,  63, 185,  80],
    [7,  12, 249, 115,  22],
    [10, 15, 248,  81,  73],
    [13,  7, 248,  81,  73],
  ]
  for (const [bx, bh, r, g, b] of bars) {
    for (let y = H - bh; y < H; y++) {
      for (let x = bx; x < bx + 2; x++) {
        const i = (y * W + x) * 4
        px[i] = r; px[i + 1] = g; px[i + 2] = b; px[i + 3] = 255
      }
    }
  }

  // PNG scanlines: filter byte (0 = None) + RGBA row
  const rows = Buffer.alloc(H * (1 + W * 4))
  for (let y = 0; y < H; y++) {
    rows[y * (1 + W * 4)] = 0
    for (let x = 0; x < W; x++) {
      const pi = (y * W + x) * 4
      const si = y * (1 + W * 4) + 1 + x * 4
      rows[si] = px[pi]; rows[si + 1] = px[pi + 1]
      rows[si + 2] = px[pi + 2]; rows[si + 3] = px[pi + 3]
    }
  }

  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4)
  ihdr[8] = 8; ihdr[9] = 6 // bit depth 8, color type RGBA

  const png = Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(rows)),
    chunk('IEND', Buffer.alloc(0)),
  ])

  return nativeImage.createFromBuffer(png)
}

async function createWindow() {
  const saved   = require('./src/config').loadBounds() ?? {}
  const { width = 1440, height = 900, x, y } = saved
  const winOpts = {
    width, height,
    minWidth: 1000,
    minHeight: 600,
    backgroundColor: '#0d1117',
    title: '市场 RSI 热力图',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  }
  if (x != null && y != null) { winOpts.x = x; winOpts.y = y }
  const win = new BrowserWindow(winOpts)

  if (isDev) {
    const port = await findVitePort()
    console.log(`[main] Loading Vite dev server at port ${port}`)
    win.loadURL(`http://localhost:${port}`)
    win.webContents.openDevTools({ mode: 'detach' })
  } else {
    win.loadFile(path.join(__dirname, 'renderer/dist/index.html'))
  }

  return win
}

let mainWin = null
let tray    = null

function showMainWindow() {
  if (!mainWin || mainWin.isDestroyed()) return
  if (mainWin.isMinimized()) mainWin.restore()
  mainWin.show()
  mainWin.focus()
}

app.whenReady().then(async () => {
  require('./src/config').init(app.getPath('userData'))
  require('./src/ipc').register(ipcMain)
  notificationWindow.registerIpc(ipcMain)
  mainWin = await createWindow()

  // Hide on launch if startMinimized is set
  const settings = require('./src/config').loadSettings()
  if (settings.startMinimized) mainWin.hide()

  // ── System tray ───────────────────────────────────────────
  tray = new Tray(buildTrayIcon())
  tray.setToolTip('市场 RSI 热力图')
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '显示',  click: showMainWindow },
    { type: 'separator' },
    { label: '退出',  click: () => { app.isQuiting = true; app.quit() } },
  ]))
  tray.on('double-click', showMainWindow)

  // Save window bounds whenever user resizes or moves
  const saveBoundsDebounced = (() => {
    let t = null
    return () => {
      clearTimeout(t)
      t = setTimeout(() => {
        if (!mainWin.isDestroyed() && !mainWin.isMinimized() && !mainWin.isMaximized()) {
          require('./src/config').saveBounds(mainWin.getBounds())
        }
      }, 500)
    }
  })()
  mainWin.on('resize', saveBoundsDebounced)
  mainWin.on('move',   saveBoundsDebounced)

  // Close button → hide to tray instead of quitting
  mainWin.on('close', e => {
    if (!app.isQuiting) {
      e.preventDefault()
      saveBoundsDebounced()
      mainWin.hide()
    }
  })

  // ── IPC ───────────────────────────────────────────────────
  ipcMain.on('notif:focus-symbol', (_, symbol) => {
    showMainWindow()
    mainWin.webContents.send('market:focus-symbol', symbol)
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow()
})

app.on('before-quit', () => { app.isQuiting = true })
