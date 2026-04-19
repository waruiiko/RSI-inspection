import { create } from 'zustand'

const usePairsStore = create((set, get) => ({
  spot:    [],
  futures: [],
  loading: false,
  loaded:  false,

  async load() {
    if (get().loaded || get().loading) return
    set({ loading: true })
    try {
      const { spot, futures } = await window.api.getBinancePairs()
      set({ spot, futures, loading: false, loaded: true })
    } catch {
      set({ loading: false })
    }
  },
}))

export default usePairsStore
