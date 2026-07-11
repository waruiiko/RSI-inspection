const { app, BrowserWindow, dialog, shell } = require('electron')
const { Worker } = require('worker_threads')
const fs             = require('fs')
const path           = require('path')
const codexReview    = require('./codexReview')
const { fetchOHLCV } = require('./data/provider')
const binance        = require('./data/binance')
const yahoo          = require('./data/yahoo')
const { getAll, getCrypto, getStocks, getRuntimeAll } = require('./assets')
const config         = require('./config')
const { isUSMarketOpen, getUSMarketSession } = require('./marketHours')
const rsiIndicator = require('./indicators/rsi')

const DEFAULT_TIMEFRAMES = ['15m', '1h', '4h', '1d']
const AUTO_TRADFI_TIMEFRAMES = ['15m', '1h', '4h', '1d']
const AUTO_TRADFI_STRATEGIES = ['breakout', 'breakdown', 'volume_divergence']
let _indicatorWorker = null
let _indicatorSeq = 0
const _indicatorPending = new Map()
const _codexPending = []
let _codexRunning = false
const _cancelledCodexJobs = new Set()
const _codexInFlightByKey = new Map()

function codexJobLog() {
  const items = config.loadOperationalData('aiJobs')
  return Array.isArray(items) ? items : []
}

function saveCodexJob(job) {
  const next = [job, ...codexJobLog().filter(item => item.id !== job.id)].slice(0, 100)
  config.saveOperationalData('aiJobs', next)
}

function crc32(buffer) {
  let crc = 0xffffffff
  for (const byte of buffer) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1))
  }
  return (crc ^ 0xffffffff) >>> 0
}

function createStoredZip(entries) {
  const locals = []
  const centrals = []
  let offset = 0
  for (const [name, content] of entries) {
    const nameBuffer = Buffer.from(name, 'utf8')
    const data = Buffer.from(content, 'utf8')
    const crc = crc32(data)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x800, 6)
    local.writeUInt32LE(crc, 14); local.writeUInt32LE(data.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(nameBuffer.length, 26)
    locals.push(local, nameBuffer, data)
    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(0x800, 8)
    central.writeUInt32LE(crc, 16); central.writeUInt32LE(data.length, 20); central.writeUInt32LE(data.length, 24); central.writeUInt16LE(nameBuffer.length, 28); central.writeUInt32LE(offset, 42)
    centrals.push(central, nameBuffer)
    offset += local.length + nameBuffer.length + data.length
  }
  const centralSize = centrals.reduce((sum, buffer) => sum + buffer.length, 0)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(centralSize, 12); end.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, ...centrals, end])
}

function sanitizeDiagnostics(value, key = '') {
  if (/token|secret|password|webhook|chatid|api.?key/i.test(key)) return '[redacted]'
  if (Array.isArray(value)) return value.slice(0, 100).map(item => sanitizeDiagnostics(item))
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([childKey, child]) => [childKey, sanitizeDiagnostics(child, childKey)]))
  if (typeof value === 'string') return value.replace(/C:\\Users\\[^\\\s]+/gi, '%USERPROFILE%')
  return value
}

