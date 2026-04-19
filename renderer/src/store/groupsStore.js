import { create } from 'zustand'

const useGroupsStore = create((set, get) => ({
  groups:      {},    // { [name]: string[] }  — apiSymbol lists
  groupFilter: null,  // null | groupName

  setGroupFilter: (name) => set({ groupFilter: name }),

  load: async () => {
    const cfg = await window.api.getAssetsConfig()
    set({ groups: cfg.groups ?? {} })
  },

  _save: async (groups) => {
    set({ groups })
    const cfg = await window.api.getAssetsConfig()
    await window.api.saveAssetsConfig({ ...cfg, groups })
  },

  createGroup: (name) => {
    if (!name || get().groups[name]) return
    const groups = { ...get().groups, [name]: [] }
    get()._save(groups)
  },

  deleteGroup: (name) => {
    const groups = { ...get().groups }
    delete groups[name]
    const filter = get().groupFilter === name ? null : get().groupFilter
    set({ groupFilter: filter })
    get()._save(groups)
  },

  setMembers: (name, apiSymbols) => {
    const groups = { ...get().groups, [name]: apiSymbols }
    get()._save(groups)
  },
}))

export default useGroupsStore
