import { useState, useEffect } from 'react'
import useSettingsStore from '../store/settingsStore'
import { playAlertSound } from '../utils/sound'
import { sendWebhooks } from '../utils/webhook'

const REFRESH_OPTIONS    = [1, 2, 5, 10, 30]
const COOLDOWN_OPTIONS   = [1, 2, 4, 8]
const RSI_PERIOD_OPTIONS = [7, 14, 21]
const RSI_MA_TYPES       = ['None', 'SMA', 'EMA', 'RMA', 'WMA', 'BB']
const RSI_MA_LENGTHS     = [5, 9, 14, 21]
const RSI_BB_MULTS       = [1.5, 2.0, 2.5, 3.0]
const LEVEL_OPTIONS      = [1, 2, 3]

/* ── Section title ─────────────────────────────────────────── */
function SectionTitle({ children }) {
  return <div className="settings-section-title">{children}</div>
}

/* ── Settings row ──────────────────────────────────────────── */
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

/* ── Segmented button group ────────────────────────────────── */
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

export default function SettingsPage() {
  const {
    refreshInterval, alertCooldown, popupEnabled, soundEnabled,
    startMinimized, rsiPeriod, rsiOverbought, rsiOversold,
    rsiMaType, rsiMaLength, rsiBbMult,
    popupMinLevel, soundMinLevel, webhookMinLevel, levelCooldowns, autoCheckUpdates,
    silentStart, silentEnd,
    telegramToken, telegramChatId, discordWebhook,
    update,
  } = useSettingsStore()

  const [autoLaunch,     setAutoLaunch]     = useState(false)
  const [autoLaunchBusy, setAutoLaunchBusy] = useState(true)
  const [settingsMsg,    setSettingsMsg]    = useState('')
  const [diagnostics,    setDiagnostics]    = useState(null)
  const [cacheStats,     setCacheStats]     = useState(null)

  useEffect(() => {
    window.api.getAutoLaunch().then(v => { setAutoLaunch(v); setAutoLaunchBusy(false) })
    refreshDiagnostics()
  }, [])

  const refreshDiagnostics = async () => {
    const [diag, cache] = await Promise.all([
      window.api.getDiagnostics(),
      window.api.getCacheStats(),
    ])
    setDiagnostics(diag)
    setCacheStats(cache)
  }

  const updateLevelCooldown = (level, hours) => {
    update('levelCooldowns', { ...(levelCooldowns ?? {}), [level]: hours })
  }

  const handleAutoLaunch = async (e) => {
    const v = e.target.checked
    setAutoLaunch(v)
    await window.api.setAutoLaunch(v)
  }

  /* ── Toggle helper ── */
  const Toggle = ({ checked, onChange, disabled }) => (
    <label className="toggle-switch">
      <input type="checkbox" checked={checked} onChange={onChange} disabled={disabled} />
      <span className="toggle-track" />
    </label>
  )

  return (
    <div className="settings-page">
      {/* Header */}
      <div className="manage-header">
        <span className="manage-title">设置</span>
        <span style={{ fontSize: 'var(--text-sm)', color: 'var(--dim)', alignSelf: 'center' }}>
          v1.0.5
        </span>
      </div>

      <div className="settings-body">

        {/* ── 系统 ── */}
        <div className="settings-section">
          <SectionTitle>系统</SectionTitle>
          <Row label="发布前体检" hint="检查配置、提醒、缓存和通知配置是否正常">
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
                  <span>{c.ok ? '✓' : '!'}</span>
                  <b>{c.label}</b>
                  <em>{c.detail}</em>
                </div>
              ))}
            </div>
          )}
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
              <Toggle checked={autoCheckUpdates} onChange={e => update('autoCheckUpdates', e.target.checked)} />
              <button
                className="zone-btn"
                style={{ fontSize: 11, padding: '3px 10px' }}
                onClick={async () => {
                  try {
                    const r = await window.api.checkForUpdates(true)
                    setSettingsMsg(`已打开最新版本页面：${r.tag ?? r.name ?? ''}`)
                  } catch (err) {
                    setSettingsMsg(`检查更新失败：${err.message}`)
                  }
                }}
              >
                检查更新
              </button>
            </div>
          </Row>
        </div>

        {/* ── 数据 ── */}
        <div className="settings-section">
          <SectionTitle>数据</SectionTitle>

          <Row label="RSI 超买阈值" hint="默认 70，高于此值视为超买">
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <input
                type="range" min="60" max="90" step="1"
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
                type="range" min="10" max="40" step="1"
                value={rsiOversold}
                onChange={e => update('rsiOversold', Number(e.target.value))}
                style={{ width: 100, accentColor: '#22c55e' }}
              />
              <span style={{ color: '#22c55e', fontWeight: 700, minWidth: 24, fontVariantNumeric: 'tabular-nums' }}>
                {rsiOversold}
              </span>
            </div>
          </Row>

          <Row label="RSI 周期" hint="影响所有品种的 RSI 计算，修改后下次刷新生效">
            <BtnGroup options={RSI_PERIOD_OPTIONS} value={rsiPeriod} onChange={v => update('rsiPeriod', v)} />
          </Row>

          <Row label="RSI-MA 类型" hint="在图表 RSI 面板中叠加平滑均线">
            <BtnGroup options={RSI_MA_TYPES} value={rsiMaType} onChange={v => update('rsiMaType', v)} />
          </Row>

          {rsiMaType !== 'None' && (
            <Row label="RSI-MA 周期" hint="均线计算使用的周期数">
              <BtnGroup options={RSI_MA_LENGTHS} value={rsiMaLength} onChange={v => update('rsiMaLength', v)} />
            </Row>
          )}

          {rsiMaType === 'BB' && (
            <Row label="BB 倍数" hint="布林带标准差倍数，默认 2.0">
              <BtnGroup options={RSI_BB_MULTS} value={rsiBbMult} onChange={v => update('rsiBbMult', v)} />
            </Row>
          )}

          <Row label="刷新间隔" hint="每隔多长时间重新拉取行情">
            <BtnGroup
              options={REFRESH_OPTIONS}
              value={refreshInterval}
              onChange={v => update('refreshInterval', v)}
              format={v => `${v} 分钟`}
            />
          </Row>

          <Row label="K线缓存" hint="缓存可减少重复请求；接口失败时也可回退到上次数据">
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ color: 'var(--dim)', fontSize: 11 }}>
                {cacheStats ? `${cacheStats.entries} 条 · ${formatBytes(cacheStats.sizeBytes)}` : '读取中'}
              </span>
              <button
                className="zone-btn"
                style={{ fontSize: 11, padding: '3px 10px' }}
                onClick={async () => {
                  const r = await window.api.clearCache()
                  setCacheStats(r)
                  setSettingsMsg('K线缓存已清理')
                }}
              >
                清理缓存
              </button>
            </div>
          </Row>
        </div>

        {/* ── 提醒 ── */}
        <div className="settings-section">
          <SectionTitle>提醒</SectionTitle>

          <Row label="声音提醒" hint="触发提醒时播放提示音">
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <Toggle
                checked={soundEnabled}
                onChange={e => update('soundEnabled', e.target.checked)}
              />
              <button
                className="zone-btn"
                style={{ fontSize: 11, padding: '3px 10px' }}
                onClick={playAlertSound}
              >
                试听
              </button>
            </div>
          </Row>

          <Row label="弹窗通知" hint="触发提醒时是否显示桌面弹窗">
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <Toggle
                checked={popupEnabled}
                onChange={e => update('popupEnabled', e.target.checked)}
              />
              <button
                className="zone-btn"
                style={{ fontSize: 11, padding: '3px 10px' }}
                onClick={() => window.api.showNotificationBatch([
                    { symbol: 'TEST', type: 'rsi', timeframe: '1h', condition: 'above', threshold: 70, value: 73.5, level: 1 }
                ])}
              >
                测试弹窗
              </button>
            </div>
          </Row>

          <Row label="静音时段" hint="该时段内不弹窗、不发声，但仍写入提醒记录">
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <input
                type="time" value={silentStart}
                onChange={e => update('silentStart', e.target.value)}
                className="time-input"
              />
              <span style={{ color: 'var(--muted)' }}>—</span>
              <input
                type="time" value={silentEnd}
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

          <Row label="分级冷却" hint="不同等级可使用不同冷却时间；未设置时使用全局冷却">
            <div className="settings-btn-group">
              {[1, 2, 3].map(level => (
                <label key={level} className="level-cooldown">
                  <span>{level}级</span>
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
          <Row label="导入配置" hint="导入后建议重新刷新市场数据；现有 Webhook 密钥会保留">
            <button
              className="zone-btn"
              style={{ fontSize: 11, padding: '3px 10px' }}
              onClick={async () => {
                const r = await window.api.importConfig()
                if (r?.ok) {
                  setSettingsMsg('导入完成，请重启或刷新数据')
                  window.location.reload()
                }
              }}
            >
              导入
            </button>
          </Row>
          <Row label="清理安装包" hint="删除 dist 目录中的旧安装包，仅保留最新版本">
            <button
              className="zone-btn"
              style={{ fontSize: 11, padding: '3px 10px' }}
              onClick={async () => {
                const r = await window.api.cleanupInstallers()
                setSettingsMsg(`已清理 ${r.removed?.length ?? 0} 个旧文件，保留：${r.kept ?? '无'}`)
              }}
            >
              清理旧安装包
            </button>
          </Row>
          {settingsMsg && <div className="settings-note">{settingsMsg}</div>}
        </div>

        {/* ── Webhook ── */}
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

          <Row
            label="Telegram Chat ID"
            hint="必须是数字 ID（非用户名）。获取方式：先给机器人发一条消息，再访问 api.telegram.org/bot<TOKEN>/getUpdates，找 message.chat.id"
          >
            <input
              className="search-input"
              style={{ maxWidth: 200 }}
              placeholder="如 123456789 或 -1001234567890"
              value={telegramChatId}
              onChange={e => update('telegramChatId', e.target.value)}
            />
          </Row>

          <Row label="Discord Webhook URL" hint="频道设置 → 整合 → Webhook">
            <input
              className="search-input"
              style={{ maxWidth: 280 }}
              type="password"
              placeholder="https://discord.com/api/webhooks/..."
              value={discordWebhook}
              onChange={e => update('discordWebhook', e.target.value)}
            />
          </Row>

          <Row label="发送测试消息" hint="验证 Telegram / Discord 配置是否正确">
            <button
              className="zone-btn"
              style={{ fontSize: 11, padding: '3px 10px' }}
              disabled={!telegramToken && !discordWebhook}
              onClick={() => sendWebhooks(
                [{ symbol: 'TEST', type: 'rsi', timeframe: '1h', condition: 'above', threshold: 70, value: 73.5 }],
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