function enqueueCodexJob(type, payload, runner) {
  const candidateKeys = (payload?.candidates ?? []).map(item => item?.key ?? item?.symbol).filter(Boolean).sort().join(',')
  const dedupeKey = `${type}:${payload?.scope ?? ''}:${candidateKeys}`
  const existing = _codexInFlightByKey.get(dedupeKey)
  if (existing) return existing.then(result => ({ ...result, deduplicated: true }))
  const job = {
    id: `ai-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    type,
    scope: payload?.scope ?? payload?.item?.symbol ?? '',
    status: 'queued',
    queuedAt: Date.now(),
  }
  saveCodexJob(job)
  const execute = async () => {
    if (_cancelledCodexJobs.has(job.id)) {
      const cancelled = { ...job, status: 'cancelled', completedAt: Date.now(), error: '用户取消' }
      saveCodexJob(cancelled)
      return { ok: false, cancelled: true, jobId: job.id, error: '用户取消' }
    }
    const running = { ...job, status: 'running', startedAt: Date.now() }
    saveCodexJob(running)
    let result = await runner()
    if (((!result?.ok && !result?.degraded) || (result?.degraded && result?.retryable)) && !result?.cancelled && !_cancelledCodexJobs.has(job.id)) result = await runner()
    saveCodexJob({
      ...running,
      status: result?.cancelled || _cancelledCodexJobs.has(job.id) ? 'cancelled' : result?.ok ? (result?.degraded ? 'degraded' : 'completed') : 'failed',
      completedAt: Date.now(),
      durationMs: Date.now() - running.startedAt,
      error: result?.ok ? '' : (result?.parseError || result?.stderr || result?.error || 'Codex failed'),
    })
    return { ...result, jobId: job.id }
  }
  let resolveQueued
  let rejectQueued
  const queued = new Promise((resolve, reject) => { resolveQueued = resolve; rejectQueued = reject })
  _codexPending.push({
    execute,
    resolve: resolveQueued,
    reject: rejectQueued,
    priority: payload?.requestMode === 'auto' ? 0 : 10,
    queuedAt: job.queuedAt,
  })
  _codexInFlightByKey.set(dedupeKey, queued)
  queued.finally(() => {
    if (_codexInFlightByKey.get(dedupeKey) === queued) _codexInFlightByKey.delete(dedupeKey)
  }).catch(() => {})
  drainCodexQueue()
  return queued
}

async function drainCodexQueue() {
  if (_codexRunning) return
  _codexRunning = true
  try {
    while (_codexPending.length) {
      _codexPending.sort((a, b) => b.priority - a.priority || a.queuedAt - b.queuedAt)
      const task = _codexPending.shift()
      try { task.resolve(await task.execute()) } catch (error) { task.reject(error) }
    }
  } finally {
    _codexRunning = false
  }
}

function makeId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2)
}

function baseAssetConfig() {
  return {
    crypto: getCrypto(),
    stocks: getStocks(),
  }
}

function makeAutoTradFiAlert(pair) {
  return {
    id: makeId(),
    symbol: pair.symbol,
    enabled: true,
    timeframes: AUTO_TRADFI_TIMEFRAMES,
    requireAllTf: false,
    alertLevel: 3,
    special: true,
    followTop: false,
    followTopLimit: null,
    rsiAbove: null,
    rsiBelow: null,
    changeAbove: null,
    changeBelow: null,
    priceAbove: null,
    priceBelow: null,
    divBull: false,
    divBear: false,
    volumeSignal: true,
    strategies: AUTO_TRADFI_STRATEGIES,
    strategy: null,
    minScore: 1,
    lastFired: {},
    fireCount: 0,
    autoTradfi: true,
    createdAt: Date.now(),
  }
}

async function ensureTradFiOnboarded() {
  const current = config.load() || baseAssetConfig()
  const crypto = Array.isArray(current.crypto) ? current.crypto : []
  const stocks = Array.isArray(current.stocks) ? current.stocks : []
  let futuresPairs = []
  try {
    futuresPairs = await binance.fetchAllFuturesPairs()
  } catch (err) {
    return { ok: false, added: [], totalTradfi: 0, error: err.message }
  }
  const tradfiPairs = futuresPairs.filter(p => p.contractType === 'TRADIFI_PERPETUAL')
  const allTradfi = new Set(tradfiPairs.map(p => p.apiSymbol))
  const hasSeenList = Array.isArray(current.tradfiSeen)
  const seen = hasSeenList ? new Set(current.tradfiSeen) : new Set(allTradfi)
  const tracked = new Set(crypto.map(a => a.apiSymbol))
  const newPairs = hasSeenList
    ? tradfiPairs.filter(p => !seen.has(p.apiSymbol))
    : []

  const nextCrypto = [...crypto]
  for (const pair of newPairs) {
    if (tracked.has(pair.apiSymbol)) continue
    nextCrypto.push({
      symbol: pair.symbol,
      apiSymbol: pair.apiSymbol,
      type: 'tradfi',
      source: 'binance-futures',
    })
    tracked.add(pair.apiSymbol)
  }

  const nextCfg = {
    ...current,
    crypto: nextCrypto,
    stocks,
    tradfiSeen: [...allTradfi],
    tradfiAutoAdded: [
      ...(Array.isArray(current.tradfiAutoAdded) ? current.tradfiAutoAdded : []),
      ...newPairs.map(p => ({
        symbol: p.symbol,
        apiSymbol: p.apiSymbol,
        addedAt: Date.now(),
        alertLevel: 3,
      })),
    ].slice(-100),
    tradfiAutoAddedAt: newPairs.length ? Date.now() : current.tradfiAutoAddedAt,
  }

  if (newPairs.length || !hasSeenList) config.save(nextCfg)

  if (newPairs.length) {
    const alerts = config.loadAlerts() ?? []
    const alertSymbols = new Set(alerts.map(a => String(a.symbol || '').toUpperCase()))
    const additions = newPairs
      .filter(pair => !alertSymbols.has(String(pair.symbol).toUpperCase()))
      .map(makeAutoTradFiAlert)
    if (additions.length) config.saveAlerts([...alerts, ...additions])
  }

  return {
    ok: true,
    added: newPairs.map(p => ({ symbol: p.symbol, apiSymbol: p.apiSymbol })),
    totalTradfi: tradfiPairs.length,
  }
}

exports.register = (ipcMain) => {

  // Asset config management
  ipcMain.handle('assets:getConfig', async () => {
    await ensureTradFiOnboarded()
    const cfg = config.load()
    if (cfg) return cfg
    return baseAssetConfig()
  })

  ipcMain.handle('assets:saveConfig', (_, cfg) => {
    config.save(cfg)
    return { ok: true }
  })

  ipcMain.handle('assets:getBinancePairs', async () => {
    const [spot, futures] = await Promise.all([
      binance.fetchAllUsdtPairs(),
      binance.fetchAllFuturesPairs(),
    ])
    return { spot, futures }
  })

  ipcMain.handle('assets:getTopFuturesByVolume', async (_, { symbols = [], limit = 50 } = {}) => {
    return binance.fetchTopFuturesByVolume(symbols, limit)
  })

  ipcMain.handle('assets:validateStock', async (_, ticker) => {
    return yahoo.validateTicker(ticker)
  })

  ipcMain.handle('alerts:load', () => config.loadAlerts() ?? [])

  ipcMain.handle('alerts:save', (_, rules) => {
    config.saveAlerts(rules)
    return { ok: true }
  })

  ipcMain.handle('alerts:show', (_, data) => {
    require('./notificationWindow').show(data)
    return { ok: true }
  })

  ipcMain.handle('alerts:showBatch', (_, items) => {
    require('./notificationWindow').showBatch(items)
    return { ok: true }
  })

  ipcMain.handle('feed:load', () => config.loadFeed() ?? [])
  ipcMain.handle('feed:save', (_, feed) => { config.saveFeed(feed); return { ok: true } })

  ipcMain.handle('settings:get',  ()     => config.loadSettings())
  ipcMain.handle('settings:save', (_, s) => { config.saveSettings(s); return { ok: true } })
  ipcMain.handle('settings:diagnostics', () => config.getDiagnostics())
  ipcMain.handle('settings:cacheStats', () => config.getMarketCacheStats())
  ipcMain.handle('settings:clearCache', () => {
    return config.clearMarketCache()
  })
  ipcMain.handle('signalLifecycle:load', () => config.loadSignalLifecycle())
  ipcMain.handle('signalLifecycle:save', (_, items) => {
    config.saveSignalLifecycle(items)
    return { ok: true, count: Array.isArray(items) ? items.length : 0 }
  })
  ipcMain.handle('signalReplay:history', () => config.loadSignalReplayHistory())
  ipcMain.handle('operational:load', (_, key) => config.loadOperationalData(key))
  ipcMain.handle('operational:save', (_, { key, value }) => config.saveOperationalData(key, value))
  ipcMain.handle('companyEvents:syncSec', async (_, { symbols = [], userAgent = '', days = 90 } = {}) => {
    const requested = [...new Set(symbols.map(value => String(value).trim().toUpperCase()).filter(Boolean))].slice(0, 20)
    if (!requested.length) return { ok: true, events: [], missing: [] }
    if (!/@/.test(userAgent)) throw new Error('SEC User-Agent 需要包含有效联系邮箱')
    const headers = { 'User-Agent': String(userAgent).slice(0, 160), Accept: 'application/json' }
    const tickerResponse = await fetch('https://www.sec.gov/files/company_tickers.json', { headers })
    if (!tickerResponse.ok) throw new Error(`SEC ticker 映射请求失败：HTTP ${tickerResponse.status}`)
    const tickerRows = Object.values(await tickerResponse.json())
    const byTicker = new Map(tickerRows.map(row => [String(row.ticker).toUpperCase(), row]))
    const cutoff = Date.now() - Math.max(7, Math.min(365, Number(days) || 90)) * 24 * 60 * 60 * 1000
    const acceptedForms = new Set(['8-K', '8-K/A', '10-Q', '10-Q/A', '10-K', '10-K/A', '6-K', '6-K/A'])
    const events = []
    const missing = []
    for (const symbol of requested) {
      const company = byTicker.get(symbol)
      if (!company) { missing.push(symbol); continue }
      const cik = String(company.cik_str).padStart(10, '0')
      const response = await fetch(`https://data.sec.gov/submissions/CIK${cik}.json`, { headers })
      if (!response.ok) { missing.push(symbol); continue }
      const data = await response.json()
      const recent = data.filings?.recent ?? {}
      for (let index = 0; index < (recent.form?.length ?? 0); index++) {
        const form = recent.form[index]
        const filedAt = Date.parse(`${recent.filingDate?.[index]}T12:00:00Z`)
        if (!acceptedForms.has(form) || !Number.isFinite(filedAt) || filedAt < cutoff) continue
        const accession = recent.accessionNumber[index]
        const accessionCompact = String(accession).replace(/-/g, '')
        const primaryDocument = recent.primaryDocument?.[index]
        events.push({
          id: `sec:${accession}`, underlyingKey: `equity:${symbol}`, symbol, cik,
          eventType: form.startsWith('10-Q') || form.startsWith('10-K') ? 'financial_filing' : 'material_filing',
          form, title: `${form} · ${company.title}`, announcedAt: filedAt, effectiveAt: filedAt,
          severity: form.startsWith('8-K') || form.startsWith('6-K') ? 'caution' : 'info',
          source: 'sec', sourceId: accession, confirmed: true,
          url: `https://www.sec.gov/Archives/edgar/data/${Number(cik)}/${accessionCompact}/${primaryDocument}`,
          details: recent.primaryDocDescription?.[index] || form,
        })
      }
    }
    const existing = config.loadOperationalData('companyEvents') ?? []
    const merged = [...events, ...existing.filter(item => !events.some(next => next.id === item.id))]
      .sort((a, b) => (b.announcedAt ?? 0) - (a.announcedAt ?? 0)).slice(0, 2000)
    config.saveOperationalData('companyEvents', merged)
    return { ok: true, events: merged, added: events.length, missing }
  })
  ipcMain.handle('companyEvents:syncEarnings', async (_, { symbols = [], apiKey = '' } = {}) => {
    const requested = new Set(symbols.map(value => String(value).trim().toUpperCase()).filter(Boolean).slice(0, 100))
    if (!requested.size) return { ok: true, events: config.loadOperationalData('companyEvents') ?? [], added: 0 }
    if (!String(apiKey).trim()) throw new Error('请填写 Alpha Vantage API Key')
    const url = new URL('https://www.alphavantage.co/query')
    url.searchParams.set('function', 'EARNINGS_CALENDAR')
    url.searchParams.set('horizon', '3month')
    url.searchParams.set('apikey', String(apiKey).trim())
    const response = await fetch(url, { headers: { Accept: 'text/csv' } })
    if (!response.ok) throw new Error(`财报日历请求失败：HTTP ${response.status}`)
    const text = await response.text()
    if (/^(Information|Error Message|Note)/i.test(text.trim())) throw new Error(text.trim().slice(0, 240))
    const parseCsvLine = line => {
      const values = []; let value = ''; let quoted = false
      for (let index = 0; index < line.length; index++) {
        const char = line[index]
        if (char === '"' && quoted && line[index + 1] === '"') { value += '"'; index++; continue }
        if (char === '"') { quoted = !quoted; continue }
        if (char === ',' && !quoted) { values.push(value); value = ''; continue }
        value += char
      }
      values.push(value); return values
    }
    const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/).filter(Boolean)
    const headers = parseCsvLine(lines.shift() ?? '').map(value => value.trim())
    const events = lines.map(parseCsvLine).map(values => Object.fromEntries(headers.map((header, index) => [header, values[index] ?? ''])))
      .filter(row => requested.has(String(row.symbol).toUpperCase()))
      .flatMap(row => {
        const symbol = String(row.symbol).toUpperCase()
        const reportDate = Date.parse(`${row.reportDate || row.date}T12:00:00Z`)
        if (!Number.isFinite(reportDate)) return []
        const session = /before/i.test(row.reportTime) ? 'before_market' : /after/i.test(row.reportTime) ? 'after_market' : 'unknown'
        return [{
          id: `alphavantage:earnings:${symbol}:${row.reportDate || row.date}`,
          underlyingKey: `equity:${symbol}`, symbol, eventType: 'earnings',
          title: `${symbol} 财报日历`, announcedAt: Date.now(), effectiveAt: reportDate,
          session, fiscalDateEnding: row.fiscalDateEnding || null,
          estimate: row.estimate || null, currency: row.currency || null,
          severity: 'caution', source: 'alphavantage', sourceId: `${symbol}:${row.reportDate || row.date}`,
          confirmed: false, details: `预计财报日 ${row.reportDate || row.date}${session === 'unknown' ? '' : ` · ${session}`}`,
        }]
      })
    const existing = config.loadOperationalData('companyEvents') ?? []
    const merged = [...events, ...existing.filter(item => !events.some(next => next.id === item.id))]
      .sort((a, b) => (b.effectiveAt ?? b.announcedAt ?? 0) - (a.effectiveAt ?? a.announcedAt ?? 0)).slice(0, 2000)
    config.saveOperationalData('companyEvents', merged)
    return { ok: true, events: merged, added: events.length }
  })
  ipcMain.handle('settings:cleanupInstallers', () => cleanupOldInstallers())

  ipcMain.handle('settings:exportConfig', async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    const result = await dialog.showSaveDialog(win, {
      title: '导出 RSI-inspection 配置',
      defaultPath: `RSI-inspection-config-${new Date().toISOString().slice(0, 10)}.json`,
      filters: [{ name: 'JSON', extensions: ['json'] }],
    })
    if (result.canceled || !result.filePath) return { canceled: true }
    fs.writeFileSync(result.filePath, JSON.stringify(config.exportUserConfig(), null, 2), 'utf8')
    return { ok: true, filePath: result.filePath }
  })

  ipcMain.handle('settings:exportDiagnostics', async (event, rendererData = {}) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    const result = await dialog.showSaveDialog(win, {
      title: '导出脱敏诊断包',
      defaultPath: `RSI-inspection-diagnostics-${new Date().toISOString().slice(0, 10)}.zip`,
      filters: [{ name: 'ZIP', extensions: ['zip'] }],
    })
    if (result.canceled || !result.filePath) return { canceled: true }
    const summary = sanitizeDiagnostics({
      exportedAt: new Date().toISOString(),
      appVersion: app.getVersion(),
      diagnostics: config.getDiagnostics(),
      jobs: codexJobLog().slice(0, 30),
      signalHunter: rendererData,
    })
    const readme = 'RSI-inspection 脱敏诊断包\n不包含令牌、Webhook、密码、完整用户路径或原始行情数据。\n'
    fs.writeFileSync(result.filePath, createStoredZip([
      ['README.txt', readme],
      ['diagnostics.json', JSON.stringify(summary, null, 2)],
    ]))
    return { ok: true, filePath: result.filePath }
  })

  ipcMain.handle('settings:importConfig', async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    const result = await dialog.showOpenDialog(win, {
      title: '导入 RSI-inspection 配置',
      properties: ['openFile'],
      filters: [{ name: 'JSON', extensions: ['json'] }],
    })
    if (result.canceled || !result.filePaths?.[0]) return { canceled: true }
    const payload = JSON.parse(fs.readFileSync(result.filePaths[0], 'utf8'))
    config.importUserConfig(payload)
    return { ok: true, filePath: result.filePaths[0] }
  })

  ipcMain.handle('settings:checkUpdates', async (_, openRelease = true) => {
    const res = await fetch('https://api.github.com/repos/waruiiko/RSI-inspection/releases/latest', {
      headers: { 'User-Agent': 'RSI-inspection' },
    })
    if (!res.ok) throw new Error(`GitHub ${res.status}`)
    const release = await res.json()
    if (openRelease && release.html_url) shell.openExternal(release.html_url)
    return { ok: true, tag: release.tag_name, url: release.html_url, name: release.name }
  })

  ipcMain.handle('settings:getAutoLaunch', () =>
    app.getLoginItemSettings().openAtLogin
  )
  ipcMain.handle('settings:setAutoLaunch', (_, enabled) => {
    app.setLoginItemSettings({ openAtLogin: !!enabled })
    return { ok: true }
  })

  ipcMain.handle('codex:status', async () => {
    return codexReview.getStatus(config.loadSettings())
  })

  ipcMain.handle('codex:runReview', async (_, payload) => {
    return enqueueCodexJob('review', payload, () => codexReview.runReview(payload, config.loadSettings()))
  })

  ipcMain.handle('codex:runScreen', async (event, payload) => {
    return enqueueCodexJob('screen', payload, () => codexReview.runScreen(
      payload,
      config.loadSettings(),
      progress => event.sender.send('codex:screenProgress', progress),
    ))
  })

  ipcMain.handle('codex:runLaunchReview', async (_, payload) => {
    return enqueueCodexJob('launch-review', payload, () => codexReview.runLaunchReview(payload, config.loadSettings()))
  })

  ipcMain.handle('codex:runMarketChat', async (_, payload) => {
    return enqueueCodexJob('market-chat', payload, () => codexReview.runMarketChat(payload, config.loadSettings()))
  })

  ipcMain.handle('codex:runManagePlan', async (_, payload) => {
    return enqueueCodexJob('manage-plan', payload, () => codexReview.runManagePlan(payload, config.loadSettings()))
  })

  ipcMain.handle('codex:runAlertPlan', async (_, payload) => {
    return enqueueCodexJob('alert-plan', payload, () => codexReview.runAlertPlan(payload, config.loadSettings()))
  })
  ipcMain.handle('codex:jobs', () => codexJobLog())
  ipcMain.handle('codex:screenRuntime', () => codexReview.getScreenRuntimeState(config.loadSettings()))
  ipcMain.handle('codex:resetScreenRuntime', (_, scope) => codexReview.resetScreenRuntime(scope))
  ipcMain.handle('codex:cleanupScreenRuns', (_, options) => codexReview.cleanupScreenRuns(options))
  ipcMain.handle('codex:cancelJobs', () => {
    const jobs = codexJobLog()
    for (const job of jobs) if (job.status === 'queued' || job.status === 'running') _cancelledCodexJobs.add(job.id)
    const active = codexReview.cancelActive()
    for (const job of jobs) {
      if (job.status === 'queued' || job.status === 'running') saveCodexJob({ ...job, status: 'cancelled', completedAt: Date.now(), error: '用户取消' })
    }
    return { ok: true, active }
  })

  ipcMain.handle('shell:openPath', async (_, target) => {
    if (!target) return { ok: false, error: 'Missing path' }
    const result = await shell.openPath(target)
    return result ? { ok: false, error: result } : { ok: true }
  })
  ipcMain.handle('shell:openExternal', async (_, target) => {
    const url = new URL(String(target || ''))
    if (url.protocol !== 'https:' || !['www.sec.gov', 'sec.gov'].includes(url.hostname)) throw new Error('只允许打开 SEC HTTPS 链接')
    await shell.openExternal(url.toString())
    return { ok: true }
  })

  // Streaming: returns immediately, pushes chunks via event as each asset finishes
  ipcMain.handle('market:fetch', async (event, {
    timeframes = DEFAULT_TIMEFRAMES,
    rsiPeriod = 14,
    requestId = Date.now(),
    limit = null,
    scope = 'full',
    suppressAlerts = false,
  } = {}) => {
    await ensureTradFiOnboarded()
    const assets        = getRuntimeAll()
    const normalizedAssets = assets.map(normalizeAsset)
    let cryptoAssets  = normalizedAssets.filter(a => a.source === 'binance')
    let futuresAssets = normalizedAssets.filter(a => a.source === 'binance-futures')
    let stockAssets   = normalizedAssets.filter(a => a.source === 'yahoo')

    const status = []
    const push = (data) => {
      if (!event.sender.isDestroyed()) event.sender.send('market:chunk', { requestId, data })
    }
    const pushStatus = (item) => {
      status.push({ ...item, ts: Date.now() })
      if (!event.sender.isDestroyed()) event.sender.send('market:status', { requestId, item: status.at(-1) })
    }

    // Fetch spot + futures tickers independently, so one failed endpoint
    // does not discard the other endpoint's turnover data.
    let spotTickers = {}, futuresTickers = {}
    const [spotTickerResult, futuresTickerResult, spotBookResult, futuresBookResult] = await Promise.allSettled([
      binance.fetchTickers(cryptoAssets.map(a => a.apiSymbol)),
      binance.fetchFuturesTickers(futuresAssets.map(a => a.apiSymbol)),
      binance.fetchBookTickers(cryptoAssets.map(a => a.apiSymbol)),
      binance.fetchFuturesBookTickers(futuresAssets.map(a => a.apiSymbol)),
    ])
    if (spotTickerResult.status === 'fulfilled') spotTickers = spotTickerResult.value
    else {
      const message = spotTickerResult.reason?.message ?? String(spotTickerResult.reason)
      console.warn('[ipc] spot ticker fetch failed:', message)
      pushStatus({ level: 'warn', scope: 'Binance spot ticker', message })
    }
    if (futuresTickerResult.status === 'fulfilled') futuresTickers = futuresTickerResult.value
    else {
      const message = futuresTickerResult.reason?.message ?? String(futuresTickerResult.reason)
      console.warn('[ipc] futures ticker fetch failed:', message)
      pushStatus({ level: 'warn', scope: 'Binance futures ticker', message })
    }
    if (spotBookResult.status === 'fulfilled') {
      for (const [symbol, book] of Object.entries(spotBookResult.value)) {
        spotTickers[symbol] = { ...(spotTickers[symbol] ?? {}), ...book }
      }
    } else {
      const message = spotBookResult.reason?.message ?? String(spotBookResult.reason)
      pushStatus({ level: 'warn', scope: 'Binance spot book', message })
    }
    if (futuresBookResult.status === 'fulfilled') {
      for (const [symbol, book] of Object.entries(futuresBookResult.value)) {
        futuresTickers[symbol] = { ...(futuresTickers[symbol] ?? {}), ...book }
      }
    } else {
      const message = futuresBookResult.reason?.message ?? String(futuresBookResult.reason)
      pushStatus({ level: 'warn', scope: 'Binance futures book', message })
    }

    if (limit && Number.isFinite(limit)) {
      const ranked = [...cryptoAssets, ...futuresAssets]
        .map(asset => ({
          asset,
          volume: tickerVolume(resolveTicker(asset.source === 'binance' ? spotTickers : futuresTickers, asset)),
        }))
        .sort((a, b) => b.volume - a.volume)
        .slice(0, limit)
        .map(x => x.asset)
      const top = new Set(ranked.map(a => `${a.source}:${a.apiSymbol}`))
      cryptoAssets = cryptoAssets.filter(a => top.has(`${a.source}:${a.apiSymbol}`))
      futuresAssets = futuresAssets.filter(a => top.has(`${a.source}:${a.apiSymbol}`))
      stockAssets = []
    }

    const cryptoJob = runWithConcurrency(cryptoAssets, 4, async asset => {
      try {
        const result = await buildResult(asset, timeframes, spotTickers, rsiPeriod)
        if (result) push(result)
      } catch (err) {
        console.warn(`[ipc] ${asset.symbol}: ${err.message}`)
        pushStatus({ level: 'warn', scope: asset.symbol, message: err.message })
      }
    })

    const futuresJob = runWithConcurrency(futuresAssets, 4, async asset => {
      try {
        const result = await buildResult(asset, timeframes, futuresTickers, rsiPeriod)
        if (result) push(result)
      } catch (err) {
        console.warn(`[ipc] ${asset.symbol}: ${err.message}`)
        pushStatus({ level: 'warn', scope: asset.symbol, message: err.message })
      }
    })

    // Stocks: serial — Yahoo throttle is enforced inside yahoo.js; skip when market is closed
    const stockMarketOpen = isUSMarketOpen()
    const skipStocks = !stockMarketOpen && shouldSkipStocksWhenClosed(scope)
    if (skipStocks && stockAssets.length) {
      pushStatus({
        level: 'info',
        scope: 'US stocks',
        message: `Skipped ${stockAssets.length} stocks while US market is closed (${scope})`,
      })
    }

    const stockJob = !skipStocks
      ? (async () => {
          for (const asset of stockAssets) {
            try {
              const result = await buildResult(asset, timeframes, {}, rsiPeriod)
              if (result) push(result)
            } catch (err) {
              console.warn(`[ipc] ${asset.symbol}: ${err.message}`)
              pushStatus({ level: 'warn', scope: asset.symbol, message: err.message })
            }
          }
        })()
      : Promise.resolve()

    await Promise.all([cryptoJob, futuresJob, stockJob])

    const updatedAt = Date.now()
    if (!event.sender.isDestroyed()) {
      event.sender.send('market:done', { requestId, updatedAt, status, meta: { scope, limit, timeframes, suppressAlerts } })
    }

    return { ok: true, requestId, updatedAt, meta: { scope, limit, timeframes, suppressAlerts } }
  })

  // Raw OHLCV for future use (candlestick charts, custom indicators, etc.)
  ipcMain.handle('market:ohlcv', async (_, { symbol, source, timeframes = DEFAULT_TIMEFRAMES }) => {
    const asset = { symbol, apiSymbol: symbol, source }
    const result = {}
    for (const tf of timeframes) {
      try { result[tf] = await fetchOHLCV(asset, tf) }
      catch { result[tf] = [] }
    }
    return result
  })

  ipcMain.handle('market:signalReplay', async (_, { assets = [], maxAssets = 12 } = {}) => {
    const selected = assets.slice(0, Math.max(1, Math.min(30, maxAssets))).map(normalizeAsset)
    const replaySettings = config.loadSettings()
    const executionNotional = [1000, 5000, 10000].includes(Number(replaySettings.shExecutionNotional))
      ? Number(replaySettings.shExecutionNotional)
      : 5000
    const reports = []
    for (const asset of selected) {
      for (const timeframe of ['1h', '4h']) {
        try {
          const candles = onlyClosedCandles(await fetchSignalReplayCandles(asset, timeframe))
          reports.push(runSignalHunterReplay(asset, timeframe, candles, executionNotional))
        } catch (err) {
          reports.push({ symbol: asset.symbol, timeframe, error: err.message, signals: 0, outcomes: [] })
        }
      }
    }
    const outcomes = reports.flatMap(report => report.outcomes ?? [])
    const resolved = outcomes.filter(item => item.result === 'win' || item.result === 'loss')
    const wins = resolved.filter(item => item.result === 'win')
    const losses = resolved.filter(item => item.result === 'loss')
    const profileGroups = Object.values(outcomes.reduce((groups, item) => {
      const key = item.parameterProfile ?? 'default'
      const group = groups[key] ?? { key, signals: 0, wins: 0, losses: 0, netR: 0 }
      group.signals += 1
      if (item.result === 'win') group.wins += 1
      if (item.result === 'loss') group.losses += 1
      group.netR += item.rMultiple ?? 0
      groups[key] = group
      return groups
    }, {})).map(group => ({
      ...group,
      winRate: group.wins + group.losses ? group.wins / (group.wins + group.losses) : null,
    }))
    const report = {
      createdAt: Date.now(),
      assets: selected.length,
      reports,
      totalSignals: outcomes.length,
      resolved: resolved.length,
      wins: wins.length,
      losses: losses.length,
      ambiguous: outcomes.filter(item => item.result === 'ambiguous').length,
      expired: outcomes.filter(item => item.result === 'expired').length,
      winRate: resolved.length ? wins.length / resolved.length : null,
      netR: resolved.reduce((sum, item) => sum + (item.rMultiple ?? 0), 0),
      profileGroups,
      mode: 'structure_walk_forward',
      executionNotional,
      limitations: ['不回放历史OI/资金费率', '历史盘口使用流动性代理', '同K线顺序不明按歧义样本处理'],
    }
    const history = config.loadSignalReplayHistory()
    const persistedReport = {
      ...report,
      reports: report.reports.map(({ outcomes: _outcomes, ...summary }) => summary),
    }
    config.saveSignalReplayHistory([persistedReport, ...history])
    return report
  })
}

