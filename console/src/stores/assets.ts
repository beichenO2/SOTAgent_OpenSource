import { defineStore } from 'pinia'
import { ref, computed } from 'vue'

export interface ITechAsset {
  id: string
  type: string
  canonical_path: string
  version: number
  content_hash: string | null
  updated_at: string
  updated_by: string | null
}

export interface ISyncLogEntry {
  id: number
  asset_id: string
  from_project: string
  to_project: string
  action: string
  diff_summary: string | null
  timestamp: string
}

export interface ISubscription {
  project_id: string
  asset_id: string
  sync_level: string
  project_path: string
}

export const useAssetsStore = defineStore('assets', () => {
  const assets = ref<ITechAsset[]>([])
  const syncLog = ref<ISyncLogEntry[]>([])
  const subscriptions = ref<ISubscription[]>([])
  const isLoading = ref(false)
  const error = ref<string | null>(null)
  const selectedType = ref<string | null>(null)
  const selectedAssetId = ref<string | null>(null)
  const serverStats = ref<{ totalAssets: number; totalSyncs: number; totalSubscriptions: number; uniqueProjects: number }>({
    totalAssets: 0, totalSyncs: 0, totalSubscriptions: 0, uniqueProjects: 0,
  })

  const assetTypes = computed(() => {
    const types = new Set(assets.value.map(a => a.type))
    return Array.from(types).sort()
  })

  const filteredAssets = computed(() => {
    if (!selectedType.value) return assets.value
    return assets.value.filter(a => a.type === selectedType.value)
  })

  const filteredSyncLog = computed(() => {
    if (!selectedAssetId.value) return syncLog.value
    return syncLog.value.filter(l => l.asset_id === selectedAssetId.value)
  })

  const assetSubscribers = computed(() => {
    const map = new Map<string, ISubscription[]>()
    for (const sub of subscriptions.value) {
      const list = map.get(sub.asset_id) || []
      list.push(sub)
      map.set(sub.asset_id, list)
    }
    return map
  })

  const stats = computed(() => ({
    total: serverStats.value.totalAssets || assets.value.length,
    byType: assetTypes.value.map(t => ({
      type: t,
      count: assets.value.filter(a => a.type === t).length,
    })),
    totalSyncs: serverStats.value.totalSyncs || syncLog.value.length,
    totalSubscriptions: serverStats.value.totalSubscriptions || subscriptions.value.length,
    uniqueProjects: serverStats.value.uniqueProjects || new Set(subscriptions.value.map(s => s.project_id)).size,
  }))

  async function fetchAll() {
    isLoading.value = true
    error.value = null
    try {
      const [assetsRes, logRes, subsRes, statsRes] = await Promise.all([
        fetch(import.meta.env.BASE_URL + 'api/assets'),
        fetch(import.meta.env.BASE_URL + 'api/sync-log?limit=100'),
        fetch(import.meta.env.BASE_URL + 'api/subscriptions'),
        fetch(import.meta.env.BASE_URL + 'api/assets/stats'),
      ])
      if (!assetsRes.ok || !logRes.ok || !subsRes.ok) throw new Error('API error')
      assets.value = await assetsRes.json()
      syncLog.value = await logRes.json()
      subscriptions.value = await subsRes.json()
      if (statsRes.ok) {
        serverStats.value = await statsRes.json()
      }
    } catch (e) {
      error.value = e instanceof Error ? e.message : String(e)
    } finally {
      isLoading.value = false
    }
  }

  return {
    assets,
    syncLog,
    subscriptions,
    isLoading,
    error,
    selectedType,
    selectedAssetId,
    assetTypes,
    filteredAssets,
    filteredSyncLog,
    assetSubscribers,
    stats,
    serverStats,
    fetchAll,
  }
})
