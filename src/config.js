const fs   = require('fs')
const path = require('path')

let _dir = null

exports.init = (userDataPath) => { _dir = userDataPath }

function filePath()        { return path.join(_dir, 'assets.json')   }
function alertFilePath()   { return path.join(_dir, 'alerts.json')   }
function settingsFilePath(){ return path.join(_dir, 'settings.json') }
function feedFilePath()    { return path.join(_dir, 'feed.json')     }
function marketCachePath() { return path.join(_dir, 'market-cache.json') }
function marketCacheDir()  { return path.join(_dir, 'market-cache-v2') }
function marketCacheEntryPath(key) {
  return path.join(marketCacheDir(), `${Buffer.from(key).toString('base64url')}.json`)
}

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
  aiLastRunAt:      null,
  aiLastRunMode:    '',
  aiLastRunCount:   0,
  aiLastSnapshot:   null,
  launchReviewLastRunAt: null,
  launchReviewLastReportPath: '',
  launchReviewLastDir: '',
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

exports.loadMarketCache = () => {
  return {}
}

exports.saveMarketCache = (cache) => {
  if (!_dir || !cache) return
  for (const [key, value] of Object.entries(cache)) exports.saveMarketCacheEntry(key, value)
}

exports.loadMarketCacheEntry = (key) => {
  if (!_dir || !key) return null
  try { return JSON.parse(fs.readFileSync(marketCacheEntryPath(key), 'utf8')) }
  catch { return null }
}

exports.saveMarketCacheEntry = (key, value) => {
  if (!_dir || !key) return
  try {
    fs.mkdirSync(marketCacheDir(), { recursive: true })
    fs.writeFileSync(marketCacheEntryPath(key), JSON.stringify(value), 'utf8')
  } catch {}
}

exports.getMarketCacheStats = () => {
  if (!_dir) return { entries: 0, sizeBytes: 0, filePath: null }
  const dir = marketCacheDir()
  const legacyFile = marketCachePath()
  let sizeBytes = 0
  let entries = 0
  let newest = 0
  try {
    for (const name of fs.readdirSync(dir)) {
      if (!name.endsWith('.json')) continue
      entries++
      const stat = fs.statSync(path.join(dir, name))
      sizeBytes += stat.size
      newest = Math.max(newest, stat.mtimeMs)
    }
  } catch {}
  try {
    const stat = fs.statSync(legacyFile)
    sizeBytes += stat.size
  } catch {}
  return { entries, sizeBytes, newest, filePath: dir }
}

exports.clearMarketCache = () => {
  if (!_dir) return { ok: true, entries: 0, sizeBytes: 0 }
  try { fs.rmSync(marketCachePath(), { force: true }) } catch {}
  try { fs.rmSync(marketCacheDir(), { recursive: true, force: true }) } catch {}
  return { ok: true, ...exports.getMarketCacheStats() }
}

exports.getDiagnostics = () => {
  const settings = exports.loadSettings()
  const assets = exports.load()
  const alerts = exports.loadAlerts() ?? []
  const feed = exports.loadFeed() ?? []
  const cache = exports.getMarketCacheStats()
  const exists = file => {
    try { return fs.existsSync(file) } catch { return false }
  }
  const checks = [
    { key: 'assets', label: '品种配置', ok: !!assets, detail: assets ? '已加载' : '使用内置默认配置' },
    { key: 'alerts', label: '提醒规则', ok: Array.isArray(alerts), detail: `${alerts.length} 条` },
    { key: 'feed', label: '提醒记录', ok: Array.isArray(feed), detail: `${feed.length} 条` },
    { key: 'settings', label: '设置文件', ok: true, detail: exists(settingsFilePath()) ? '已保存' : '使用默认设置' },
    { key: 'cache', label: 'K线缓存', ok: true, detail: `${cache.entries} 条，${formatBytes(cache.sizeBytes)}` },
    { key: 'telegram', label: 'Telegram', ok: !!(settings.telegramToken && settings.telegramChatId), detail: settings.telegramToken ? 'Token 已设置' : '未配置' },
    { key: 'discord', label: 'Discord', ok: !!settings.discordWebhook, detail: settings.discordWebhook ? 'Webhook 已设置' : '未配置' },
  ]
  return {
    ok: true,
    userData: _dir,
    cache,
    checks,
  }
}

function formatBytes(bytes) {
  if (!bytes) return '0 B'
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${bytes} B`
}

exports.exportUserConfig = () => {
  const safeSettings = exports.loadSettings()
  delete safeSettings.telegramToken
  delete safeSettings.telegramChatId
  delete safeSettings.discordWebhook
  return {
    version: 1,
    exportedAt: new Date().toISOString(),
    assets: exports.load(),
    alerts: exports.loadAlerts() ?? [],
    settings: safeSettings,
  }
}

exports.importUserConfig = (payload) => {
  if (!payload || typeof payload !== 'object') throw new Error('Invalid config file')
  if (payload.assets) exports.save(payload.assets)
  if (Array.isArray(payload.alerts)) exports.saveAlerts(payload.alerts)
  if (payload.settings) {
    const current = exports.loadSettings()
    const next = {
      ...current,
      ...payload.settings,
      telegramToken: current.telegramToken,
      telegramChatId: current.telegramChatId,
      discordWebhook: current.discordWebhook,
    }
    exports.saveSettings(next)
  }
  return { ok: true }
}