async function fetchSignalReplayCandles(asset, timeframe) {
  if (asset.source === 'binance-futures') return binance.fetchFuturesKlines(asset.apiSymbol, timeframe, 1000)
  if (asset.source === 'binance') return binance.fetchKlines(asset.apiSymbol, timeframe, 1000)
  return fetchOHLCVWithRetry(asset, timeframe)
}

function cleanupOldInstallers() {
  const distDir = path.join(__dirname, '..', 'dist')
  if (!fs.existsSync(distDir)) return { ok: true, removed: [], kept: null }
  const installers = fs.readdirSync(distDir)
    .filter(name => /^市场RSI热力图 Setup .*\.exe$/.test(name))
    .map(name => {
      const file = path.join(distDir, name)
      return { name, file, mtime: fs.statSync(file).mtimeMs }
    })
    .sort((a, b) => b.mtime - a.mtime)
  const kept = installers[0] ?? null
  const removed = []
  for (const item of installers.slice(1)) {
    for (const file of [item.file, `${item.file}.blockmap`]) {
      try {
        if (fs.existsSync(file)) {
          fs.rmSync(file, { force: true })
          removed.push(path.basename(file))
        }
      } catch {}
    }
  }
  return { ok: true, kept: kept?.name ?? null, removed }
}

function shouldSkipStocksWhenClosed(scope) {
  const key = String(scope || '')
  return key.startsWith('auto-') || key.startsWith('scheduled-')
}

async function runWithConcurrency(items, concurrency, worker) {
  let nextIndex = 0
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (nextIndex < items.length) {
      const item = items[nextIndex++]
      await worker(item)
    }
  })
  await Promise.all(workers)
}

function getIndicatorWorker() {
  if (_indicatorWorker) return _indicatorWorker
  const workerPath = path.join(__dirname, 'indicatorWorker.js')
  const resolvedWorkerPath = app.isPackaged
    ? workerPath.replace('app.asar', 'app.asar.unpacked')
    : workerPath
  _indicatorWorker = new Worker(resolvedWorkerPath)
  _indicatorWorker.on('message', msg => {
    const pending = _indicatorPending.get(msg.id)
    if (!pending) return
    _indicatorPending.delete(msg.id)
    msg.ok ? pending.resolve(msg.result) : pending.reject(new Error(msg.error || 'indicator worker failed'))
  })
  _indicatorWorker.on('error', err => {
    for (const pending of _indicatorPending.values()) pending.reject(err)
    _indicatorPending.clear()
    _indicatorWorker = null
  })
  _indicatorWorker.on('exit', code => {
    if (code !== 0) {
      for (const pending of _indicatorPending.values()) pending.reject(new Error(`indicator worker exited: ${code}`))
      _indicatorPending.clear()
    }
    _indicatorWorker = null
  })
  return _indicatorWorker
}

function computeIndicatorData(payload) {
  const id = ++_indicatorSeq
  return new Promise((resolve, reject) => {
    _indicatorPending.set(id, { resolve, reject })
    getIndicatorWorker().postMessage({ id, payload })
  })
}

