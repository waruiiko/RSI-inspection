import { create } from 'zustand'

const KEY = 'rsi:signalTrail'
const MAX_ITEMS = 200

function loadTrail() {
  try { return JSON.parse(localStorage.getItem(KEY) ?? '[]') }
  catch { return [] }
}

function saveTrail(items) {
  localStorage.setItem(KEY, JSON.stringify(items.slice(0, MAX_ITEMS)))
}

function stageOf(asset) {
  const d = asset.derivatives
  if (!d || !d.stage || d.stage === 'neutral') return null
  if (d.stage === 'crowded') return 'risk'
  if (d.stage === 'early_build' || d.stage === 'oi_build') return 'early'
  if (d.stage === 'long_build') return 'entry'
  if (d.stage === 'short_cover' || d.stage === 'deleveraging') return 'pullback'
  if (d.stage === 'short_build') return 'risk'
  return null
}

const useSignalTrailStore = create((set, get) => ({
  items: loadTrail(),
  updateFromAssets: (assets) => {
    const now = Date.now()
    const existing = new Map(get().items.map(item => [item.key, item]))
    for (const asset of assets) {
      const stage = stageOf(asset)
      const key = `${asset.source}:${asset.apiSymbol ?? asset.symbol}`
      const prev = existing.get(key)
      if (!stage) {
        if (prev && prev.status !== 'retired') {
          existing.set(key, { ...prev, status: 'retired', retiredAt: now, updatedAt: now })
        }
        continue
      }
      existing.set(key, {
        key,
        symbol: asset.symbol,
        source: asset.source,
        stage,
        status: prev ? 'active' : 'new',
        firstSeenAt: prev?.firstSeenAt ?? now,
        firstPrice: prev?.firstPrice ?? asset.price,
        updatedAt: now,
        price: asset.price,
        launchChangePct: prev?.firstPrice && asset.price
          ? ((asset.price - prev.firstPrice) / prev.firstPrice) * 100
          : 0,
        change24h: asset.change24h,
        derivatives: asset.derivatives,
        rsi: asset.rsi,
        localReasons: [
          asset.derivatives?.label,
          asset.volumeSignal?.['4h']?.label,
          asset.volumeSignal?.['1h']?.label,
        ].filter(Boolean),
      })
    }
    const next = Array.from(existing.values())
      .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
      .slice(0, MAX_ITEMS)
    saveTrail(next)
    set({ items: next })
  },
  clear: () => {
    saveTrail([])
    set({ items: [] })
  },
}))

export default useSignalTrailStore
