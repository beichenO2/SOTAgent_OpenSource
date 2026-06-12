import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import type { IFunnelStatus } from '@/types'

export const useFunnelStore = defineStore('funnel', () => {
  const status = ref<IFunnelStatus>({ domains: [], raw: {} })
  const isLoading = ref(false)
  const error = ref<string | null>(null)
  const isPending = ref(false)

  const totalRoutes = computed(() =>
    status.value.domains.reduce((sum, d) => sum + d.handlers.length, 0),
  )

  const funnelDomains = computed(() =>
    status.value.domains.filter(d => d.isFunnel),
  )

  const serveDomains = computed(() =>
    status.value.domains.filter(d => !d.isFunnel),
  )

  async function fetchStatus() {
    isLoading.value = true
    error.value = null
    try {
      const res = await fetch(import.meta.env.BASE_URL + 'api/funnel/status')
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      status.value = await res.json()
    } catch (e) {
      error.value = e instanceof Error ? e.message : String(e)
    } finally {
      isLoading.value = false
    }
  }

  async function addRoute(mountPath: string, target: string, asFunnel: boolean) {
    isPending.value = true
    error.value = null
    try {
      const res = await fetch(import.meta.env.BASE_URL + 'api/funnel/add', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mountPath, target, asFunnel }),
      })
      const data = await res.json()
      if (!data.ok) throw new Error(data.message)
      await fetchStatus()
    } catch (e) {
      error.value = e instanceof Error ? e.message : String(e)
      throw e
    } finally {
      isPending.value = false
    }
  }

  async function removeRoute(mountPath: string) {
    isPending.value = true
    error.value = null
    try {
      const res = await fetch(import.meta.env.BASE_URL + 'api/funnel/remove', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mountPath }),
      })
      const data = await res.json()
      if (!data.ok) throw new Error(data.message)
      await fetchStatus()
    } catch (e) {
      error.value = e instanceof Error ? e.message : String(e)
      throw e
    } finally {
      isPending.value = false
    }
  }

  async function resetAll() {
    isPending.value = true
    error.value = null
    try {
      const res = await fetch(import.meta.env.BASE_URL + 'api/funnel/reset', { method: 'POST' })
      const data = await res.json()
      if (!data.ok) throw new Error(data.message)
      await fetchStatus()
    } catch (e) {
      error.value = e instanceof Error ? e.message : String(e)
      throw e
    } finally {
      isPending.value = false
    }
  }

  return {
    status,
    isLoading,
    error,
    isPending,
    totalRoutes,
    funnelDomains,
    serveDomains,
    fetchStatus,
    addRoute,
    removeRoute,
    resetAll,
  }
})