async function buildResult(asset, timeframes, tickers, rsiPeriod = 14) {
  const candlesByTf = {}
  const closedCandlesByTf = {}
  for (const tf of timeframes) {
    try {
      candlesByTf[tf] = await fetchOHLCVWithRetry(asset, tf)
      closedCandlesByTf[tf] = onlyClosedCandles(candlesByTf[tf])
    } catch (err) {
      console.warn(`[ipc] ${asset.symbol} ${tf}: ${err.message}`)
      candlesByTf[tf] = []
      closedCandlesByTf[tf] = []
    }
  }

  const { rsi, sparkline, divergence, volumeSignal, signalScore } = await computeIndicatorData({
    closedCandlesByTf,
    timeframes,
    rsiPeriod,
  })
  if (Object.keys(rsi).length === 0) return null

  // Price from ticker (crypto) or last candle (stocks)
  let price = null, change24h = null, quoteVolume24h = null
  const ticker = resolveTicker(tickers, asset)
  if (ticker) {
    price = ticker.price
    change24h = ticker.change24h
    quoteVolume24h = toNumber(ticker.quoteVolume24h ?? ticker.volume24h)
  } else {
    for (const tf of timeframes) {
      if (closedCandlesByTf[tf]?.length) { price = closedCandlesByTf[tf].at(-1).close; break }
    }
  }

  if (quoteVolume24h == null) quoteVolume24h = estimateTurnover(closedCandlesByTf)
  const liquidity = ticker ? {
    bidPrice: toNumber(ticker.bidPrice),
    askPrice: toNumber(ticker.askPrice),
    bidQty: toNumber(ticker.bidQty),
    askQty: toNumber(ticker.askQty),
    spreadPct: toNumber(ticker.spreadPct),
    topBookNotional: toNumber(ticker.topBookNotional),
    source: Number.isFinite(toNumber(ticker.spreadPct)) ? 'book_ticker' : 'turnover_proxy',
    fetchedAt: Date.now(),
  } : {
    spreadPct: null,
    topBookNotional: null,
    source: 'turnover_proxy',
    fetchedAt: Date.now(),
  }

  const derivatives = asset.source === 'binance-futures'
    ? await fetchDerivativesSnapshot(asset, closedCandlesByTf, rsi, volumeSignal, signalScore)
    : null
  const marketSession = asset.source === 'yahoo' ? getUSMarketSession() : 'continuous'
  const dataQualityIssues = []
  if (!Number.isFinite(price) || price <= 0) dataQualityIssues.push('现价缺失')
  for (const tf of ['1h', '4h']) {
    if ((closedCandlesByTf[tf]?.length ?? 0) < 36) dataQualityIssues.push(`${tf} K线不足`)
  }
  if ((asset.source === 'binance' || asset.source === 'binance-futures') && !Number.isFinite(liquidity.spreadPct)) {
    dataQualityIssues.push('实时盘口缺失')
  }
  if (asset.source === 'binance-futures' && derivatives?.oiValue == null && derivatives?.fundingRate == null) {
    dataQualityIssues.push('OI与资金费率缺失')
  }
  const dataQuality = {
    ok: dataQualityIssues.length === 0,
    issues: dataQualityIssues,
    checkedAt: Date.now(),
  }
  const shSettings = config.loadSettings()
  const executionNotional = [1000, 5000, 10000].includes(Number(shSettings.shExecutionNotional))
    ? Number(shSettings.shExecutionNotional)
    : 5000
  const parameterMode = shSettings.shParameterMode === 'shadow' ? 'shadow' : 'stable'

  let signalHunter = buildSignalHunterSignal({
    asset,
    price,
    change24h,
    quoteVolume24h,
    candlesByTf: closedCandlesByTf,
    rsi,
    volumeSignal,
    signalScore,
    derivatives,
    liquidity,
    assetSource: asset.source,
    marketSession,
    dataQuality,
    executionNotional,
    parameterMode,
  })
  if (signalHunter && !signalHunter.rejected && (asset.source === 'binance' || asset.source === 'binance-futures')) {
    try {
      liquidity.depth = await binance.fetchOrderBookDepth(asset.apiSymbol, asset.source === 'binance-futures', 20)
      signalHunter = buildSignalHunterSignal({
        asset,
        price,
        change24h,
        quoteVolume24h,
        candlesByTf: closedCandlesByTf,
        rsi,
        volumeSignal,
        signalScore,
        derivatives,
        liquidity,
        executionNotional,
        parameterMode,
      })
    } catch (err) {
      liquidity.depthError = err.message
      dataQuality.ok = false
      dataQuality.issues.push('多档盘口深度获取失败')
      signalHunter = buildSignalHunterSignal({
        asset, price, change24h, quoteVolume24h, candlesByTf: closedCandlesByTf,
        rsi, volumeSignal, signalScore, derivatives, liquidity, executionNotional, parameterMode,
      })
    }
  }

  const reviewCandlesByTf = Object.fromEntries(
    ['15m', '1h', '4h'].map(tf => [
      tf,
      (closedCandlesByTf[tf] ?? []).slice(-72).map(c => ({
        time: c.time,
        high: c.high,
        low: c.low,
        close: c.close,
        closeTime: c.closeTime,
      })),
    ])
  )

  return { ...asset, price, change24h, quoteVolume24h, liquidity, marketSession, dataQuality, rsi, sparkline, divergence, volumeSignal, signalScore, derivatives, signalHunter, reviewCandlesByTf }
}

async function fetchDerivativesSnapshot(asset, candlesByTf, rsi, volumeSignal, signalScore) {
  const [oiResult, premiumResult] = await Promise.allSettled([
    binance.fetchFuturesOpenInterestHist(asset.apiSymbol, '1h', 24),
    binance.fetchFuturesPremiumIndex(asset.apiSymbol),
  ])
  const oiHist = oiResult.status === 'fulfilled' ? oiResult.value : []
  const premium = premiumResult.status === 'fulfilled' ? premiumResult.value : null
  return buildDerivativesSignal({ asset, candlesByTf, rsi, volumeSignal, signalScore, oiHist, premium })
}

function lastPctChange(list, bars) {
  if (!Array.isArray(list) || list.length < bars + 1) return null
  const prev = list.at(-(bars + 1))
  const cur = list.at(-1)
  return prev ? pctChange(prev, cur) : null
}

function buildDerivativesSignal({ candlesByTf, rsi, volumeSignal, signalScore, oiHist, premium }) {
  const oiValues = (oiHist ?? []).map(x => toNumber(x.openInterestValue)).filter(v => v != null)
  const oiValue = oiValues.at(-1) ?? null
  const oiChange1h = lastPctChange(oiValues, 1)
  const oiChange4h = lastPctChange(oiValues, 4)
  const oiChange24h = oiValues.length >= 2 ? pctChange(oiValues[0], oiValues.at(-1)) : null
  const fundingRate = premium?.lastFundingRate != null ? premium.lastFundingRate * 100 : null
  const nextFundingTime = premium?.nextFundingTime ?? null
  const c1h = candlesByTf['1h'] ?? []
  const c4h = candlesByTf['4h'] ?? []
  const priceChange1h = c1h.length >= 2 ? pctChange(c1h.at(-2).close, c1h.at(-1).close) : null
  const priceChange4h = c4h.length >= 2 ? pctChange(c4h.at(-2).close, c4h.at(-1).close) : null
  const rsi4h = rsi?.['4h'] ?? null
  const vol4h = volumeSignal?.['4h'] ?? volumeSignal?.['1h'] ?? null
  const baseScore = Math.max(
    Math.abs(signalScore?.['1h'] ?? 0),
    Math.abs(signalScore?.['4h'] ?? 0),
    Math.abs(signalScore?.['1d'] ?? 0),
  )

  let stage = 'neutral'
  let label = '资金中性'
  let score = 0
  const reasons = []
  const cleanFunding = fundingRate == null || Math.abs(fundingRate) <= 0.03
  const crowdedFunding = fundingRate != null && Math.abs(fundingRate) >= 0.06
  const oiUp = (oiChange4h ?? oiChange1h ?? 0) >= 6
  const oiDown = (oiChange4h ?? oiChange1h ?? 0) <= -5
  const priceUp = (priceChange4h ?? priceChange1h ?? 0) >= 2
  const priceDown = (priceChange4h ?? priceChange1h ?? 0) <= -2
  const notExtended = rsi4h == null || rsi4h < 70

  if (oiUp) reasons.push(`OI 4h ${oiChange4h?.toFixed(1) ?? oiChange1h?.toFixed(1)}%`)
  if (fundingRate != null) reasons.push(`费率 ${fundingRate.toFixed(4)}%`)
  if (priceChange4h != null) reasons.push(`价格4h ${priceChange4h >= 0 ? '+' : ''}${priceChange4h.toFixed(1)}%`)

  if (crowdedFunding && ((priceChange4h ?? 0) > 4 || (rsi4h ?? 0) >= 75)) {
    stage = 'crowded'
    label = '过热拥挤'
    score = -3
  } else if (oiUp && !priceUp && !priceDown && cleanFunding && notExtended) {
    stage = 'early_build'
    label = '早期蓄势'
    score = 4
  } else if (oiUp && priceUp && cleanFunding && notExtended) {
    stage = 'long_build'
    label = '多头增仓'
    score = 3
  } else if (oiUp && priceDown) {
    stage = 'short_build'
    label = '空头增仓'
    score = -3
  } else if (oiDown && priceUp) {
    stage = 'short_cover'
    label = '空头回补'
    score = 1
  } else if (oiDown && priceDown) {
    stage = 'deleveraging'
    label = '减仓释放'
    score = -1
  } else if (oiUp && cleanFunding) {
    stage = 'oi_build'
    label = 'OI 增长'
    score = 2
  }

  if (vol4h?.volumeRatio >= 1.5 && score > 0) score += 1
  if (baseScore >= 4 && score > 0) score += 1
  if (crowdedFunding && score > 0) score -= 2
  score = Math.max(-5, Math.min(5, score))

  return {
    capturedAt: Date.now(),
    oiValue,
    oiChange1h,
    oiChange4h,
    oiChange24h,
    fundingRate,
    nextFundingTime,
    priceChange1h,
    priceChange4h,
    stage,
    label,
    score,
    reasons,
  }
}

function signalHunterParameterProfile(asset, quoteVolume24h, version = 'v1') {
  const turnover = quoteVolume24h ?? 0
  let profile
  if (asset.source === 'yahoo') {
    profile = turnover >= 100_000_000
      ? { key: 'stock_liquid', minTurnover: 20_000_000, maxSpreadPct: null, minTopBook: null, maxSlippagePct: null }
      : { key: 'stock_standard', minTurnover: 5_000_000, maxSpreadPct: null, minTopBook: null, maxSlippagePct: null }
  } else if (turnover >= 500_000_000) {
    profile = { key: 'crypto_major', minTurnover: 20_000_000, maxSpreadPct: 0.12, minTopBook: 50_000, maxSlippagePct: 0.18 }
  } else if (turnover >= 50_000_000) {
    profile = { key: 'crypto_liquid', minTurnover: 10_000_000, maxSpreadPct: 0.18, minTopBook: 25_000, maxSlippagePct: 0.25 }
  } else {
    profile = { key: 'crypto_other', minTurnover: 5_000_000, maxSpreadPct: 0.25, minTopBook: 10_000, maxSlippagePct: 0.35 }
  }
  if (version !== 'v2') return { ...profile, version: 'v1' }
  return {
    ...profile,
    key: `${profile.key}_shadow_v2`,
    version: 'v2',
    minTurnover: profile.minTurnover * 1.2,
    maxSpreadPct: Number.isFinite(profile.maxSpreadPct) ? profile.maxSpreadPct * 0.8 : null,
    minTopBook: Number.isFinite(profile.minTopBook) ? profile.minTopBook * 1.25 : null,
    maxSlippagePct: Number.isFinite(profile.maxSlippagePct) ? profile.maxSlippagePct * 0.8 : null,
  }
}

function buildSignalHunterSignal({ asset, price, change24h, quoteVolume24h, candlesByTf, rsi, volumeSignal, signalScore, derivatives, liquidity, executionNotional = 5000, parameterMode = 'stable' }) {
  if (price == null) return null
  const parameterProfile = signalHunterParameterProfile(asset, quoteVolume24h, 'v1')
  const evaluateProfile = profile => ['1h', '4h']
    .flatMap(tf => ['long', 'short'].map(side => evaluateSignalHunterTimeframe({
      side,
      tf,
      price,
      change24h,
      quoteVolume24h,
      candles: candlesByTf[tf],
      rsiValue: rsi?.[tf],
      volumeSignal: volumeSignal?.[tf],
      signalScore: signalScore?.[tf],
      derivatives,
      liquidity,
      assetSource: asset.source,
      marketSession: asset.source === 'yahoo' ? getUSMarketSession() : 'continuous',
      parameterProfile: profile,
      executionNotional,
    })))
    .filter(Boolean)
  const candidates = evaluateProfile(parameterProfile)

  if (!candidates.length) return null
  const ranked = [...candidates].sort((a, b) => b.score.total - a.score.total)
  const accepted = ranked
    .filter(c => !c.rejected)
  const primary = accepted.find(candidate => candidate.executionEligible) ?? accepted[0] ?? ranked[0]
  let shadowComparison = null
  if (parameterMode === 'shadow') {
    const shadowProfile = signalHunterParameterProfile(asset, quoteVolume24h, 'v2')
    const shadowRanked = evaluateProfile(shadowProfile).sort((a, b) => b.score.total - a.score.total)
    const shadowPrimary = shadowRanked.find(item => !item.rejected) ?? shadowRanked[0] ?? null
    shadowComparison = {
      version: 'v2',
      wouldPass: Boolean(shadowPrimary && !shadowPrimary.rejected),
      status: shadowPrimary?.status ?? 'no_candidate',
      side: shadowPrimary?.side ?? null,
      timeframe: shadowPrimary?.timeframe ?? null,
      score: shadowPrimary?.score?.total ?? 0,
      reason: shadowPrimary?.rejectReasons?.[0] ?? shadowPrimary?.reasons?.[0] ?? '',
    }
  }
  return {
    ...primary,
    parameterMode,
    parameterVersion: 'v1',
    shadowComparison,
    structureCandidates: ranked.map(signalHunterStructureSnapshot),
    decisionTrace: [
      { stage: '数据质量', passed: true, detail: '闭合K线与现价可用' },
      { stage: '交易时段', passed: asset.source !== 'yahoo' || getUSMarketSession() === 'regular', detail: asset.source === 'yahoo' ? getUSMarketSession() : 'continuous' },
      { stage: '市场状态', passed: primary.marketRegime !== 'high_volatility', detail: primary.marketRegime ?? '未进入状态判定' },
      { stage: '流动性', passed: !primary.rejectReasons?.some(reason => /成交额|价差|盘口|滑点/.test(reason)), detail: liquidity?.source ?? 'turnover_proxy' },
      { stage: '本地结构', passed: !primary.rejected, detail: primary.rejected ? primary.rejectReasons?.join(' / ') : `${primary.side} · ${primary.timeframe} · ${primary.setupLabel}` },
    ],
  }
}

