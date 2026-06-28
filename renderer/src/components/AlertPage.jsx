import { useEffect, useMemo, useState } from 'react'
import useAlertStore from '../store/alertStore'
import useMarketStore from '../store/marketStore'

const TIMEFRAMES = ['15m', '1h', '4h', '1d']
const LEVELS = [
  { value: 1, label: '观察' },
  { value: 2, label: '重要' },
  { value: 3, label: '强提醒' },
]

const AI_EVENT_TYPES = new Set(['signal_hunter_ai', 'ai', 'market_report', 'watch_pool'])

function emptyDraft() {
  return {
    symbol: '',
    timeframes: new Set(['1h', '4h']),
    alertLevel: 2,
    rsiAbove: '',
    rsiBelow: '',
    changeAbove: '',
    changeBelow: '',
    priceAbove: '',
    priceBelow: '',
    divBull: false,
    divBear: false,
    volumeSignal: false,
    minScore: 4,
    requireAllTf: false,
  }
}

function numberOrNull(value) {
  if (value === '' || value == null) return null
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

function ruleSummary(rule) {
  const parts = [
    (rule.timeframes ?? []).join('/'),
    rule.rsiAbove != null ? `RSI>${rule.rsiAbove}` : '',
    rule.rsiBelow != null ? `RSI<${rule.rsiBelow}` : '',
    rule.changeAbove != null ? `涨超${rule.changeAbove}%` : '',
    rule.changeBelow != null ? `跌超${rule.changeBelow}%` : '',
    rule.priceAbove != null ? `突破${rule.priceAbove}` : '',
    rule.priceBelow != null ? `跌破${rule.priceBelow}` : '',
    rule.divBull ? '底背离' : '',
    rule.divBear ? '顶背离' : '',
    rule.volumeSignal ? `量价评分≥${rule.minScore ?? 3}` : '',
    rule.requireAllTf ? '多周期共振' : '',
  ].filter(Boolean)
  return parts.length ? parts.join(' · ') : '尚未设置触发条件'
}

function levelLabel(rule) {
  const level = rule.alertLevel ?? (rule.special ? 3 : 1)
  return LEVELS.find(item => item.value === level)?.label ?? '观察'
}

function draftFromRule(rule) {
  return {
    symbol: rule.symbol ?? '',
    timeframes: new Set(rule.timeframes?.length ? rule.timeframes : ['1h', '4h']),
    alertLevel: rule.alertLevel ?? (rule.special ? 3 : 1),
    rsiAbove: rule.rsiAbove ?? '',
    rsiBelow: rule.rsiBelow ?? '',
    changeAbove: rule.changeAbove ?? '',
    changeBelow: rule.changeBelow ?? '',
    priceAbove: rule.priceAbove ?? '',
    priceBelow: rule.priceBelow ?? '',
    divBull: !!rule.divBull,
    divBear: !!rule.divBear,
    volumeSignal: !!rule.volumeSignal,
    minScore: rule.minScore ?? 4,
    requireAllTf: !!rule.requireAllTf,
  }
}

function draftFields(draft) {
  return {
    timeframes: [...draft.timeframes],
    alertLevel: draft.alertLevel,
    special: draft.alertLevel >= 2,
    requireAllTf: draft.requireAllTf,
    rsiAbove: numberOrNull(draft.rsiAbove),
    rsiBelow: numberOrNull(draft.rsiBelow),
    changeAbove: numberOrNull(draft.changeAbove),
    changeBelow: numberOrNull(draft.changeBelow),
    priceAbove: numberOrNull(draft.priceAbove),
    priceBelow: numberOrNull(draft.priceBelow),
    divBull: draft.divBull,
    divBear: draft.divBear,
    volumeSignal: draft.volumeSignal,
    strategies: draft.volumeSignal ? ['breakout', 'breakdown', 'volume_divergence'] : null,
    minScore: draft.volumeSignal ? Number(draft.minScore) || 3 : null,
  }
}

function hasCondition(draft) {
  return [
    draft.rsiAbove,
    draft.rsiBelow,
    draft.changeAbove,
    draft.changeBelow,
    draft.priceAbove,
    draft.priceBelow,
  ].some(value => value !== '') || draft.divBull || draft.divBear || draft.volumeSignal
}

export default function AlertPage() {
  const configs = useAlertStore(s => s.configs)
  const feed = useAlertStore(s => s.feed)
  const upsert = useAlertStore(s => s.upsert)
  const updateById = useAlertStore(s => s.updateById)
  const remove = useAlertStore(s => s.remove)
  const toggle = useAlertStore(s => s.toggle)
  const clearAll = useAlertStore(s => s.clearAll)
  const assets = useMarketStore(s => s.assets)

  const [draft, setDraft] = useState(() => emptyDraft())
  const [editingId, setEditingId] = useState(null)
  const [query, setQuery] = useState('')
  const [message, setMessage] = useState('')
  const [confirmClear, setConfirmClear] = useState(false)
  const [managedSymbols, setManagedSymbols] = useState([])

  useEffect(() => {
    window.api.getAssetsConfig().then(cfg => {
      const merged = [...(cfg.crypto ?? []), ...(cfg.stocks ?? [])]
        .map(asset => asset.symbol || asset.apiSymbol)
        .filter(Boolean)
      setManagedSymbols(merged)
    })
  }, [])

  const symbols = useMemo(() => {
    const seen = new Set()
    return [
      ...managedSymbols,
      ...assets.map(asset => asset.symbol),
    ]
      .filter(Boolean)
      .filter(symbol => {
        const key = String(symbol).toUpperCase()
        if (seen.has(key)) return false
        seen.add(key)
        return true
      })
      .slice(0, 240)
  }, [assets, managedSymbols])

  const aiEvents = useMemo(() => feed.filter(item => AI_EVENT_TYPES.has(item.type)), [feed])
  const filteredRules = useMemo(() => {
    const q = query.trim().toUpperCase()
    return q ? configs.filter(rule => String(rule.symbol).toUpperCase().includes(q)) : configs
  }, [configs, query])

  const updateDraft = (key, value) => {
    setDraft(prev => ({ ...prev, [key]: value }))
  }

  const toggleTimeframe = (tf) => {
    setDraft(prev => {
      const next = new Set(prev.timeframes)
      if (next.has(tf) && next.size > 1) next.delete(tf)
      else next.add(tf)
      return { ...prev, timeframes: next }
    })
  }

  const resetDraft = () => {
    setDraft(emptyDraft())
    setEditingId(null)
  }

  const saveRule = () => {
    const symbol = draft.symbol.trim().toUpperCase()
    if (!symbol) {
      setMessage('请先选择或输入一个标的。')
      return
    }
    if (!hasCondition(draft)) {
      setMessage('至少设置一个触发条件。')
      return
    }
    const fields = draftFields(draft)
    if (editingId) {
      updateById(editingId, { symbol, ...fields })
      setMessage(`已更新 ${symbol} 的提醒规则。`)
    } else {
      upsert([symbol], fields)
      setMessage(`已保存 ${symbol} 的提醒规则。`)
    }
    resetDraft()
  }

  const editRule = (rule) => {
    setDraft(draftFromRule(rule))
    setEditingId(rule.id)
    setMessage('')
  }

  return (
    <div className="alert-page alert-settings-page">
      <div className="alert-settings-head">
        <div>
          <h2>提醒设置</h2>
          <p>这里保留为“手动规则 / 高级提醒”页；AI 提醒请在“提醒”事件中心处理。</p>
        </div>
        <div className="alert-settings-summary">
          <div><b>{configs.length}</b><span>规则</span></div>
          <div><b>{configs.filter(rule => rule.enabled).length}</b><span>启用</span></div>
          <div><b>{aiEvents.length}</b><span>AI事件</span></div>
        </div>
      </div>

      <div className="alert-settings-grid">
        <section className="alert-settings-panel">
          <div className="alert-settings-panel-head">
            <strong>{editingId ? '编辑提醒规则' : '新建提醒规则'}</strong>
            {editingId && <button className="zone-btn" onClick={resetDraft}>取消编辑</button>}
          </div>

          <div className="alert-form-stack">
            <label className="alert-field">
              <span>标的</span>
              <input
                className="search-input"
                list="alert-symbols"
                value={draft.symbol}
                placeholder="例如 BTCUSDT / AAPL"
                onChange={e => updateDraft('symbol', e.target.value)}
              />
              <datalist id="alert-symbols">
                {symbols.map(symbol => <option key={symbol} value={symbol} />)}
              </datalist>
            </label>
            {symbols.length > 0 && (
              <div className="alert-managed-symbols">
                <span>管理品种快捷选择</span>
                <div>
                  {symbols.slice(0, 18).map(symbol => (
                    <button key={symbol} className="feed-type-btn" onClick={() => updateDraft('symbol', symbol)}>
                      {symbol}
                    </button>
                  ))}
                </div>
              </div>
            )}

            <div className="alert-field">
              <span>周期</span>
              <div className="alert-choice-row">
                {TIMEFRAMES.map(tf => (
                  <button
                    key={tf}
                    className={`feed-type-btn ${draft.timeframes.has(tf) ? 'active' : ''}`}
                    onClick={() => toggleTimeframe(tf)}
                  >
                    {tf}
                  </button>
                ))}
              </div>
            </div>

            <div className="alert-field">
              <span>等级</span>
              <div className="alert-choice-row">
                {LEVELS.map(level => (
                  <button
                    key={level.value}
                    className={`feed-type-btn ${draft.alertLevel === level.value ? 'active' : ''}`}
                    onClick={() => updateDraft('alertLevel', level.value)}
                  >
                    {level.label}
                  </button>
                ))}
              </div>
            </div>

            <label className="alert-inline-toggle">
              <input
                type="checkbox"
                checked={draft.requireAllTf}
                onChange={e => updateDraft('requireAllTf', e.target.checked)}
              />
              <span>要求所选周期同时满足</span>
            </label>

            <div className="alert-condition-grid">
              <label><span>RSI 超过</span><input type="number" value={draft.rsiAbove} onChange={e => updateDraft('rsiAbove', e.target.value)} /></label>
              <label><span>RSI 低于</span><input type="number" value={draft.rsiBelow} onChange={e => updateDraft('rsiBelow', e.target.value)} /></label>
              <label><span>涨超 %</span><input type="number" value={draft.changeAbove} onChange={e => updateDraft('changeAbove', e.target.value)} /></label>
              <label><span>跌超 %</span><input type="number" value={draft.changeBelow} onChange={e => updateDraft('changeBelow', e.target.value)} /></label>
              <label><span>价格突破</span><input type="number" value={draft.priceAbove} onChange={e => updateDraft('priceAbove', e.target.value)} /></label>
              <label><span>价格跌破</span><input type="number" value={draft.priceBelow} onChange={e => updateDraft('priceBelow', e.target.value)} /></label>
            </div>

            <div className="alert-toggle-list">
              <label><input type="checkbox" checked={draft.divBull} onChange={e => updateDraft('divBull', e.target.checked)} /><span>底背离</span></label>
              <label><input type="checkbox" checked={draft.divBear} onChange={e => updateDraft('divBear', e.target.checked)} /><span>顶背离</span></label>
              <label><input type="checkbox" checked={draft.volumeSignal} onChange={e => updateDraft('volumeSignal', e.target.checked)} /><span>量价结构</span></label>
            </div>

            {draft.volumeSignal && (
              <label className="alert-field">
                <span>量价最低评分</span>
                <input
                  className="search-input"
                  type="number"
                  min="1"
                  max="6"
                  value={draft.minScore}
                  onChange={e => updateDraft('minScore', e.target.value)}
                />
              </label>
            )}

            <div className="alert-rule-preview">
              <b>预览</b>
              <span>{ruleSummary({ symbol: draft.symbol, ...draftFields(draft) })}</span>
            </div>

            <div className="alert-settings-actions">
              <button className="save-btn" onClick={saveRule}>{editingId ? '更新规则' : '保存规则'}</button>
              <button className="zone-btn" onClick={resetDraft}>重置</button>
              {message && <span>{message}</span>}
            </div>
          </div>
        </section>

        <section className="alert-settings-panel">
          <div className="alert-settings-panel-head">
            <strong>已有规则</strong>
            <input
              className="search-input alert-rule-search"
              type="search"
              placeholder="搜索规则..."
              value={query}
              onChange={e => setQuery(e.target.value)}
            />
          </div>

          <div className="alert-rule-list">
            {!filteredRules.length ? (
              <div className="alert-settings-empty">暂无匹配规则。</div>
            ) : filteredRules.map(rule => (
              <div key={rule.id} className={`alert-rule-card ${rule.enabled ? '' : 'disabled'}`}>
                <div className="alert-rule-main">
                  <div className="alert-rule-title">
                    <strong>{rule.symbol}</strong>
                    <span>{levelLabel(rule)}</span>
                    {!rule.enabled && <em>已停用</em>}
                  </div>
                  <p>{ruleSummary(rule)}</p>
                  <small>触发 {rule.fireCount ?? 0} 次{rule.lastFiredAt ? ` · 最近 ${new Date(rule.lastFiredAt).toLocaleString('zh-CN')}` : ''}</small>
                </div>
                <div className="alert-rule-actions">
                  <button className="zone-btn" onClick={() => toggle(rule.id)}>{rule.enabled ? '停用' : '启用'}</button>
                  <button className="zone-btn" onClick={() => editRule(rule)}>编辑</button>
                  <button className="rule-del-btn" onClick={() => remove(rule.id)}>删除</button>
                </div>
              </div>
            ))}
          </div>

          <details className="alert-settings-legacy">
            <summary>
              <span>AI事件参考</span>
              <em>{aiEvents.length} 条</em>
            </summary>
            <div className="alert-ai-event-mini-list">
              {!aiEvents.length ? (
                <div className="alert-settings-empty compact">暂无 AI 事件。</div>
              ) : aiEvents.slice(0, 20).map(item => (
                <div key={item.id} className="alert-ai-event-mini">
                  <strong>{item.symbol ?? item.signal ?? 'AI'}</strong>
                  <span>{item.type} · {item.timeframe ?? '-'}</span>
                  <em>{item.reason || item.risk || item.nextCheck || '等待复核'}</em>
                </div>
              ))}
            </div>
          </details>

          <div className="alert-settings-danger">
            {!confirmClear ? (
              <button className="rule-del-btn" disabled={!configs.length} onClick={() => setConfirmClear(true)}>清空全部规则</button>
            ) : (
              <>
                <span>确认清空全部规则？</span>
                <button className="rule-del-btn" onClick={() => { clearAll(); setConfirmClear(false) }}>确认</button>
                <button className="zone-btn" onClick={() => setConfirmClear(false)}>取消</button>
              </>
            )}
          </div>
        </section>
      </div>
    </div>
  )
}
