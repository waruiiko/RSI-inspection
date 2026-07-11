import { useEffect, useMemo, useState } from 'react'
import useSettingsStore from '../store/settingsStore'
import useMarketStore from '../store/marketStore'
import useAiRunLogStore from '../store/aiRunLogStore'
import { playAlertSound } from '../utils/sound'
import { sendWebhooks } from '../utils/webhook'

const REFRESH_OPTIONS = [1, 2, 5, 10, 30]
const COOLDOWN_OPTIONS = [1, 2, 4, 8]
const RSI_PERIOD_OPTIONS = [7, 14, 21]
const RSI_MA_TYPES = ['None', 'SMA', 'EMA', 'RMA', 'WMA', 'BB']
const RSI_MA_LENGTHS = [5, 9, 14, 21]
const RSI_BB_MULTS = [1.5, 2.0, 2.5, 3.0]
const LEVEL_OPTIONS = [1, 2, 3]
const RSI_SENS_OPTIONS = ['strict', 'standard', 'loose']
const THEME_OPTIONS = [
  { key: 'system', label: '系统' },
  { key: 'light', label: '浅色' },
  { key: 'dark', label: '深色' },
]
const RSI_SENS_LABELS = {
  strict: '严格',
  standard: '标准',
  loose: '宽松',
}

function SectionTitle({ children }) {
  return <div className="settings-section-title">{children}</div>
}

function Row({ label, hint, children }) {
  return (
    <div className="settings-row">
      <div className="settings-row-label">
        <span>{label}</span>
        {hint && <span className="settings-hint">{hint}</span>}
      </div>
      <div className="settings-row-control">{children}</div>
    </div>
  )
}

function BtnGroup({ options, value, onChange, format }) {
  return (
    <div className="settings-btn-group">
      {options.map(v => (
        <button
          key={v}
          className={value === v ? 'active' : ''}
          onClick={() => onChange(v)}
        >
          {format ? format(v) : v}
        </button>
      ))}
    </div>
  )
}

function Toggle({ checked, onChange, disabled }) {
  return (
    <label className="toggle-switch">
      <input type="checkbox" checked={checked} onChange={onChange} disabled={disabled} />
      <span className="toggle-track" />
    </label>
  )
}

function ThemePreview({ mode, active, onClick }) {
  return (
    <button className={`theme-preview-card ${mode.key} ${active ? 'active' : ''}`} onClick={onClick}>
      <div className="theme-preview-art">
        <span />
        <span />
        <span />
      </div>
      <strong>{mode.label}</strong>
    </button>
  )
}

