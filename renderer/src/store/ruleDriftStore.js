import { create } from 'zustand'
import { hydrateOperationalData, persistOperationalData } from '../utils/operationalData'

const RETENTION_MS = 90 * 24 * 60 * 60 * 1000
const MAX_SNAPSHOTS = 5000

function increment(target, key) {
  if (!key) return
  target[key] = (target[key] ?? 0) + 1
}

function snapshotFromAssets(assets, scanAt) {
  const counts = { scanned: 0, healthy: 0, structured: 0, accepted: 0, executable: 0, triggered: 0 }
  const blockers = {}
  const regimes = {}
  for (const asset of assets ?? []) {
    counts.scanned += 1
    const signal = asset.signalHunter
    if (asset.dataQuality?.ok === false) {
      increment(blockers, `数据：${asset.dataQuality.issues?.[0] ?? '质量阻断'}`)
      continue
    }
    counts.healthy += 1
    if (!signal) {
      increment(blockers, '结构：未形成1h/4h候选')
      continue
    }
    counts.structured += 1
    increment(regimes, signal.marketRegime ?? 'unknown')
    if (signal.rejected || signal.status === 'rejected') {
      increment(blockers, `规则：${signal.rejectReasons?.[0] ?? '本地结构剔除'}`)
      continue
    }
    counts.accepted += 1
    if (signal.executionEligible === false) {
      increment(blockers, '执行：仅观察')
      continue
    }
    counts.executable += 1
    if (signal.status === 'triggered') counts.triggered += 1
  }
  return { scanAt, counts, blockers, regimes }
}

const useRuleDriftStore = create((set, get) => ({
  snapshots: [],
  hydrated: false,

  hydrate: async () => {
    const snapshots = await hydrateOperationalData('ruleDrift', [])
    set({ snapshots: Array.isArray(snapshots) ? snapshots.slice(0, MAX_SNAPSHOTS) : [], hydrated: true })
  },

  recordFromAssets: (assets, scanAt) => {
    if (!Number.isFinite(scanAt)) return
    const previous = get().snapshots
    if (previous.some(item => item.scanAt === scanAt)) return
    const cutoff = scanAt - RETENTION_MS
    const snapshots = [snapshotFromAssets(assets, scanAt), ...previous]
      .filter(item => item.scanAt >= cutoff)
      .slice(0, MAX_SNAPSHOTS)
    set({ snapshots })
    persistOperationalData('ruleDrift', snapshots)
  },
}))

export default useRuleDriftStore
