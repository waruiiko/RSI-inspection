const fs   = require('fs')
const path = require('path')

let _dir = null

exports.init = (userDataPath) => { _dir = userDataPath }

function filePath()        { return path.join(_dir, 'assets.json')   }
function alertFilePath()   { return path.join(_dir, 'alerts.json')   }
function settingsFilePath(){ return path.join(_dir, 'settings.json') }
function feedFilePath()    { return path.join(_dir, 'feed.json')     }

const SETTINGS_DEFAULTS = {
  refreshInterval: 5,    // minutes
  alertCooldown:   4,    // hours
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
}

exports.load = () => {
  if (!_dir) return null
  try { return JSON.parse(fs.readFileSync(filePath(), 'utf8')) }
  catch { return null }
}

exports.save = (cfg) => {
  if (!_dir) throw new Error('config not initialised')
  fs.writeFileSync(filePath(), JSON.stringify(cfg, null, 2), 'utf8')
}

exports.loadAlerts = () => {
  if (!_dir) return null
  try { return JSON.parse(fs.readFileSync(alertFilePath(), 'utf8')) }
  catch { return null }
}

exports.saveAlerts = (rules) => {
  if (!_dir) throw new Error('config not initialised')
  fs.writeFileSync(alertFilePath(), JSON.stringify(rules, null, 2), 'utf8')
}

exports.loadSettings = () => {
  if (!_dir) return { ...SETTINGS_DEFAULTS }
  try { return { ...SETTINGS_DEFAULTS, ...JSON.parse(fs.readFileSync(settingsFilePath(), 'utf8')) } }
  catch { return { ...SETTINGS_DEFAULTS } }
}

exports.saveSettings = (s) => {
  if (!_dir) throw new Error('config not initialised')
  fs.writeFileSync(settingsFilePath(), JSON.stringify(s, null, 2), 'utf8')
}

function boundsFilePath() { return path.join(_dir, 'bounds.json') }

exports.loadBounds = () => {
  if (!_dir) return null
  try { return JSON.parse(fs.readFileSync(boundsFilePath(), 'utf8')) }
  catch { return null }
}

exports.saveBounds = (bounds) => {
  if (!_dir) return
  try { fs.writeFileSync(boundsFilePath(), JSON.stringify(bounds), 'utf8') } catch {}
}

exports.loadFeed = () => {
  if (!_dir) return null
  try { return JSON.parse(fs.readFileSync(feedFilePath(), 'utf8')) }
  catch { return null }
}

exports.saveFeed = (feed) => {
  if (!_dir) return
  fs.writeFileSync(feedFilePath(), JSON.stringify(feed), 'utf8')
}