function signalHunterStructureSnapshot(signal) {
  return {
    status: signal.status,
    rejected: Boolean(signal.rejected),
    side: signal.side,
    timeframe: signal.timeframe,
    entryMode: signal.entryMode,
    setup: signal.setup,
    setupLabel: signal.setupLabel,
    currentPrice: signal.currentPrice,
    entryPrice: signal.entryPrice,
    executionEntryPrice: signal.executionEntryPrice,
    executionSlippagePct: signal.executionSlippagePct,
    executionNotional: signal.executionNotional,
    confirmPrice: signal.confirmPrice,
    stopLoss: signal.stopLoss,
    targets: [signal.tp1, signal.tp2, signal.tp3].filter(Number.isFinite),
    rewardRisk: signal.rewardRisk ?? signal.score?.rewardRisk,
    score: signal.score,
    reasons: signal.reasons ?? [],
    riskFlags: signal.riskFlags ?? [],
    rejectReasons: signal.rejectReasons ?? [],
    support: signal.support,
    supportTouches: signal.supportTouches,
    resistance: signal.resistance,
    resistanceTouches: signal.resistanceTouches,
    compression: signal.compression,
    recentRangePct: signal.recentRangePct,
    volumeRatio: signal.volumeRatio,
    runup10: signal.runup10,
    runup20: signal.runup20,
    ema21: signal.ema21,
    ema55: signal.ema55,
    ema21DistancePct: signal.ema21DistancePct,
    ema21SlopePct: signal.ema21SlopePct,
    atr: signal.atr,
    atrPct: signal.atrPct,
    atrExpansion: signal.atrExpansion,
    efficiencyRatio: signal.efficiencyRatio,
    marketRegime: signal.marketRegime,
    parameterProfile: signal.parameterProfile,
    entryTouched: signal.entryTouched,
    executionEligible: Boolean(signal.executionEligible),
    executionTier: signal.executionTier ?? 'observe',
  }
}

