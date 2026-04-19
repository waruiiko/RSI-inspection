import useSettingsStore from '../store/settingsStore'

function getOb() { return useSettingsStore.getState().rsiOverbought ?? 70 }
function getOs() { return useSettingsStore.getState().rsiOversold   ?? 30 }

export function getRsiColor(rsi, ob = getOb(), os = getOs()) {
  if (rsi == null) return '#6b7280'
  const range = ob - os
  if (rsi >= ob)                  return '#ef4444'
  if (rsi >= os + range * 0.75)   return '#f97316'
  if (rsi >= os + range * 0.375)  return '#9ca3af'
  if (rsi >= os)                  return '#4ade80'
  return '#22c55e'
}

export function getRsiZone(rsi, ob = getOb(), os = getOs()) {
  if (rsi == null) return null
  const range = ob - os
  if (rsi >= ob)                  return 'overbought'
  if (rsi >= os + range * 0.75)   return 'strong'
  if (rsi >= os + range * 0.375)  return 'neutral'
  if (rsi >= os)                  return 'weak'
  return 'oversold'
}

export function getRsiLabel(rsi, ob = getOb(), os = getOs()) {
  if (rsi == null) return '—'
  const range = ob - os
  if (rsi >= ob)                  return '超买'
  if (rsi >= os + range * 0.75)   return '强势'
  if (rsi >= os + range * 0.375)  return '中性'
  if (rsi >= os)                  return '弱势'
  return '超卖'
}

export function formatPrice(price) {
  if (price == null) return '—'
  if (price >= 10000) return price.toLocaleString('en', { maximumFractionDigits: 0 })
  if (price >= 100)   return price.toFixed(2)
  if (price >= 1)     return price.toFixed(3)
  return price.toFixed(6)
}
