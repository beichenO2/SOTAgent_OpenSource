import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import type { IProcessStatus, IDeviceInfo } from '@/types'

export interface IWatchdogTarget {
  name: string
  healthEndpoint: string
  restartCommand: string
  failures: number
  restartAttempts: number
  status: string
  lastCheck: string
  restartTimestamps: number[]
}

export interface ISchedulerStatus {
  idle: boolean
  running_tasks: number
  queue_depth: number
  avg_cpu: number
  avg_mem: number
}

export const useProcessStore = defineStore('process', () => {
  const services = ref<IProcessStatus[]>([])
  const devices = ref<IDeviceInfo[]>([])
  const watchdogTargets = ref<IWatchdogTarget[]>([])
  const scheduler = ref<ISchedulerStatus | null>(null)
  const ppHealthy = ref(false)
  const isLoading = ref(false)
  const error = ref<string | null>(null)
  const pendingActions = ref<Set<string>>(new Set())

  const runningCount = computed(() => services.value.filter(s => s.status === 'running').length)
  const errorCount = computed(() => services.value.filter(s => s.status === 'error').length)
  const localServices = computed(() => services.value.filter(s => s.is_local))
  const remoteServices = computed(() => services.value.filter(s => !s.is_local))
  const healthyWatchdogCount = computed(() => watchdogTargets.value.filter(t => t.status === 'healthy').length)
  const unhealthyWatchdogCount = computed(() => watchdogTargets.value.filter(t => t.status !== 'healthy').length)

  const BASE = import.meta.env.BASE_URL

  async function fetchServices() {
    isLoading.value = true
    error.value = null
    try {
      const [svcRes, wdRes, schedRes, healthRes] = await Promise.allSettled([
        fetch(BASE + 'api/services'),
        fetch(BASE + 'api/polarprocess/watchdog'),
        fetch(BASE + 'api/polarprocess/scheduler'),
        fetch(BASE + 'api/polarprocess/health'),
      ])
      if (svcRes.status === 'fulfilled' && svcRes.value.ok) {
        services.value = await svcRes.value.json()
      } else if (svcRes.status === 'fulfilled') {
        throw new Error(`HTTP ${svcRes.value.status}`)
      }
      if (wdRes.status === 'fulfilled' && wdRes.value.ok) {
        watchdogTargets.value = await wdRes.value.json()
      }
      if (schedRes.status === 'fulfilled' && schedRes.value.ok) {
        scheduler.value = await schedRes.value.json()
      }
      if (healthRes.status === 'fulfilled' && healthRes.value.ok) {
        const h = await healthRes.value.json()
        ppHealthy.value = h.ok === true
      } else {
        ppHealthy.value = false
      }
    } catch (e) {
      error.value = e instanceof Error ? e.message : String(e)
    } finally {
      isLoading.value = false
    }
  }

  async function fetchDevices() {
    try {
      const res = await fetch(BASE + 'api/devices')
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      devices.value = await res.json()
    } catch (e) {
      console.error('获取设备列表失败:', e)
    }
  }

  async function serviceAction(id: string, action: 'start' | 'stop' | 'restart') {
    pendingActions.value.add(id)
    try {
      const res = await fetch(`${BASE}api/services/${id}/${action}`, { method: 'POST' })
      if (!res.ok) {
        const data = await res.json().catch(() => ({ message: `HTTP ${res.status}` }))
        throw new Error(data.message || `操作失败`)
      }
      await fetchServices()
    } catch (e) {
      error.value = e instanceof Error ? e.message : String(e)
      throw e
    } finally {
      pendingActions.value.delete(id)
    }
  }

  async function resetAndStart(id: string) {
    pendingActions.value.add(id)
    try {
      await fetch(`${BASE}api/services/${id}/reset-restart-count`, { method: 'POST' })
      const res = await fetch(`${BASE}api/services/${id}/start`, { method: 'POST' })
      if (!res.ok) {
        const data = await res.json().catch(() => ({ message: `HTTP ${res.status}` }))
        throw new Error(data.message || '重置启动失败')
      }
      await fetchServices()
    } catch (e) {
      error.value = e instanceof Error ? e.message : String(e)
      throw e
    } finally {
      pendingActions.value.delete(id)
    }
  }

  function isPending(id: string) {
    return pendingActions.value.has(id)
  }

  function getWatchdogForService(serviceName: string): IWatchdogTarget | undefined {
    return watchdogTargets.value.find(t =>
      t.name === serviceName ||
      serviceName.toLowerCase().includes(t.name.toLowerCase()) ||
      t.name.toLowerCase().includes(serviceName.toLowerCase().replace(/\s+/g, ''))
    )
  }

  return {
    services,
    devices,
    watchdogTargets,
    scheduler,
    ppHealthy,
    isLoading,
    error,
    pendingActions,
    runningCount,
    errorCount,
    localServices,
    remoteServices,
    healthyWatchdogCount,
    unhealthyWatchdogCount,
    fetchServices,
    fetchDevices,
    serviceAction,
    resetAndStart,
    isPending,
    getWatchdogForService,
  }
})