function evaluateSignalHunterTimeframe({ side = 'long', tf, price, change24h, quoteVolume24h, candles, rsiValue, volumeSignal, signalScore, derivatives, liquidity, assetSource, marketSession, parameterProfile, executionNotional = 5000 }) {
  if (!Array.isArray(candles) || candles.length < 36) return null
  const isShort = side === 'short'
  const lookback = candles.slice(-41, -1)
  const recent = candles.slice(-10)
  if (!candles.at(-1) || !candles.at(-2) || lookback.length < 20) return null

  const resistanceZone = findSignalHunterResistance(lookback, price, tf)
  const supportZone = findSignalHunterSupportZone(lookback, price, tf)
  const support = findSignalHunterSupport(lookback)
  if (!Number.isFinite(support) || support <= 0) return null
  const highFallback = finiteMax(lookback.map(c => c.high))
  const lowFallback = finiteMin(lookback.map(c => c.low))
  const bufferPct = tf === '15m' ? 0.001 : tf === '1h' ? 0.0015 : 0.002
  const resistance = resistanceZone ?? (Number.isFinite(highFallback) ? {
    level: highFallback,
    triggerPrice: highFallback * (1 + bufferPct),
    touches: 0,
    bufferPct: bufferPct * 100,
    fallback: true,
  } : null)
  const supportArea = supportZone ?? (Number.isFinite(lowFallback) ? {
    level: Math.max(lowFallback, support),
    triggerPrice: Math.max(lowFallback, support) * (1 - bufferPct),
    touches: 0,
    bufferPct: bufferPct * 100,
    fallback: true,
  } : null)
  if (!resistance || !supportArea) return null

  const reject = (rejectReason, extra = {}) => ({
    rejected: true,
    status: 'rejected',
    side,
    timeframe: tf,
    currentPrice: price,
    score: { total: 0, chart: 0, data: 0, risk: 0, rr: 0, rewardRisk: 0 },
    reasons: [],
    riskFlags: [],
    rejectReasons: [rejectReason],
    ...extra,
  })

  const recentHigh = Math.max(...recent.map(c => c.high))
  const recentLow = Math.min(...recent.map(c => c.low))
  const recentRangePct = pctChange(recentLow, recentHigh)
  const wider = candles.slice(-31, -10)
  const widerHigh = Math.max(...wider.map(c => c.high))
  const widerLow = Math.min(...wider.map(c => c.low))
  const widerRangePct = pctChange(widerLow, widerHigh)
  const avgVol20 = avg(lookback.slice(-20).map(candleVolume))
  const avgVol5 = avg(recent.slice(-5).map(candleVolume))
  const closes = candles.map(c => c.close).filter(Number.isFinite)
  const ma21 = avg(candles.slice(-21).map(c => c.close))
  const ema21 = ema(closes.slice(-80), 21)
  const ema55 = ema(closes.slice(-120), 55)
  const ema21Prev = ema(closes.slice(0, -4).slice(-80), 21)
  const ema21SlopePct = Number.isFinite(ema21Prev) && Number.isFinite(ema21) ? pctChange(ema21Prev, ema21) : null
  const trueRanges = candles.slice(-62).map((candle, index, list) => {
    const prevClose = index > 0 ? list[index - 1]?.close : null
    if (!Number.isFinite(candle.high) || !Number.isFinite(candle.low)) return null
    if (!Number.isFinite(prevClose)) return candle.high - candle.low
    return Math.max(candle.high - candle.low, Math.abs(candle.high - prevClose), Math.abs(candle.low - prevClose))
  }).filter(Number.isFinite)
  const atr = avg(trueRanges.slice(-14))
  const baselineAtr = avg(trueRanges.slice(-56, -14))
  const atrExpansion = Number.isFinite(atr) && Number.isFinite(baselineAtr) && baselineAtr > 0 ? atr / baselineAtr : null
  const atrPct = Number.isFinite(atr) && price ? (atr / price) * 100 : null
  const efficiencyCloses = closes.slice(-21)
  const efficiencyTravel = efficiencyCloses.slice(1).reduce((sum, close, index) => sum + Math.abs(close - efficiencyCloses[index]), 0)
  const efficiencyRatio = efficiencyCloses.length >= 10 && efficiencyTravel > 0
    ? Math.abs(efficiencyCloses.at(-1) - efficiencyCloses[0]) / efficiencyTravel
    : null
  const runup10 = candles.length >= 11 ? pctChange(candles.at(-11).close, price) : 0
  const runup20 = candles.length >= 21 ? pctChange(candles.at(-21).close, price) : 0
  const extensionPct = ma21 ? pctChange(ma21, price) : 0
  const ema21DistancePct = ema21 ? pctChange(ema21, price) : 0
  const volumeRatio = avgVol20 ? avgVol5 / avgVol20 : null
  const compression = Number.isFinite(widerRangePct) && recentRangePct > 0 && (
    recentRangePct <= widerRangePct * 0.72 ||
    (tf === '15m' ? recentRangePct <= 2.2 : tf === '1h' ? recentRangePct <= 3.5 : recentRangePct <= 5.5)
  )
  const volumeDry = volumeRatio != null && volumeRatio <= 0.88
  const highVolatility = (Number.isFinite(atrExpansion) && atrExpansion >= 1.45) ||
    (Number.isFinite(atrPct) && atrPct >= (tf === '4h' ? 7 : 4))
  const directionalTrend = Number.isFinite(efficiencyRatio) && efficiencyRatio >= 0.38 &&
    Number.isFinite(ema21SlopePct) && Math.abs(ema21SlopePct) >= (tf === '4h' ? 0.35 : 0.18)
  const lowVolatility = !highVolatility && compression && (volumeDry || (Number.isFinite(atrExpansion) && atrExpansion <= 0.82))
  const rangeRegime = !highVolatility && !directionalTrend && Number.isFinite(efficiencyRatio) && efficiencyRatio <= 0.28
  const marketRegime = highVolatility ? 'high_volatility'
    : directionalTrend ? 'trend'
      : lowVolatility ? 'low_volatility'
        : rangeRegime ? 'range'
          : 'transition'
  const confirmPrice = isShort ? supportArea.triggerPrice : resistance.triggerPrice
  const distanceToConfirmPct = isShort ? pctChange(confirmPrice, price) : pctChange(price, confirmPrice)
  const nearConfirm = distanceToConfirmPct >= -0.35 && distanceToConfirmPct <= (tf === '15m' ? 1.4 : tf === '1h' ? 2.2 : 3.2)
  const breakoutAttempt = isShort
    ? volumeSignal?.type === 'breakdown_attempt' || volumeSignal?.type === 'breakdown_confirmed'
    : volumeSignal?.type === 'breakout_attempt' || volumeSignal?.type === 'breakout_confirmed'
  const cleanFunding = derivatives?.fundingRate == null || Math.abs(derivatives.fundingRate) <= 0.03
  const oiRising = (derivatives?.oiChange4h ?? derivatives?.oiChange1h ?? 0) >= 3
  const maxRunup10 = tf === '15m' ? 3.5 : tf === '1h' ? 5.5 : 8
  const maxRunup20 = tf === '15m' ? 6 : tf === '1h' ? 9 : 14
  const maxExtension = tf === '15m' ? 2.8 : tf === '1h' ? 4.2 : 6.5
  const overExtendedShape = isShort
    ? runup10 < -maxRunup10 || runup20 < -maxRunup20 || extensionPct < -maxExtension
    : runup10 > maxRunup10 || runup20 > maxRunup20 || extensionPct > maxExtension

  if ((quoteVolume24h ?? 0) < (parameterProfile?.minTurnover ?? 5_000_000)) return reject(`成交额不足 (${parameterProfile?.key ?? 'default'})`)
  if ((assetSource === 'binance' || assetSource === 'binance-futures') && !Number.isFinite(liquidity?.spreadPct)) return reject('实时盘口数据缺失')
  if (assetSource === 'binance-futures' && derivatives?.oiValue == null && derivatives?.fundingRate == null) return reject('OI与资金费率数据缺失')
  if (assetSource === 'yahoo' && marketSession !== 'regular') return reject(`美股当前为 ${marketSession ?? 'closed'} 时段`)
  const latestCandle = candles.at(-1)
  const previousCandle = candles.at(-2)
  const openingGapPct = assetSource === 'yahoo' && Number.isFinite(latestCandle?.open) && Number.isFinite(previousCandle?.close)
    ? Math.abs(pctChange(previousCandle.close, latestCandle.open))
    : 0
  if (openingGapPct >= (tf === '4h' ? 3 : 1.5)) return reject(`开盘跳空 ${openingGapPct.toFixed(2)}%，等待结构重建`)
  if (Number.isFinite(parameterProfile?.maxSpreadPct) && Number.isFinite(liquidity?.spreadPct) && liquidity.spreadPct > parameterProfile.maxSpreadPct) return reject(`买卖价差过大 (${liquidity.spreadPct.toFixed(3)}%)`)
  if (Number.isFinite(parameterProfile?.minTopBook) && Number.isFinite(liquidity?.topBookNotional) && liquidity.topBookNotional < parameterProfile.minTopBook) return reject(`顶层盘口深度不足 (${Math.round(liquidity.topBookNotional).toLocaleString()})`)
  if (liquidity?.depthError) return reject('多档盘口深度不可用')
  if (overExtendedShape) return reject(isShort ? '已经下跌过远，等反抽' : '已经拉升过远，等回踩')

  const baseBandPct = tf === '15m' ? 0.008 : tf === '1h' ? 0.012 : 0.018
  const supportBaseCloses = recent.filter(c => Math.abs(pctChange(supportArea.level, c.close)) <= baseBandPct * 100).length
  const resistanceBaseCloses = recent.filter(c => Math.abs(pctChange(resistance.level, c.close)) <= baseBandPct * 100).length
  const emaPullbackLimit = tf === '15m' ? 1.2 : tf === '1h' ? 2.0 : 3.2
  const retestLimit = tf === '15m' ? 1.2 : tf === '1h' ? 1.8 : 2.8
  const entryBufferPct = tf === '15m' ? 0.001 : tf === '1h' ? 0.0015 : 0.002

  const longEmaPullback = Number.isFinite(ema21) &&
    price >= ema21 * 0.99 &&
    price <= ema21 * (1 + emaPullbackLimit / 100) &&
    (!Number.isFinite(ema55) || ema21 >= ema55 * 0.985)
  const shortEmaRebound = Number.isFinite(ema21) &&
    price <= ema21 * 1.01 &&
    price >= ema21 * (1 - emaPullbackLimit / 100) &&
    (!Number.isFinite(ema55) || ema21 <= ema55 * 1.015)
  const longSupportRetest = price >= supportArea.level && pctChange(supportArea.level, price) <= retestLimit && (supportArea.touches >= 2 || compression)
  const shortResistanceRetest = price <= resistance.level && pctChange(price, resistance.level) <= retestLimit && (resistance.touches >= 2 || compression)
  const longBase = compression && supportBaseCloses >= 4
  const shortBase = compression && resistanceBaseCloses >= 4

  let setup = null
  let setupLabel = ''
  let entryBase = null
  const allowTrendPullback = marketRegime !== 'range'
  if (!isShort) {
    if (allowTrendPullback && longEmaPullback) { setup = 'pullback_long'; setupLabel = 'EMA 回踩多'; entryBase = ema21 }
    else if (longSupportRetest) { setup = 'retest_long'; setupLabel = '支撑回踩多'; entryBase = supportArea.level }
    else if (longBase) { setup = 'base_long'; setupLabel = '窄幅蓄势做多'; entryBase = supportArea.level }
    else if (nearConfirm) { setup = 'confirm_long'; setupLabel = '突破确认观察'; entryBase = null }
  } else {
    if (allowTrendPullback && shortEmaRebound) { setup = 'rebound_short'; setupLabel = 'EMA 反抽空'; entryBase = ema21 }
    else if (shortResistanceRetest) { setup = 'retest_short'; setupLabel = '阻力反抽空'; entryBase = resistance.level }
    else if (shortBase) { setup = 'base_short'; setupLabel = '窄幅蓄势做空'; entryBase = resistance.level }
    else if (nearConfirm) { setup = 'confirm_short'; setupLabel = '跌破确认观察'; entryBase = null }
  }

  if (!setup) return reject('没有回踩/反抽/窄幅蓄势形态')
  const confirmOnly = setup === 'confirm_long' || setup === 'confirm_short'
  const entryMode = setup === 'confirm_long' ? 'breakout'
    : setup === 'confirm_short' ? 'breakdown'
      : setup === 'retest_long' || setup === 'retest_short' ? 'retest'
        : setup === 'base_long' || setup === 'base_short' ? 'base'
          : 'pullback'
  const maxOpposingSlope = tf === '4h' ? 1.1 : 0.6
  const slopeStronglyOpposed = Number.isFinite(ema21SlopePct) && (isShort
    ? ema21SlopePct > maxOpposingSlope
    : ema21SlopePct < -maxOpposingSlope)
  if (slopeStronglyOpposed) {
    return reject(`EMA21 斜率与${isShort ? '空头' : '多头'}方向冲突 (${ema21SlopePct.toFixed(2)}%)`, {
      setup,
      setupLabel,
      entryMode,
      ema21,
      ema55,
      ema21SlopePct,
    })
  }
  const trendSetup = setup === 'pullback_long' || setup === 'rebound_short'
  const baseSetup = setup === 'base_long' || setup === 'base_short'
  if (marketRegime === 'high_volatility') {
    return reject('高波动扩张期，结构稳定性不足', { setup, setupLabel, entryMode, marketRegime, atrPct, atrExpansion, efficiencyRatio })
  }
  if (trendSetup && marketRegime === 'range') {
    return reject('区间环境不启用趋势回踩模型', { setup, setupLabel, entryMode, marketRegime, atrPct, atrExpansion, efficiencyRatio })
  }
  if (baseSetup && marketRegime === 'trend') {
    return reject('趋势环境不启用区间蓄势模型', { setup, setupLabel, entryMode, marketRegime, atrPct, atrExpansion, efficiencyRatio })
  }
  if (confirmOnly) {
    return reject('只有突破确认，没有回踩预埋', {
      setup,
      setupLabel,
      entryMode,
      confirmPrice,
      distanceToConfirmPct,
      reasons: [setupLabel],
      score: { total: 0, chart: 0, data: 0, risk: 0, rr: 0, rewardRisk: 0 },
    })
  }

  const rawEntryPrice = isShort
    ? entryBase * (1 + entryBufferPct)
    : entryBase * (1 - entryBufferPct)
  const maxEntryCrossPct = tf === '4h' ? 0.012 : 0.008
  const entryIsOnTradableSide = isShort
    ? rawEntryPrice >= price * (1 - maxEntryCrossPct)
    : rawEntryPrice <= price * (1 + maxEntryCrossPct)
  if (!entryIsOnTradableSide) {
    return reject(isShort ? '做空入场低于现价，位置无效' : '做多入场高于现价，位置无效', {
      setup,
      setupLabel,
      entryMode,
      entryPrice: rawEntryPrice,
      confirmPrice,
      distanceToConfirmPct,
    })
  }

  const entryPrice = rawEntryPrice
  const distanceToEntryPct = pctChange(price, entryPrice)
  const nearEntry = Math.abs(distanceToEntryPct) <= (tf === '15m' ? 1.6 : tf === '1h' ? 2.6 : 4.0)
  const depthExecution = liquidity?.depth?.[isShort ? 'sell' : 'buy']?.[String(executionNotional)] ?? null
  if (depthExecution && depthExecution.fillRatio < 0.98) return reject(`预计 $${executionNotional.toLocaleString()} 无法在前20档充分成交`, { setup, setupLabel, entryMode })
  if (Number.isFinite(depthExecution?.slippagePct) && depthExecution.slippagePct > (parameterProfile?.maxSlippagePct ?? 0.35)) {
    return reject(`预计滑点过高 (${depthExecution.slippagePct.toFixed(3)}%)`, { setup, setupLabel, entryMode })
  }
  const executionSlippagePct = Number.isFinite(depthExecution?.slippagePct) ? depthExecution.slippagePct : 0
  const triggerPrice = isShort
    ? entryPrice * (1 - executionSlippagePct / 100)
    : entryPrice * (1 + executionSlippagePct / 100)
  const touchWindow = recent.slice(-3)
  const entryTouched = touchWindow.some(candle => {
    if (!Number.isFinite(candle.high) || !Number.isFinite(candle.low) || !Number.isFinite(candle.close)) return false
    const range = Math.max(candle.high - candle.low, entryPrice * 0.0001)
    const closePosition = (candle.close - candle.low) / range
    return isShort
      ? candle.high >= entryPrice * 0.999 && candle.close <= entryPrice * 1.002 && closePosition <= 0.58
      : candle.low <= entryPrice * 1.001 && candle.close >= entryPrice * 0.998 && closePosition >= 0.42
  })
  const triggered = entryTouched && (isShort
    ? price <= entryPrice * 1.006
    : price >= entryPrice * 0.994)
  const verticalNoChase = isShort
    ? runup10 < -maxRunup10 * 0.7 || runup20 < -maxRunup20 * 0.7 || ema21DistancePct < -maxExtension * 0.55
    : runup10 > maxRunup10 * 0.7 || runup20 > maxRunup20 * 0.7 || ema21DistancePct > maxExtension * 0.55
  if (verticalNoChase) return reject(isShort ? '跌得太直，等反抽' : '涨得太直，等回踩')

  let chart = 0
  let data = 0
  let risk = 0
  const reasons = []
  const riskFlags = []

  if (nearEntry) { chart += 1; reasons.push(`距离入场价 ${distanceToEntryPct.toFixed(2)}%`) }
  if (nearConfirm) { chart += 1; reasons.push(`距离确认价 ${distanceToConfirmPct.toFixed(2)}%`) }
  if (compression) { chart += 1; reasons.push('短线波动压缩') }
  reasons.push(`市场状态 ${marketRegime}`)
  if (setup === 'base_long' || setup === 'base_short') { chart += 2; reasons.push('窄幅蓄势') }
  if (setup === 'pullback_long' || setup === 'rebound_short') { chart += 2; reasons.push(isShort ? 'EMA21 反抽位' : 'EMA21 回踩位') }
  if (setup === 'retest_long' || setup === 'retest_short') { chart += 2; reasons.push(isShort ? '阻力反抽' : '支撑回踩') }
  const slopeAligned = Number.isFinite(ema21SlopePct) && (isShort ? ema21SlopePct < 0 : ema21SlopePct > 0)
  if (slopeAligned) { chart += 1; reasons.push(`EMA21 斜率同向 ${ema21SlopePct.toFixed(2)}%`) }
  if (entryTouched) reasons.push('近 3 根K线已触及入场位')
  if (volumeDry) { chart += 1; reasons.push(`缩量蓄势 ${volumeRatio.toFixed(2)}x`) }
  if (breakoutAttempt) {
    const confirmedType = isShort ? 'breakdown_confirmed' : 'breakout_confirmed'
    chart += volumeSignal.type === confirmedType ? 3 : 1
    reasons.push(volumeSignal.label ?? (isShort ? '跌破尝试' : '突破尝试'))
  }
  if (!isShort && rsiValue >= 45 && rsiValue <= 68) { chart += 1; reasons.push(`${tf} RSI ${rsiValue.toFixed(1)}`) }
  if (isShort && rsiValue >= 32 && rsiValue <= 55) { chart += 1; reasons.push(`${tf} RSI ${rsiValue.toFixed(1)}`) }
  if (!isShort && (signalScore ?? 0) >= 2) chart += 1
  if (isShort && (signalScore ?? 0) <= -2) chart += 1

  if (!isShort && derivatives?.stage === 'early_build') { data += 3; reasons.push('OI 早期蓄势') }
  else if (!isShort && derivatives?.stage === 'long_build') { data += 2; reasons.push('多头增仓') }
  else if (isShort && derivatives?.stage === 'short_build') { data += 3; reasons.push('空头增仓') }
  else if (derivatives?.stage === 'oi_build') { data += 1; reasons.push('OI 增长，方向待确认') }
  const oiDirectionAligned = isShort
    ? derivatives?.stage === 'short_build'
    : derivatives?.stage === 'early_build' || derivatives?.stage === 'long_build'
  if (oiRising && oiDirectionAligned) data += 1
  if (cleanFunding) data += 1
  if ((quoteVolume24h ?? 0) >= 5_000_000) data += 1

  if (!isShort && (change24h ?? 0) >= 12) { risk += 2; riskFlags.push(`24H 已涨 ${change24h.toFixed(1)}%`) }
  if (isShort && (change24h ?? 0) <= -12) { risk += 2; riskFlags.push(`24H 已跌 ${change24h.toFixed(1)}%`) }
  if (!isShort && rsiValue >= 75) { risk += 2; riskFlags.push(`${tf} RSI 过热`) }
  if (isShort && rsiValue <= 25) { risk += 2; riskFlags.push(`${tf} RSI 过冷`) }
  if (Math.abs(derivatives?.fundingRate ?? 0) >= 0.06) { risk += 2; riskFlags.push(`费率拥挤 ${derivatives.fundingRate.toFixed(4)}%`) }
  if ((derivatives?.oiChange4h ?? 0) <= -5) { risk += 2; riskFlags.push(`OI 下降 ${derivatives.oiChange4h.toFixed(1)}%`) }

  chart = Math.min(8, chart)
  data = Math.min(6, data)
  const earlyRiskScore = Math.min(6, risk)
  const earlyTotal = Number(Math.max(0, Math.min(10,
    (chart / 8) * 4 +
    (data / 6) * 2 +
    1 +
    (1 - earlyRiskScore / 6) * 2
  )).toFixed(1))
  if (chart < 4) return reject('图表分不足', { setup, setupLabel, score: { total: earlyTotal, chart, data, risk: earlyRiskScore, rr: 0, rewardRisk: 0 }, reasons })
  if (earlyTotal < 5) return reject('基础评分不足', { setup, setupLabel, score: { total: earlyTotal, chart, data, risk: earlyRiskScore, rr: 0, rewardRisk: 0 }, reasons })

  const atrStopDistance = Number.isFinite(atr) ? atr * (tf === '4h' ? 1 : 0.85) : 0
  const stopLoss = isShort
    ? Math.max(
      resistance.level * (1 + entryBufferPct * 1.8),
      entryPrice * (tf === '15m' ? 1.012 : tf === '1h' ? 1.02 : 1.035),
      entryPrice + atrStopDistance
    )
    : Math.min(
      supportArea.level * (1 - entryBufferPct * 1.8),
      entryPrice * (tf === '15m' ? 0.988 : tf === '1h' ? 0.98 : 0.965),
      entryPrice - atrStopDistance
    )
  const riskPerUnit = Math.abs(triggerPrice - stopLoss)
  if (!Number.isFinite(riskPerUnit) || riskPerUnit <= 0) return reject('止损无效', { setup, setupLabel, entryPrice, stopLoss })
  const mainTarget = isShort
    ? firstFinite(supportArea.level, lowFallback)
    : firstFinite(resistance.level, highFallback)
  const rewardToStructure = Math.abs(mainTarget - triggerPrice)
  const rewardRisk = rewardToStructure / riskPerUnit
  if (!Number.isFinite(rewardRisk) || rewardRisk < 1.5) {
    return reject(`结构目标不足 1.5R (${Number.isFinite(rewardRisk) ? rewardRisk.toFixed(1) : '-'}R)`, {
      setup,
      setupLabel,
      entryPrice,
      confirmPrice,
      stopLoss,
      score: { total: earlyTotal, chart, data, risk: earlyRiskScore, rr: 0, rewardRisk: Number((rewardRisk || 0).toFixed(2)) },
      reasons,
    })
  }
  const rewardMove = Math.abs(mainTarget - triggerPrice)
  const tp1Move = Math.min(Math.max(riskPerUnit, rewardMove * 0.5), rewardMove)
  const tp1 = isShort ? triggerPrice - tp1Move : triggerPrice + tp1Move
  const tp2 = mainTarget
  const tp3Move = Math.max(rewardMove * 1.35, riskPerUnit * 2.2)
  const tp3 = isShort ? triggerPrice - tp3Move : triggerPrice + tp3Move
  const rrScore = rewardRisk >= 2.4 ? 3 : rewardRisk >= 1.8 ? 2 : 1
  const riskScore = Math.min(6, risk)
  const total = Number(Math.max(0, Math.min(10,
    (chart / 8) * 4 +
    (data / 6) * 2 +
    (rrScore / 3) * 2 +
    (1 - riskScore / 6) * 2
  )).toFixed(1))
  if (total < 6) return reject('最终评分不足', { setup, setupLabel, score: { total, chart, data, risk: riskScore, rr: rrScore, rewardRisk: Number(rewardRisk.toFixed(2)) }, reasons })

  // The broader structure detector remains visible, but only trend-aligned EMA
  // pullbacks enter the executable/review cohort. Local cache replay showed the
  // range/retest cohort was the main source of false entries.
  const executionEligible = trendSetup && marketRegime === 'trend' && slopeAligned
  if (!executionEligible) riskFlags.push('观察级结构：等待趋势与EMA回踩同向')
  const status = !executionEligible ? 'watch'
    : risk >= 4 ? 'risk'
      : triggered ? 'triggered'
        : nearEntry ? 'armed'
          : 'wait_entry'

  return {
    status,
    side,
    timeframe: tf,
    currentPrice: price,
    triggerPrice,
    entryPrice,
    executionEntryPrice: triggerPrice,
    executionSlippagePct,
    executionNotional,
    confirmPrice,
    distanceToTriggerPct: distanceToEntryPct,
    distanceToEntryPct,
    distanceToConfirmPct,
    stopLoss,
    stopLossPct: pctChange(triggerPrice, stopLoss),
    tp1,
    tp2,
    tp3,
    targetBasis: 'structure_target',
    setup,
    setupLabel,
    entryMode,
    score: {
      total,
      chart,
      data,
      risk: riskScore,
      rr: rrScore,
      rewardRisk: Number(rewardRisk.toFixed(2)),
      weights: { chart: 4, data: 2, rewardRisk: 2, riskControl: 2 },
    },
    reasons: reasons.slice(0, 5),
    riskFlags: riskFlags.slice(0, 4),
    resistance: resistance.level,
    resistanceTouches: resistance.touches,
    support: supportArea.level ?? support,
    supportTouches: supportArea.touches,
    triggerBufferPct: isShort ? supportArea.bufferPct : resistance.bufferPct,
    recentRangePct,
    compression,
    volumeRatio,
    runup10,
    runup20,
    extensionPct,
    ema21,
    ema55,
    ema21DistancePct,
    ema21SlopePct,
    atr,
    atrPct,
    atrExpansion,
    efficiencyRatio,
    marketRegime,
    parameterProfile: parameterProfile?.key ?? 'default',
    entryTouched,
    executionEligible,
    executionTier: executionEligible ? 'strict' : 'observe',
    rewardRisk: Number(rewardRisk.toFixed(2)),
    rejectReasons: [],
  }
}

