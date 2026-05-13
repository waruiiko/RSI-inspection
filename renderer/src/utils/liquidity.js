export const LIQUIDITY_LIMITS = [
  { value: 50, label: 'Top 50' },
  { value: 100, label: 'Top 100' },
  { value: 200, label: 'Top 200' },
  { value: 0, label: '全部' },
]

export function getQuoteVolume(asset) {
  const raw = asset?.quoteVolume24h ?? asset?.volume24h ?? asset?.turnover24h ?? 0
  const value = typeof raw === 'string' ? parseFloat(raw) : raw
  return Number.isFinite(value) ? value : 0
}

export function applyLiquidityLimit(assets, limit) {
  const sorted = [...assets]
    .sort((a, b) => getQuoteVolume(b) - getQuoteVolume(a))
  return limit ? sorted.slice(0, limit) : sorted
}

export function formatTurnover(value) {
  const n = typeof value === 'string' ? parseFloat(value) : value
  if (n == null || !Number.isFinite(n) || n <= 0) return '—'
  if (n >= 1_000_000_000) return `$${(n / 1_000_000_000).toFixed(1)}B`
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `$${(n / 1_000).toFixed(1)}K`
  return `$${n.toFixed(0)}`
}
