import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import type { IRepoStatus, IPortEntry, IScanResult } from '@/types'

export const useSyncStore = defineStore('sync', () => {
  const repos = ref<IRepoStatus[]>([])
  const ports = ref<IPortEntry[]>([])
  const lastScanned = ref('')
  const isLoading = ref(false)
  const error = ref<string | null>(null)

  const syncedCount = computed(() => repos.value.filter(r => r.syncStatus === 'synced').length)
  const behindCount = computed(() => repos.value.filter(r => r.syncStatus === 'behind' || r.syncStatus === 'diverged').length)
  const noRemoteCount = computed(() => repos.value.filter(r => r.syncStatus === 'no_remote').length)
  const dirtyCount = computed(() => repos.value.filter(r => r.dirty > 0).length)

  async function fetchStatus() {
    isLoading.value = true
    error.value = null
    try {
      const res = await fetch(import.meta.env.BASE_URL + 'api/scan')
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data: IScanResult = await res.json()
      repos.value = data.repos
      ports.value = data.ports
      lastScanned.value = data.scannedAt
    } catch (e) {
      error.value = e instanceof Error ? e.message : String(e)
    } finally {
      isLoading.value = false
    }
  }

  async function pullRepo(name: string) {
    const res = await fetch(`${import.meta.env.BASE_URL}api/pull/${name}`, { method: 'POST' })
    if (!res.ok) throw new Error(`Pull failed: HTTP ${res.status}`)
    await fetchStatus()
  }

  async function pullAll() {
    const res = await fetch(import.meta.env.BASE_URL + 'api/pull-all', { method: 'POST' })
    if (!res.ok) throw new Error(`Pull all failed: HTTP ${res.status}`)
    await fetchStatus()
  }

  return {
    repos,
    ports,
    lastScanned,
    isLoading,
    error,
    syncedCount,
    behindCount,
    noRemoteCount,
    dirtyCount,
    fetchStatus,
    pullRepo,
    pullAll,
  }
})