function runSignalHunterReplay(asset, timeframe, candles, executionNotional = 5000) {
  const outcomes = []
  if (!Array.isArray(candles) || candles.length < 65) {
    return { symbol: asset.symbol, timeframe, bars: candles?.length ?? 0, signals: 0, outcomes, error: '历史K线不足65根' }
  }
  const ttlBars = timeframe === '4h' ? 9 : 8
  let index = 55
  while (index < candles.length - 2) {
    const history = candles.slice(0, index + 1)
    const current = history.at(-1)
    const turnover = estimateTurnover({ [timeframe]: history }) ?? 0
    const rsiValue = rsiIndicator.compute(history, { period: 14 })
    const profile = signalHunterParameterProfile(asset, turnover)
    const candidates = ['long', 'short'].map(side => evaluateSignalHunterTimeframe({
      side,
      tf: timeframe,
      price: current.close,
      change24h: null,
      quoteVolume24h: turnover,
      candles: history,
      rsiValue,
      volumeSignal: null,
      signalScore: 0,
      derivatives: null,
      liquidity: { spreadPct: 0.01, topBookNotional: 1_000_000, source: 'replay_proxy' },
      assetSource: 'replay',
      marketSession: 'regular',
      parameterProfile: profile,
      executionNotional,
    })).filter(item => item && !item.rejected && item.executionEligible).sort((a, b) => b.score.total - a.score.total)
    const plan = candidates[0]
    if (!plan) {
      index += 1
      continue
    }

    const endIndex = Math.min(candles.length - 1, index + ttlBars)
    let enteredAtIndex = null
    let finishedAtIndex = endIndex
    let result = 'expired'
    let rMultiple = 0
    for (let cursor = index + 1; cursor <= endIndex; cursor++) {
      const candle = candles[cursor]
      if (enteredAtIndex == null) {
        if (!replayEntryConfirmed(plan, candle)) continue
        enteredAtIndex = cursor
      }
      const stopped = plan.side === 'short' ? candle.high >= plan.stopLoss : candle.low <= plan.stopLoss
      const target = plan.tp2
      const targeted = Number.isFinite(target) && (plan.side === 'short' ? candle.low <= target : candle.high >= target)
      if (stopped && targeted) {
        result = 'ambiguous'
        finishedAtIndex = cursor
        break
      }
      if (stopped) {
        result = 'loss'
        rMultiple = -1
        finishedAtIndex = cursor
        break
      }
      if (targeted) {
        result = 'win'
        rMultiple = plan.rewardRisk ?? plan.score?.rewardRisk ?? 1.5
        finishedAtIndex = cursor
        break
      }
      if (cursor === endIndex && enteredAtIndex != null) result = 'open'
    }
    outcomes.push({
      symbol: asset.symbol,
      timeframe,
      side: plan.side,
      setup: plan.setup,
      marketRegime: plan.marketRegime,
      parameterProfile: plan.parameterProfile,
      score: plan.score?.total ?? null,
      rewardRisk: plan.rewardRisk ?? null,
      supportTouches: plan.supportTouches ?? null,
      resistanceTouches: plan.resistanceTouches ?? null,
      ema21SlopePct: plan.ema21SlopePct ?? null,
      volumeRatio: plan.volumeRatio ?? null,
      compression: Boolean(plan.compression),
      atrExpansion: plan.atrExpansion ?? null,
      efficiencyRatio: plan.efficiencyRatio ?? null,
      detectedAt: candleTimestamp(candles[index]),
      enteredAt: enteredAtIndex == null ? null : candleTimestamp(candles[enteredAtIndex]),
      finishedAt: candleTimestamp(candles[finishedAtIndex]),
      result,
      rMultiple: Number(rMultiple.toFixed(2)),
    })
    index = Math.max(index + 1, finishedAtIndex)
  }
  return { symbol: asset.symbol, timeframe, bars: candles.length, signals: outcomes.length, outcomes }
}

function replayEntryConfirmed(plan, candle) {
  if (!candle || !Number.isFinite(plan?.entryPrice)) return false
  if (plan.entryMode === 'breakout') return candle.close >= plan.entryPrice * 1.001
  if (plan.entryMode === 'breakdown') return candle.close <= plan.entryPrice * 0.999
  const range = Math.max(candle.high - candle.low, plan.entryPrice * 0.0001)
  const closePosition = (candle.close - candle.low) / range
  return plan.side === 'short'
    ? candle.high >= plan.entryPrice * 0.999 && candle.close <= plan.entryPrice * 1.002 && closePosition <= 0.58
    : candle.low <= plan.entryPrice * 1.001 && candle.close >= plan.entryPrice * 0.998 && closePosition >= 0.42
}

function candleTimestamp(candle) {
  return toNumber(candle?.closeTime ?? candle?.time)
}

function findSignalHunterResistance(candles, price, tf) {
  if (!Array.isArray(candles) || candles.length < 20 || !price) return null
  const highs = candles.map(c => c.high).filter(Number.isFinite)
  if (!highs.length) return null

  const sortedHighs = [...highs].sort((a, b) => a - b)
  const pct = percentile(sortedHighs, 0.92)
  const maxHigh = sortedHighs.at(-1)
  const spikeTooFar = maxHigh > pct * 1.018
  const ceiling = spikeTooFar ? pct : maxHigh
  const bandPct = tf === '15m' ? 0.004 : tf === '1h' ? 0.006 : 0.009
  const cluster = candles.filter(c =>
    Number.isFinite(c.high) &&
    c.high >= ceiling * (1 - bandPct) &&
    c.high <= ceiling * (1 + bandPct)
  )
  const closeCluster = candles.filter(c =>
    Number.isFinite(c.close) &&
    c.close >= ceiling * (1 - bandPct * 1.4) &&
    c.close <= ceiling * (1 + bandPct)
  )
  const touches = cluster.length
  const hasCloseAcceptance = closeCluster.length >= 2
  const levelSource = hasCloseAcceptance
    ? avg(closeCluster.map(c => Math.max(c.close, c.high * (1 - bandPct * 0.5))))
    : avg(cluster.map(c => c.high))
  const level = levelSource ?? ceiling
  if (!Number.isFinite(level) || level <= 0) return null

  const bufferPct = tf === '15m' ? 0.001 : tf === '1h' ? 0.0015 : 0.002
  const triggerPrice = level * (1 + bufferPct)
  const distancePct = pctChange(price, triggerPrice)
  const maxDistance = tf === '15m' ? 1.8 : tf === '1h' ? 2.8 : 4.0

  if (touches < 2 && !hasCloseAcceptance) return null
  if (distancePct > maxDistance || distancePct < -4) return null

  return {
    level,
    triggerPrice,
    touches,
    bufferPct: bufferPct * 100,
    spikeFiltered: spikeTooFar,
  }
}

function findSignalHunterSupport(candles) {
  if (!Array.isArray(candles) || candles.length < 10) return null
  const lows = candles.map(c => c.low).filter(Number.isFinite)
  if (!lows.length) return null
  const sortedLows = [...lows].sort((a, b) => a - b)
  const p10 = percentile(sortedLows, 0.1)
  const recentLow = Math.min(...candles.slice(-12).map(c => c.low).filter(Number.isFinite))
  if (!Number.isFinite(recentLow)) return p10
  return Math.max(p10, recentLow)
}

function findSignalHunterSupportZone(candles, price, tf) {
  if (!Array.isArray(candles) || candles.length < 20 || !price) return null
  const lows = candles.map(c => c.low).filter(Number.isFinite)
  if (!lows.length) return null

  const sortedLows = [...lows].sort((a, b) => a - b)
  const pct = percentile(sortedLows, 0.08)
  const minLow = sortedLows[0]
  const spikeTooFar = minLow < pct * 0.982
  const floor = spikeTooFar ? pct : minLow
  const bandPct = tf === '15m' ? 0.004 : tf === '1h' ? 0.006 : 0.009
  const cluster = candles.filter(c =>
    Number.isFinite(c.low) &&
    c.low >= floor * (1 - bandPct) &&
    c.low <= floor * (1 + bandPct)
  )
  const closeCluster = candles.filter(c =>
    Number.isFinite(c.close) &&
    c.close >= floor * (1 - bandPct) &&
    c.close <= floor * (1 + bandPct * 1.4)
  )
  const touches = cluster.length
  const hasCloseAcceptance = closeCluster.length >= 2
  const levelSource = hasCloseAcceptance
    ? avg(closeCluster.map(c => Math.min(c.close, c.low * (1 + bandPct * 0.5))))
    : avg(cluster.map(c => c.low))
  const level = levelSource ?? floor
  if (!Number.isFinite(level) || level <= 0) return null

  const bufferPct = tf === '15m' ? 0.001 : tf === '1h' ? 0.0015 : 0.002
  const triggerPrice = level * (1 - bufferPct)
  const distancePct = pctChange(triggerPrice, price)
  const maxDistance = tf === '15m' ? 1.8 : tf === '1h' ? 2.8 : 4.0

  if (touches < 2 && !hasCloseAcceptance) return null
  if (distancePct > maxDistance || distancePct < -4) return null

  return {
    level,
    triggerPrice,
    touches,
    bufferPct: bufferPct * 100,
    spikeFiltered: spikeTooFar,
  }
}

function percentile(sortedNums, p) {
  const vals = sortedNums.filter(Number.isFinite)
  if (!vals.length) return null
  const idx = Math.min(vals.length - 1, Math.max(0, Math.floor((vals.length - 1) * p)))
  return vals[idx]
}

function firstFinite(...values) {
  return values.find(Number.isFinite) ?? null
}

function finiteMax(values) {
  const vals = values.filter(Number.isFinite)
  return vals.length ? Math.max(...vals) : null
}