export default function SettingsPage() {
  const {
    refreshInterval, alertCooldown, popupEnabled, soundEnabled,
    startMinimized, rsiPeriod, rsiOverbought, rsiOversold,
    rsiMaType, rsiMaLength, rsiBbMult,
    popupMinLevel, soundMinLevel, webhookMinLevel, webhookAiOnly, levelCooldowns, autoCheckUpdates,
    observationEnabled, rsiSensitivity, startupStateAlerts,
    silentStart, silentEnd,
    telegramToken, telegramChatId, discordWebhook, codexCliPath,
    autoAiEnabled, autoAiInterval, autoAiLimit, autoAiStartupDelay, shAiInterval, shAiEnabled, shAiShadowEnabled, watchPoolRetentionDays,
    shAiProfile, shAiBatchSize, shAiConcurrency, shAiCacheMinutes, shAiRetries,
    shAiHourlyBatches, shAiHourlyCandidates, shAiHourlyMinutes,
    shExecutionNotional, shParameterMode, shNightlyReplayEnabled,
    themeMode,
    update,
  } = useSettingsStore()
  const statusEvents = useMarketStore(s => s.statusEvents)
  const assets = useMarketStore(s => s.assets)
  const updatedAt = useMarketStore(s => s.updatedAt)
  const fetchData = useMarketStore(s => s.fetchData)
  const aiRunLog = useAiRunLogStore(s => s.items)
  const clearAiRunLog = useAiRunLogStore(s => s.clear)

  const [autoLaunch, setAutoLaunch] = useState(false)
  const [autoLaunchBusy, setAutoLaunchBusy] = useState(true)
  const [settingsMsg, setSettingsMsg] = useState('')
  const [diagnostics, setDiagnostics] = useState(null)
  const [cacheStats, setCacheStats] = useState(null)
  const [codexStatus, setCodexStatus] = useState(null)
  const [codexJobs, setCodexJobs] = useState([])
  const [codexRuntime, setCodexRuntime] = useState(null)
  const [shAiMetrics, setShAiMetrics] = useState(() => {
    try { return JSON.parse(localStorage.getItem('rsi:signalHunter:aiMetrics') || '[]') } catch { return [] }
  })
  const [shAiFeedback] = useState(() => {
    try { return JSON.parse(localStorage.getItem('rsi:signalHunter:feedback') || '[]') } catch { return [] }
  })
  const shAiQuality = useMemo(() => {
    if (!shAiMetrics.length) return null
    const successful = shAiMetrics.filter(item => !(item.failures?.length) && !item.missing && !item.duplicates).length
    return {
      runs: shAiMetrics.length,
      successRate: Math.round(successful / shAiMetrics.length * 100),
      averageSeconds: Math.round(shAiMetrics.reduce((sum, item) => sum + (item.durationMs ?? 0), 0) / shAiMetrics.length / 1000),
      retries: shAiMetrics.reduce((sum, item) => sum + (item.retries ?? 0), 0),
      degraded: shAiMetrics.filter(item => item.degraded).length,
    }
  }, [shAiMetrics])
  const shPromptScore = useMemo(() => {
    if (!shAiQuality) return null
    const helpful = shAiFeedback.filter(item => item.rating === '有帮助').length
    const feedbackRate = shAiFeedback.length ? helpful / shAiFeedback.length : 0.5
    const speedScore = Math.max(0, Math.min(1, 1 - (shAiQuality.averageSeconds - 30) / 210))
    return Math.round(shAiQuality.successRate * 0.5 + feedbackRate * 30 + speedScore * 20)
  }, [shAiFeedback, shAiQuality])

  const healthMetrics = useMemo(() => {
    const blocked = assets.filter(asset => asset.dataQuality?.ok === false)
    const stale = assets.filter(asset => {
      const candles = Object.values(asset.reviewCandlesByTf ?? {}).flat().filter(Boolean)
      const latest = candles.map(candle => Number(candle.closeTime ?? candle.time ?? 0)).filter(Number.isFinite).sort((a, b) => b - a)[0]
      return latest && Date.now() - latest > 12 * 60 * 60 * 1000
    })
    const sources = new Map()
    for (const event of statusEvents) sources.set(event.scope, (sources.get(event.scope) ?? 0) + 1)
    return { blocked: blocked.length, stale: stale.length, sourceFailures: [...sources.entries()], total: assets.length }
  }, [assets, statusEvents])

  useEffect(() => {
    window.api.getAutoLaunch().then(v => {
      setAutoLaunch(v)
      setAutoLaunchBusy(false)
    })
    refreshDiagnostics()
  }, [])

  const refreshDiagnostics = async () => {
    const [diag, cache, jobs, runtime] = await Promise.all([
      window.api.getDiagnostics(),
      window.api.getCacheStats(),
      window.api.getCodexJobs?.() ?? [],
      window.api.getCodexScreenRuntime?.() ?? null,
    ])
    setDiagnostics(diag)
    setCacheStats(cache)
    setCodexJobs(Array.isArray(jobs) ? jobs : [])
    setCodexRuntime(runtime)
  }

  const updateLevelCooldown = (level, hours) => {
    update('levelCooldowns', { ...(levelCooldowns ?? {}), [level]: hours })
  }

  const handleAutoLaunch = async (e) => {
    const next = e.target.checked
    setAutoLaunch(next)
    await window.api.setAutoLaunch(next)
  }

  const handleCheckUpdate = async () => {
    try {
      const r = await window.api.checkForUpdates(true)
      setSettingsMsg(`已打开最新版本页面：${r.tag ?? r.name ?? ''}`)
    } catch (err) {
      setSettingsMsg(`检查更新失败：${err.message}`)
    }
  }

  const handleClearCache = async () => {
    const result = await window.api.clearCache()
    setCacheStats(result)
    setSettingsMsg('K线缓存已清理')
  }

  const handleImportConfig = async () => {
    const r = await window.api.importConfig()
    if (r?.ok) {
      setSettingsMsg('导入完成，请重新启动或刷新数据')
      window.location.reload()
    }
  }

  const handleCleanupInstallers = async () => {
    const r = await window.api.cleanupInstallers()
    setSettingsMsg(`已清理 ${r.removed?.length ?? 0} 个旧文件，保留：${r.kept ?? '无'}`)
  }

  const checkCodex = async () => {
    const status = await window.api.getCodexStatus()
    setCodexStatus(status)
    setSettingsMsg(
      status.ok
        ? `Codex 可用：${status.version || '已检测到 CLI'}`
        : `Codex 不可用：${status.error}`
    )
  }

  return (
    <div className="settings-page">
      <div className="manage-header">
        <span className="manage-title">设置</span>
        <span style={{ fontSize: 'var(--text-sm)', color: 'var(--dim)', alignSelf: 'center' }}>
          v1.2.2
        </span>
      </div>

      <div className="settings-body">
        <div className="settings-section settings-appearance-section">
          <SectionTitle>外观</SectionTitle>

          <div className="theme-preview-grid">
            {THEME_OPTIONS.map(mode => (
              <ThemePreview
                key={mode.key}
                mode={mode}
                active={(themeMode || 'light') === mode.key}
                onClick={() => update('themeMode', mode.key)}
              />
            ))}
          </div>

          <div className="theme-code-preview">
            <div><span>1</span><code>const themePreview: ThemeConfig = {'{'}</code></div>
            <div className="removed"><span>2</span><code>surface: "sidebar",</code></div>
            <div className="removed"><span>3</span><code>accent: "#2563eb",</code></div>
            <div className="added"><span>2</span><code>surface: "sidebar-elevated",</code></div>
            <div className="added"><span>3</span><code>accent: "#339cff",</code></div>
            <div><span>4</span><code>{'}'};</code></div>
          </div>

          <div className="theme-config-table">
            <div><span>当前主题</span><b>{THEME_OPTIONS.find(mode => mode.key === (themeMode || 'light'))?.label ?? '浅色'}</b></div>
            <div><span>强调色</span><b className="theme-color-pill blue">#339CFF</b></div>
            <div><span>背景</span><b className="theme-color-pill white">#FFFFFF</b></div>
            <div><span>前景</span><b className="theme-color-pill dark">#1A1C1F</b></div>
            <div><span>UI 字体</span><b>-apple-system, BlinkMacSystemFont</b></div>
          </div>
        </div>

        <div className="settings-section">
          <SectionTitle>系统</SectionTitle>

          <Row label="发布前体检" hint="检查配置、提醒、缓存和通知设置是否正常">
            <button
              className="zone-btn"
              style={{ fontSize: 11, padding: '3px 10px' }}
              onClick={refreshDiagnostics}
            >
              重新检查
            </button>
          </Row>

          {diagnostics && (
            <div className="diagnostics-grid">
              {diagnostics.checks.map(c => (
                <div key={c.key} className={`diagnostic-chip ${c.ok ? 'ok' : 'warn'}`}>
                  <span>{c.ok ? 'OK' : '!'}</span>
                  <b>{c.label}</b>
                  <em>{c.detail}</em>
                </div>
              ))}
            </div>
          )}

          <div className="health-panel">
            <div className="health-panel-head">
              <b>数据源健康</b>
              <span>{statusEvents.length ? `最近 ${statusEvents.length} 条状态` : '暂无异常状态'}</span>
            </div>
            <div className="health-list">
              {statusEvents.length === 0
                ? <span className="settings-hint">Binance / Yahoo / OI / Funding 最近没有上报异常。</span>
                : statusEvents.slice(0, 5).map((e, i) => (
                  <div key={`${e.ts}-${i}`} className={`health-row ${e.level === 'warn' ? 'warn' : ''}`}>
                    <b>{e.scope}</b>
                    <span>{e.message}</span>
                    <em>{new Date(e.ts).toLocaleTimeString('zh-CN')}</em>
                  </div>
                ))
              }
            </div>
          </div>

          <div className="health-panel data-health-console">
            <div className="health-panel-head"><b>数据健康控制台</b><div><button className="zone-btn" onClick={() => fetchData({ scope: 'health-retry' })}>重试全量数据</button> <button className="zone-btn" disabled={!codexJobs.some(job => job.status === 'running' || job.status === 'queued')} onClick={async () => { await window.api.cancelCodexJobs(); refreshDiagnostics() }}>取消AI任务</button></div></div>
            <div className="diagnostics-grid">
              <div className={`diagnostic-chip ${updatedAt ? 'ok' : 'warn'}`}><span>{updatedAt ? 'OK' : '!'}</span><b>最后刷新</b><em>{updatedAt ? `${Math.max(0, Math.round((Date.now() - updatedAt) / 60000))} 分钟前` : '尚未完成'}</em></div>
              <div className={`diagnostic-chip ${healthMetrics.blocked ? 'warn' : 'ok'}`}><span>{healthMetrics.blocked ? '!' : 'OK'}</span><b>数据阻断</b><em>{healthMetrics.blocked}/{healthMetrics.total} 个标的</em></div>
              <div className={`diagnostic-chip ${healthMetrics.stale ? 'warn' : 'ok'}`}><span>{healthMetrics.stale ? '!' : 'OK'}</span><b>K线陈旧</b><em>{healthMetrics.stale} 个标的超过12小时</em></div>
              <div className={`diagnostic-chip ${codexJobs.some(job => job.status === 'failed') ? 'warn' : 'ok'}`}><span>AI</span><b>任务队列</b><em>{codexJobs.filter(job => job.status === 'running' || job.status === 'queued').length} 运行/排队 · {codexJobs.filter(job => job.status === 'failed').length} 失败</em></div>
            </div>
            {healthMetrics.sourceFailures.slice(0, 6).map(([scope, count]) => <div className="health-row warn" key={scope}><b>{scope}</b><span>当前会话失败 {count} 次</span><em>可重试</em></div>)}
            {codexJobs.slice(0, 5).map(job => <div className={`health-row ${job.status === 'failed' ? 'warn' : ''}`} key={job.id}><b>{job.type}</b><span>{job.status} · {job.scope || '全局'}</span><em>{job.durationMs ? `${(job.durationMs / 1000).toFixed(1)}s` : '-'}</em></div>)}
            {codexRuntime && <div className="ai-runtime-panel">
              <b>SH AI运行时</b>
              <span>叙述缓存 {codexRuntime.narrativeCache} · 活跃进程 {codexRuntime.activeProcesses} · 识别目录 {codexRuntime.queuedTasks}</span>
              <span>熔断失败 {codexRuntime.circuit?.failures ?? 0} · 剩余 {Math.ceil((codexRuntime.circuit?.remainingMs ?? 0) / 60000)}分钟</span>
              <span>预算剩余：批次 {codexRuntime.budget?.batches ?? 0} · 候选 {codexRuntime.budget?.candidates ?? 0} · {Math.round((codexRuntime.budget?.durationMs ?? 0) / 60000)}分钟</span>
              <div>
                <button className="zone-btn" onClick={async () => { await window.api.resetCodexScreenRuntime('cache'); refreshDiagnostics() }}>清叙述缓存</button>
                <button className="zone-btn" onClick={async () => { await window.api.resetCodexScreenRuntime('circuit'); refreshDiagnostics() }}>重置熔断</button>
                <button className="zone-btn" onClick={async () => { await window.api.resetCodexScreenRuntime('budget'); refreshDiagnostics() }}>重置预算</button>
                <button className="zone-btn" onClick={async () => {
                  const result = await window.api.cleanupCodexScreenRuns({ keep: 50, maxAgeDays: 14 })
                  setSettingsMsg(`已清理 ${result.removed ?? 0} 个旧识别目录`)
                  refreshDiagnostics()
                }}>清理旧识别目录</button>
              </div>
            </div>}
          </div>

          <Row label="开机自动启动" hint="登录后自动在后台运行">
            <Toggle checked={autoLaunch} disabled={autoLaunchBusy} onChange={handleAutoLaunch} />
          </Row>

          <Row label="启动时最小化到托盘" hint="每次打开应用直接进入托盘">
            <Toggle
              checked={startMinimized}
              onChange={e => update('startMinimized', e.target.checked)}
            />
          </Row>

          <Row label="自动检查更新" hint="启动时检查 GitHub Releases，不会自动安装">
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <Toggle
                checked={autoCheckUpdates}
                onChange={e => update('autoCheckUpdates', e.target.checked)}
              />
              <button
                className="zone-btn"
                style={{ fontSize: 11, padding: '3px 10px' }}
                onClick={handleCheckUpdate}
              >
                检查更新
              </button>
            </div>
          </Row>
        </div>

        <div className="settings-section">
          <SectionTitle>数据</SectionTitle>

          <Row label="RSI 超买阈值" hint="默认 70，高于此值视为超买">
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <input
                type="range"
                min="60"
                max="90"
                step="1"
                value={rsiOverbought}
                onChange={e => update('rsiOverbought', Number(e.target.value))}
                style={{ width: 100, accentColor: '#ef4444' }}
              />
              <span style={{ color: '#ef4444', fontWeight: 700, minWidth: 24, fontVariantNumeric: 'tabular-nums' }}>
                {rsiOverbought}
              </span>
            </div>
          </Row>

          <Row label="RSI 超卖阈值" hint="默认 30，低于此值视为超卖">
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <input
                type="range"
                min="10"
                max="40"
                step="1"
                value={rsiOversold}
                onChange={e => update('rsiOversold', Number(e.target.value))}
                style={{ width: 100, accentColor: '#22c55e' }}
              />
              <span style={{ color: '#22c55e', fontWeight: 700, minWidth: 24, fontVariantNumeric: 'tabular-nums' }}>
                {rsiOversold}
              </span>
            </div>
          </Row>

          <Row label="RSI 周期" hint="影响所有品种的 RSI 计算">
            <BtnGroup options={RSI_PERIOD_OPTIONS} value={rsiPeriod} onChange={v => update('rsiPeriod', v)} />
          </Row>

          <Row label="RSI 提醒灵敏度" hint="严格：阈值外再多 2 点；标准：触及阈值；宽松：提前 2 点">
            <BtnGroup
              options={RSI_SENS_OPTIONS}
              value={rsiSensitivity}
              onChange={v => update('rsiSensitivity', v)}
              format={v => RSI_SENS_LABELS[v]}
            />
          </Row>

          <Row label="RSI-MA 类型" hint="图表 RSI 面板叠加的平滑均线">
            <BtnGroup options={RSI_MA_TYPES} value={rsiMaType} onChange={v => update('rsiMaType', v)} />
          </Row>

          {rsiMaType !== 'None' && (
            <Row label="RSI-MA 周期" hint="均线计算使用的周期数">
              <BtnGroup options={RSI_MA_LENGTHS} value={rsiMaLength} onChange={v => update('rsiMaLength', v)} />
            </Row>
          )}

          {rsiMaType === 'BB' && (
            <Row label="BB 倍数" hint="布林带标准差倍数">
              <BtnGroup options={RSI_BB_MULTS} value={rsiBbMult} onChange={v => update('rsiBbMult', v)} />
            </Row>
          )}

          <Row label="刷新间隔" hint="多久重新拉取一次行情">
            <BtnGroup
              options={REFRESH_OPTIONS}
              value={refreshInterval}
              onChange={v => update('refreshInterval', v)}
              format={v => `${v} 分钟`}
            />
          </Row>

          <Row label="K 线缓存" hint="减少重复请求；接口失败时也可回退到上次数据">
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ color: 'var(--dim)', fontSize: 11 }}>
                {cacheStats ? `${cacheStats.entries} 条 · ${formatBytes(cacheStats.sizeBytes)}` : '读取中...'}
              </span>
              <button
                className="zone-btn"
                style={{ fontSize: 11, padding: '3px 10px' }}
                onClick={handleClearCache}
              >
                清理缓存
              </button>
            </div>
          </Row>
        </div>

        <div className="settings-section">
          <SectionTitle>提醒</SectionTitle>

          <Row label="声音提醒" hint="触发提醒时播放提示音">
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <Toggle checked={soundEnabled} onChange={e => update('soundEnabled', e.target.checked)} />
              <button className="zone-btn" style={{ fontSize: 11, padding: '3px 10px' }} onClick={playAlertSound}>
                试听
              </button>
            </div>
          </Row>

          <Row label="观察模式" hint="记录早期量价信号、RSI 区域状态和持续背离；默认只写入记录，不弹窗">
            <Toggle
              checked={observationEnabled}
              onChange={e => update('observationEnabled', e.target.checked)}
            />
          </Row>

          <Row label="启动状态提醒" hint="全量数据补完后，若规则已经满足，也记录一次">
            <Toggle
              checked={startupStateAlerts}
              onChange={e => update('startupStateAlerts', e.target.checked)}
            />
          </Row>

          <Row label="观察池保留时间" hint="剧烈波动标的会先进入观察池；未标记的记录到期自动剔除">
            <BtnGroup
              options={[7, 15, 30, 0]}
              value={watchPoolRetentionDays}
              onChange={v => update('watchPoolRetentionDays', v)}
              format={v => v === 0 ? '永久' : `${v} 天`}
            />
          </Row>

          <Row label="弹窗通知" hint="触发提醒时显示桌面弹窗">
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <Toggle checked={popupEnabled} onChange={e => update('popupEnabled', e.target.checked)} />
              <button
                className="zone-btn"
                style={{ fontSize: 11, padding: '3px 10px' }}
                onClick={() => window.api.showNotificationBatch([
                  { symbol: 'TEST', type: 'rsi', timeframe: '1h', condition: 'above', threshold: 70, value: 73.5, level: 1 },
                ])}
              >
                测试弹窗
              </button>
            </div>
          </Row>

          <Row label="静音时段" hint="该时段内不弹窗、不发声，但仍写入提醒记录">
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <input
                type="time"
                value={silentStart}
                onChange={e => update('silentStart', e.target.value)}
                className="time-input"
              />
              <span style={{ color: 'var(--muted)' }}>-</span>
              <input
                type="time"
                value={silentEnd}
                onChange={e => update('silentEnd', e.target.value)}
                className="time-input"
              />
              {(silentStart || silentEnd) && (
                <button
                  className="zone-btn"
                  style={{ fontSize: 11, padding: '3px 8px' }}
                  onClick={() => { update('silentStart', ''); update('silentEnd', '') }}
                >
                  清除
                </button>
              )}
            </div>
          </Row>

          <Row label="冷却时间" hint="同一条件再次触发的最短间隔">
            <BtnGroup
              options={COOLDOWN_OPTIONS}
              value={alertCooldown}
              onChange={v => update('alertCooldown', v)}
              format={v => `${v} 小时`}
            />
          </Row>

          <Row label="分级冷却" hint="不同等级可使用不同冷却时间；观察默认 3 小时">
            <div className="settings-btn-group">
              {[0, 1, 2, 3].map(level => (
                <label key={level} className="level-cooldown">
                  <span>{level === 0 ? '观察' : `${level}级`}</span>
                  <input
                    className="alert-num-input"
                    type="number"
                    min="0.25"
                    step="0.25"
                    value={levelCooldowns?.[level] ?? alertCooldown}
                    onChange={e => updateLevelCooldown(level, Number(e.target.value) || alertCooldown)}
                  />
                  <span>小时</span>
                </label>
              ))}
            </div>
          </Row>

          <Row label="弹窗等级" hint="只对达到该等级的提醒弹窗">
            <BtnGroup options={LEVEL_OPTIONS} value={popupMinLevel} onChange={v => update('popupMinLevel', v)} format={v => `${v}级+`} />
          </Row>

          <Row label="声音等级" hint="只对达到该等级的提醒播放声音">
            <BtnGroup options={LEVEL_OPTIONS} value={soundMinLevel} onChange={v => update('soundMinLevel', v)} format={v => `${v}级+`} />
          </Row>

          <Row label="Webhook 等级" hint="只对达到该等级的提醒发送 Telegram / Discord">
            <BtnGroup options={LEVEL_OPTIONS} value={webhookMinLevel} onChange={v => update('webhookMinLevel', v)} format={v => `${v}级+`} />
          </Row>
        </div>

        <div className="settings-section">
          <SectionTitle>备份</SectionTitle>

          <Row label="导出配置" hint="导出品种、分组、提醒规则与常规设置；不会导出 Telegram / Discord 密钥">
            <button
              className="zone-btn"
              style={{ fontSize: 11, padding: '3px 10px' }}
              onClick={async () => {
                const r = await window.api.exportConfig()
                if (r?.ok) setSettingsMsg(`已导出：${r.filePath}`)
              }}
            >
              导出
            </button>
          </Row>

          <Row label="导出诊断包" hint="生成脱敏ZIP：版本、失败批次、运行指标和缓存摘要；不包含密钥或原始行情">
            <button
              className="zone-btn"
              style={{ fontSize: 11, padding: '3px 10px' }}
              onClick={async () => {
                let cacheMeta = null
                try { cacheMeta = JSON.parse(localStorage.getItem('rsi:signalHunter:aiCache') || 'null')?.meta ?? null } catch {}
                const result = await window.api.exportDiagnostics({
                  metrics: shAiMetrics,
                  feedback: shAiFeedback,
                  cacheMeta,
                })
                if (result?.ok) setSettingsMsg(`诊断包已导出：${result.filePath}`)
              }}
            >
              导出ZIP
            </button>
          </Row>

          <Row label="导入配置" hint="导入后建议重新刷新市场数据；现有 Webhook 密钥会保留">
            <button
              className="zone-btn"
              style={{ fontSize: 11, padding: '3px 10px' }}
              onClick={handleImportConfig}
            >
              导入
            </button>
          </Row>

          <Row label="清理安装包" hint="删除 dist 目录里的旧安装包，仅保留最新版本">
            <button
              className="zone-btn"
              style={{ fontSize: 11, padding: '3px 10px' }}
              onClick={handleCleanupInstallers}
            >
              清理旧安装包
            </button>
          </Row>

          {settingsMsg && <div className="settings-note">{settingsMsg}</div>}
        </div>

        <div className="settings-section">
          <SectionTitle>Codex 复盘</SectionTitle>

          <Row label="Codex CLI 路径" hint="默认使用 PATH 里的 codex；如果检测不到，可以填完整路径">
            <input
              className="search-input"
              style={{ maxWidth: 280 }}
              placeholder="codex"
              value={codexCliPath}
              onChange={e => update('codexCliPath', e.target.value)}
            />
          </Row>

          <Row label="检测 Codex" hint="使用本机 Codex 登录状态；不需要 OpenAI API Key">
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <button
                className="zone-btn"
                style={{ fontSize: 11, padding: '3px 10px' }}
                onClick={checkCodex}
              >
                检测
              </button>
              <span style={{ color: 'var(--dim)', fontSize: 11 }}>
                复盘目录：~/.rsi-inspection/codex-reviews
              </span>
            </div>
          </Row>

          <Row label="自动 AI 筛选" hint="市场数据刷新后，仅在候选明显变化且冷却结束时运行 Codex">
            <Toggle
              checked={autoAiEnabled}
              onChange={e => update('autoAiEnabled', e.target.checked)}
            />
          </Row>

          <Row label="AI 冷却时间" hint="两次自动筛选之间的最短间隔">
            <BtnGroup
              options={[15, 30, 60, 120]}
              value={autoAiInterval}
              onChange={v => update('autoAiInterval', v)}
              format={v => `${v} 分钟`}
            />
          </Row>

          <Row label="SH AI 识别频率" hint="Signal Hunter 自动识别的最短间隔；手动识别不受限制">
            <BtnGroup
              options={[15, 30, 60, 120]}
              value={shAiInterval}
              onChange={v => update('shAiInterval', v)}
              format={v => `${v} 分钟`}
            />
          </Row>

          <Row label="SH AI 叙述" hint="关闭后只运行本地Signal Hunter规则；以后可重新开启补写摘要">
            <Toggle checked={shAiEnabled} onChange={e => update('shAiEnabled', e.target.checked)} />
          </Row>

          <Row label="影子提示词抽样" hint="每轮最多抽4个候选对比新提示词，只记录质量，不发布到SH页面">
            <Toggle checked={shAiShadowEnabled} onChange={e => update('shAiShadowEnabled', e.target.checked)} disabled={!shAiEnabled} />
          </Row>

          <Row label="SH AI 运行预设" hint="稳定模式优先成功率；快速模式允许两批并发；自定义可调整高级参数">
            <BtnGroup
              options={['stable', 'fast', 'custom']}
              value={shAiProfile}
              onChange={v => update('shAiProfile', v)}
              format={v => ({ stable: '稳定', fast: '快速', custom: '自定义' })[v]}
            />
          </Row>

          {shAiProfile === 'custom' && <>
            <Row label="AI 批次大小" hint="单次提交给Codex的候选数">
              <BtnGroup options={[12, 18, 24]} value={shAiBatchSize} onChange={v => update('shAiBatchSize', v)} />
            </Row>
            <Row label="AI 并发批次" hint="并发越高越快，但资源占用和失败概率也更高">
              <BtnGroup options={[1, 2]} value={shAiConcurrency} onChange={v => update('shAiConcurrency', v)} />
            </Row>
            <Row label="AI 缓存时间" hint="结构无明显变化时复用叙述结果">
              <BtnGroup options={[30, 60, 120]} value={shAiCacheMinutes} onChange={v => update('shAiCacheMinutes', v)} format={v => `${v}分钟`} />
            </Row>
            <Row label="AI 修复重试" hint="仅重新提交缺失或质量不合格的候选">
              <BtnGroup options={[0, 1, 2]} value={shAiRetries} onChange={v => update('shAiRetries', v)} format={v => `${v}次`} />
            </Row>
          </>}

          <Row label="SH AI 每小时预算" hint="达到任一上限后，剩余候选延后到下一轮；本地规则继续工作">
            <div className="settings-budget-grid">
              <label>批次 <select value={shAiHourlyBatches} onChange={e => update('shAiHourlyBatches', Number(e.target.value))}><option>6</option><option>12</option><option>24</option></select></label>
              <label>候选 <select value={shAiHourlyCandidates} onChange={e => update('shAiHourlyCandidates', Number(e.target.value))}><option>120</option><option>240</option><option>480</option></select></label>
              <label>分钟 <select value={shAiHourlyMinutes} onChange={e => update('shAiHourlyMinutes', Number(e.target.value))}><option>15</option><option>30</option><option>45</option></select></label>
            </div>
          </Row>

          <Row label="SH AI 质量监控" hint="最近30次识别的完整率、耗时、重试和降级情况">
            <div className="settings-note">
              {shAiQuality
                ? `提示词评分 ${shPromptScore}/100 · 完整率 ${shAiQuality.successRate}% · ${shAiQuality.runs}次 · 平均 ${shAiQuality.averageSeconds}秒 · 重试 ${shAiQuality.retries} · 降级 ${shAiQuality.degraded} · 反馈 ${shAiFeedback.length}`
                : '暂无识别质量样本'}
              {shAiMetrics.length > 0 && <button className="zone-btn" onClick={() => {
                localStorage.removeItem('rsi:signalHunter:aiMetrics')
                setShAiMetrics([])
              }}>清空统计</button>}
              {shAiMetrics.length > 0 && <details className="settings-ai-history">
                <summary>查看最近运行</summary>
                {shAiMetrics.slice(0, 10).map((item, index) => (
                  <div key={`${item.at}-${index}`}>
                    <span>{new Date(item.at).toLocaleString('zh-CN')}</span>
                    <span>{item.profile ?? 'stable'} · {item.batches ?? 0}批 · {Math.round((item.durationMs ?? 0) / 1000)}秒</span>
                    <span>缓存 {item.cached ?? 0} · 重试 {item.retries ?? 0} · 缺失 {item.missing ?? 0}</span>
                    <span>{item.failures?.length ? item.failures.map(failure => `${failure.type}:${failure.count}`).join(' / ') : '完整'}</span>
                  </div>
                ))}
              </details>}
            </div>
          </Row>

          <Row label="SH 执行规模" hint="多档盘口滑点、成交比例和真实R值使用的计划名义金额">
            <BtnGroup
              options={[1000, 5000, 10000]}
              value={shExecutionNotional}
              onChange={v => update('shExecutionNotional', v)}
              format={v => `$${Number(v).toLocaleString()}`}
            />
          </Row>

          <Row label="SH 参数模式" hint="稳定版决定信号；影子模式同时计算实验参数，但不影响实际信号">
            <BtnGroup
              options={['stable', 'shadow']}
              value={shParameterMode}
              onChange={v => update('shParameterMode', v)}
              format={v => v === 'shadow' ? '影子观察' : '稳定版'}
            />
          </Row>

          <Row label="夜间结构回放" hint="当地时间凌晨2点后首次行情刷新时，自动运行并保存一次近期逐根回放">
            <Toggle checked={shNightlyReplayEnabled} onChange={e => update('shNightlyReplayEnabled', e.target.checked)} />
          </Row>

          <Row label="AI 候选数量" hint="每次最多提交给 Codex 的候选数量">
            <BtnGroup
              options={[10, 20, 30]}
              value={autoAiLimit}
              onChange={v => update('autoAiLimit', v)}
              format={v => `Top ${v}`}
            />
          </Row>

          <Row label="AI 启动延迟" hint="避免软件刚启动时同时拉数据和运行 AI">
            <BtnGroup
              options={[5, 10, 15, 30]}
              value={autoAiStartupDelay}
              onChange={v => update('autoAiStartupDelay', v)}
              format={v => `${v} 分钟`}
            />
          </Row>

          {codexStatus && (
            <div className="settings-note">
              {codexStatus.ok
                ? `Codex 可用：${codexStatus.version || '已检测到 CLI'}`
                : `Codex 不可用：${codexStatus.error}`}
            </div>
          )}

          <div className="health-panel">
            <div className="health-panel-head">
              <b>AI 运行日志</b>
              <button
                className="zone-btn"
                style={{ fontSize: 11, padding: '2px 8px' }}
                onClick={clearAiRunLog}
                disabled={!aiRunLog.length}
              >
                清空
              </button>
            </div>
            <div className="health-list">
              {aiRunLog.length === 0
                ? <span className="settings-hint">暂无 Codex 运行记录。</span>
                : aiRunLog.slice(0, 8).map(item => (
                  <div key={item.id} className={`health-row ${item.ok ? '' : 'warn'}`}>
                    <b>{item.type}/{item.mode}</b>
                    <span>{item.ok ? `${item.inputCount ?? 0} 入 / ${item.outputCount ?? 0} 出` : item.error}</span>
                    <em>{Math.round((item.elapsedMs ?? 0) / 1000)}s · {new Date(item.ts).toLocaleTimeString('zh-CN')}</em>
                  </div>
                ))
              }
            </div>
          </div>
        </div>

        <div className="settings-section">
          <SectionTitle>Webhook 通知</SectionTitle>

          <Row label="Telegram Bot Token" hint="从 @BotFather 获取">
            <input
              className="search-input"
              style={{ maxWidth: 280 }}
              type="password"
              placeholder="1234567890:AAF..."
              value={telegramToken}
              onChange={e => update('telegramToken', e.target.value)}
            />
          </Row>

          <Row label="Telegram Chat ID" hint="必须是数字 ID（非用户名）。可通过 getUpdates 获取 message.chat.id">
            <input
              className="search-input"
              style={{ maxWidth: 220 }}
              placeholder="如 123456789 或 -1001234567890"
              value={telegramChatId}
              onChange={e => update('telegramChatId', e.target.value)}
            />
          </Row>

          <Row label="Discord Webhook URL" hint="频道设置 -> 整合 -> Webhook">
            <input
              className="search-input"
              style={{ maxWidth: 280 }}
              type="password"
              placeholder="https://discord.com/api/webhooks/..."
              value={discordWebhook}
              onChange={e => update('discordWebhook', e.target.value)}
            />
          </Row>

          <Row label="Webhook 发送范围" hint="开启后只发送经过 AI 筛选写入的重点/风险提醒，普通规则仍留在本地提醒记录">
            <Toggle
              checked={webhookAiOnly}
              onChange={e => update('webhookAiOnly', e.target.checked)}
            />
          </Row>

          <Row label="发送测试消息" hint="验证 Telegram / Discord 配置是否正确；测试消息模拟 AI 筛选后的提醒">
            <button
              className="zone-btn"
              style={{ fontSize: 11, padding: '3px 10px' }}
              disabled={!telegramToken && !discordWebhook}
              onClick={() => sendWebhooks(
                [{ symbol: 'TEST', type: 'ai', condition: 'focus', value: 88, reason: 'AI 筛选测试', risk: '仅用于验证通知链路', nextCheck: '无需操作' }],
                { telegramToken, telegramChatId, discordWebhook }
              )}
            >
              发送测试
            </button>
          </Row>
        </div>
      </div>
    </div>
  )
}

function formatBytes(bytes) {
  if (!bytes) return '0 B'
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${bytes} B`
}
