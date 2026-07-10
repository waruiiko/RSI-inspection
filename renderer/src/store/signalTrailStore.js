import { create } from 'zustand'
import { hydrateOperationalData, persistOperationalData } from '../utils/operationalData'

const KEY = 'rsi:signalTrail'
const MAX_ITEMS = 200

function loadTrail() {
  try { return JSON.parse(localStorage.getItem(KEY) ?? '[]') }
  catch { return [] }
}

function saveTrail(items) {
  const next = items.slice(0, MAX_ITEMS)
  localStorage.setItem(KEY, JSON.stringify(next))
  persistOperationalData('signalTrail', next)
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
  hydrate: async () => {
    const items = await hydrateOperationalData('signalTrail', get().items)
    if (Array.isArray(items)) set({ items })
  },
  updateFromAssets: (assets) => {
    const now = Date.now()
    const existing = new Map(get().items.map(item => [item.key, item]))
    for (const asset of assets) {
      const stage = stageOf(asset)
      const key = `${asset.source}:${asset.apiSymbol ?? asset.symbol}`
      const prev = existing.get(key)
      if (!stage) {
        if (prev && prev.status !== 'retired') {
          existing.set(key, {
            ...prev, status: 'retired', retiredAt: now, updatedAt: now,
            events: [{ ts: now, type: 'retired', stage: prev.stage, price: asset.price, label: '资金结构退回中性/观察' }, ...(prev.events ?? [])].slice(0, 30),
          })
        }
        continue
      }
      const status = prev ? 'active' : 'new'
      const transitioned = !prev || prev.stage !== stage || prev.status !== status
      const events = transitioned ? [{
        ts: now,
        type: !prev ? 'discovered' : prev.status === 'retired' ? 'reactivated' : 'stage_change',
        from: prev?.stage ?? null,
        stage,
        price: asset.price,
        oiChange4h: asset.derivatives?.oiChange4h ?? null,
        fundingRate: asset.derivatives?.fundingRate ?? null,
        label: !prev ? '首次发现资金结构' : `${prev.stage ?? '观察'} → ${stage}`,
      }, ...(prev?.events ?? [])].slice(0, 30) : (prev.events ?? [])
      existing.set(key, {
        key,
        symbol: asset.symbol,
        source: asset.source,
        stage,
        status,
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
        events,
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