function finiteMin(values) {
  const vals = values.filter(Number.isFinite)
  return vals.length ? Math.min(...vals) : null
}

async function fetchOHLCVWithRetry(asset, timeframe, attempts = 3) {
  const cacheKey = `${asset.source}:${asset.apiSymbol}:${timeframe}`
  const ttlMs = cacheTtlMs(timeframe)
  const cached = config.loadMarketCacheEntry(cacheKey)
  if (cached?.candles?.length && Date.now() - (cached.savedAt ?? 0) < ttlMs) {
    return cached.candles
  }

  let lastError
  for (let i = 0; i < attempts; i++) {
    try {
      const candles = await fetchOHLCV(asset, timeframe)
      config.saveMarketCacheEntry(cacheKey, { savedAt: Date.now(), candles })
      return candles
    } catch (err) {
      lastError = err
      const message = String(err?.message ?? '')
      const retryable = /429|418|5\d\d|fetch failed|ECONNRESET|ETIMEDOUT|ENOTFOUND/i.test(message)
      if (!retryable || i === attempts - 1) break
      await sleep(350 * (i + 1) + Math.floor(Math.random() * 250))
    }
  }
  if (cached?.candles?.length) return cached.candles
  throw lastError
}

function cacheTtlMs(timeframe) {
  if (timeframe === '15m') return 2 * 60 * 1000
  if (timeframe === '1h') return 5 * 60 * 1000
  if (timeframe === '4h') return 10 * 60 * 1000
  return 30 * 60 * 1000
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function normalizeAsset(asset) {
  const source = asset.source || (asset.type === 'stock' ? 'yahoo' : 'binance')
  let apiSymbol = asset.apiSymbol || asset.symbol
  if ((source === 'binance' || source === 'binance-futures') && apiSymbol && !apiSymbol.endsWith('USDT')) {
    apiSymbol = `${apiSymbol}USDT`
  }
  return {
    ...asset,
    source,
    apiSymbol,
    type: asset.type || (source === 'yahoo' ? 'stock' : 'crypto'),
  }
}

function resolveTicker(tickers, asset) {
  return tickers[asset.apiSymbol]
    || tickers[asset.symbol]
    || tickers[`${asset.symbol}USDT`]
    || null
}

function tickerVolume(ticker) {
  return toNumber(ticker?.quoteVolume24h ?? ticker?.volume24h ?? ticker?.quoteVolume ?? ticker?.volume) ?? 0
}

function onlyClosedCandles(candles) {
  const now = Date.now()
  return (candles ?? []).filter(c => !c.closeTime || c.closeTime <= now)
}

function toNumber(value) {
  const n = typeof value === 'string' ? parseFloat(value) : value
  return Number.isFinite(n) ? n : null
}

function estimateTurnover(candlesByTf) {
  const dayCandle = candlesByTf['1d']?.at(-1)
  const dayTurnover = candleTurnover(dayCandle)
  if (dayTurnover != null) return dayTurnover

  const hourly = candlesByTf['1h']?.slice(-24).map(candleTurnover).filter(v => v != null)
  if (hourly?.length) return hourly.reduce((sum, v) => sum + v, 0)

  const fourHour = candlesByTf['4h']?.slice(-6).map(candleTurnover).filter(v => v != null)
  if (fourHour?.length) return fourHour.reduce((sum, v) => sum + v, 0)

  const fifteen = candlesByTf['15m']?.slice(-96).map(candleTurnover).filter(v => v != null)
  if (fifteen?.length) return fifteen.reduce((sum, v) => sum + v, 0)

  return null
}

function candleTurnover(candle) {
  if (!candle) return null
  const quoteVolume = toNumber(candle.quoteVolume)
  if (quoteVolume != null) return quoteVolume
  const volume = toNumber(candle.volume)
  const close = toNumber(candle.close)
  return volume != null && close != null ? volume * close : null
}

function avg(nums) {
  const vals = nums.filter(v => Number.isFinite(v))
  return vals.length ? vals.reduce((s, v) => s + v, 0) / vals.length : null
}

function ema(nums, period) {
  const vals = nums.filter(v => Number.isFinite(v))
  if (vals.length < period) return null
  const k = 2 / (period + 1)
  let value = avg(vals.slice(0, period))
  for (const next of vals.slice(period)) {
    value = next * k + value * (1 - k)
  }
  return value
}

function pctChange(from, to) {
  if (!from) return 0
  return ((to - from) / from) * 100
}

function candleVolume(candle) {
  return candle?.quoteVolume || candle?.volume || 0
}

function closePosition(candle) {
  const range = candle.high - candle.low
  if (!Number.isFinite(range) || range <= 0) return 0.5
  return (candle.close - candle.low) / range
}

function consecutiveHigherCloses(candles, count = 3) {
  if (!candles || candles.length < count) return false
  const recent = candles.slice(-count)
  for (let i = 1; i < recent.length; i++) {
    if (recent[i].close <= recent[i - 1].close) return false
  }
  return true
}

function consecutiveLowerCloses(candles, count = 3) {
  if (!candles || candles.length < count) return false
  const recent = candles.slice(-count)
  for (let i = 1; i < recent.length; i++) {
    if (recent[i].close >= recent[i - 1].close) return false
  }
  return true
}

function detectTrend(candles) {
  if (!candles || candles.length < 30) return null
  const last = candles.at(-1)
  const ma20 = avg(candles.slice(-20).map(c => c.close))
  const ma50 = candles.length >= 50 ? avg(candles.slice(-50).map(c => c.close)) : avg(candles.slice(-30).map(c => c.close))
  if (!last || ma20 == null || ma50 == null) return null
  if (last.close > ma20 && ma20 > ma50) return 'up'
  if (last.close < ma20 && ma20 < ma50) return 'down'
  return 'range'
}

function detectVolumePriceSignal(candles) {
  if (!candles || candles.length < 35) return null

  const cur = candles.at(-1)
  const prev = candles.at(-2)
  const lookback = candles.slice(-31, -1)
  const longer = candles.slice(-51, -1)
  const vol = candleVolume(cur)
  const avgVol = avg(lookback.slice(-20).map(candleVolume))
  if (!cur || !prev || !avgVol) return null

  const volumeRatio = parseFloat((vol / avgVol).toFixed(2))
  const priceMovePct = parseFloat(pctChange(prev.close, cur.close).toFixed(2))
  const closePos = parseFloat(closePosition(cur).toFixed(2))
  const prevHigh = Math.max(...lookback.map(c => c.high))
  const prevLow = Math.min(...lookback.map(c => c.low))
  const breaksUp = cur.close > prevHigh * 1.002
  const breaksDown = cur.close < prevLow * 0.998
  const volExpansion = volumeRatio >= 1.5
  const strongVolExpansion = volumeRatio >= 1.8
  const volDry = volumeRatio <= 0.7
  const risingCloses = consecutiveHigherCloses(candles.slice(-4), 3)
  const fallingCloses = consecutiveLowerCloses(candles.slice(-4), 3)

  const highCloseCandle = longer.reduce((best, c) => c.close > best.close ? c : best, longer[0])
  const lowCloseCandle = longer.reduce((best, c) => c.close < best.close ? c : best, longer[0])
  const highVol = candleVolume(highCloseCandle)
  const lowVol = candleVolume(lowCloseCandle)

  if (cur.close > highCloseCandle.close * 1.003 && highVol && vol < highVol * 0.75 && volumeRatio < 1.2) {
    return {
      type: 'bearish_volume_divergence',
      label: '新高量能背离',
      direction: 'caution',
      score: -2,
      volumeRatio,
      priceMovePct,
      closePos,
      level: highCloseCandle.close,
    }
  }

  if (cur.close < lowCloseCandle.close * 0.997 && lowVol && vol < lowVol * 0.75 && volumeRatio < 1.2) {
    return {
      type: 'bullish_seller_exhaustion',
      label: '新低抛压减弱',
      direction: 'caution',
      score: 2,
      volumeRatio,
      priceMovePct,
      closePos,
      level: lowCloseCandle.close,
    }
  }

  if (breaksUp) {
    const confirmed = volExpansion && priceMovePct > 0 && closePos >= 0.65
    return {
      type: confirmed ? 'breakout_confirmed' : 'breakout_attempt',
      label: confirmed ? '放量突破' : '突破尝试',
      direction: confirmed ? 'bullish' : 'caution',
      score: confirmed ? 4 : 1,
      volumeRatio,
      priceMovePct,
      closePos,
      level: prevHigh,
    }
  }

  if (breaksDown) {
    const confirmed = volExpansion && priceMovePct < 0 && closePos <= 0.35
    return {
      type: confirmed ? 'breakdown_confirmed' : 'breakdown_attempt',
      label: confirmed ? '放量破位' : '破位尝试',
      direction: confirmed ? 'bearish' : 'caution',
      score: confirmed ? -4 : -1,
      volumeRatio,
      priceMovePct,
      closePos,
      level: prevLow,
    }
  }

  const recentVol = avg(lookback.slice(-5).map(candleVolume))
  const rangePct = pctChange(prev.close, Math.max(...lookback.slice(-8).map(c => c.high)))
    - pctChange(prev.close, Math.min(...lookback.slice(-8).map(c => c.low)))
  if (recentVol && recentVol < avgVol * 0.72 && Math.abs(rangePct) < 4) {
    return {
      type: 'range_compression',
      label: '缩量压缩',
      direction: 'neutral',
      score: 0,
      volumeRatio: parseFloat((recentVol / avgVol).toFixed(2)),
      priceMovePct,
      closePos,
    }
  }

  if (strongVolExpansion && priceMovePct >= 2 && closePos >= 0.65 && risingCloses) {
    return {
      type: 'volume_rebound_up',
      label: '放量反弹',
      direction: 'caution',
      score: 1,
      volumeRatio,
      priceMovePct,
      closePos,
    }
  }

  if (strongVolExpansion && priceMovePct <= -2 && closePos <= 0.35 && fallingCloses) {
    return {
      type: 'volume_selloff',
      label: '放量回落',
      direction: 'caution',
      score: -1,
      volumeRatio,
      priceMovePct,
      closePos,
    }
  }

  if (volDry) {
    return {
      type: 'quiet_volume',
      label: '量能偏低',
      direction: 'neutral',
      score: 0,
      volumeRatio,
      priceMovePct,
      closePos,
    }
  }

  return null
}

function computeSignalScore({ rsi, divergence, volumeSignal, higherTfTrend }) {
  let score = volumeSignal?.score ?? 0
  if (higherTfTrend === 'up') score += 1
  if (higherTfTrend === 'down') score -= 1
  if (rsi >= 70) score -= 1
  if (rsi <= 30) score += 1
  if (divergence === 'bullish') score += 1
  if (divergence === 'bearish') score -= 1
  return Math.max(-6, Math.min(6, score))
}

function findLocalPivots(arr, lob = 3) {
  const peaks = [], troughs = []
  for (let i = lob; i < arr.length - lob; i++) {
    let hi = true, lo = true
    for (let j = 1; j <= lob; j++) {
      if (arr[i] <= arr[i - j] || arr[i] <= arr[i + j]) hi = false
      if (arr[i] >= arr[i - j] || arr[i] >= arr[i + j]) lo = false
    }
    if (hi) peaks.push(i)
    if (lo) troughs.push(i)
  }
  return { peaks, troughs }
}

function detectDivergence(closes, rsiSeries) {
  const n = Math.min(closes.length, rsiSeries.length)
  if (n < 15) return null

  const c = closes.slice(-n)
  const r = rsiSeries.slice(-n)
  const last = n - 1
  const curPrice = c[last], curRsi = r[last]
  if (curPrice == null || curRsi == null) return null

  const { peaks, troughs } = findLocalPivots(c)

  const valid = i => c[i] != null && r[i] != null

  // Bearish: price makes a higher high while RSI makes a lower high.
  if (peaks.length >= 2) {
    const [p1, p2] = peaks.slice(-2)
    if (valid(p1) && valid(p2) && c[p2] > c[p1] * 0.997 && r[p2] < r[p1] - 3) return 'bearish'
  }
  if (peaks.length >= 1) {
    const pk = peaks[peaks.length - 1]
    if (valid(pk) && curPrice > c[pk] * 0.997 && curRsi < r[pk] - 3) return 'bearish'
  }

  // Bullish: price makes a lower low while RSI makes a higher low.
  if (troughs.length >= 2) {
    const [t1, t2] = troughs.slice(-2)
    if (valid(t1) && valid(t2) && c[t2] < c[t1] * 1.003 && r[t2] > r[t1] + 3) return 'bullish'
  }
  if (troughs.length >= 1) {
    const tr = troughs[troughs.length - 1]
    if (valid(tr) && curPrice < c[tr] * 1.003 && curRsi > r[tr] + 3) return 'bullish'
  }
  return null
}

exports.__test = {
  signalHunterParameterProfile,
  replayEntryConfirmed,
  runSignalHunterReplay,
  createStoredZip,
  sanitizeDiagnostics,
}
