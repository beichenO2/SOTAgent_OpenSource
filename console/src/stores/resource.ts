import { defineStore } from 'pinia'
import { ref, computed } from 'vue'


export interface IResourceSnapshot {
  id: number
  device_id: string
  cpu_percent: number
  mem_used_mb: number
  mem_total_mb: number
  mem_percent: number
  gpu_mem_used_mb: number | null
  timestamp: string
}

export interface IResourceProfile {
  task_type: string
  avg_cpu_percent: number
  peak_cpu_percent: number
  avg_mem_mb: number
  peak_mem_mb: number
  gpu_mem_mb: number
  avg_duration_sec: number
  sample_count: number
  confidence: string
  updated_at: string
}

export interface IIdleStatus {
  idle: boolean
  avgCpu?: number
  avgMem?: number
  maxCpu?: number
  spanSec?: number
  snapshots: number
  reason: string
}

export interface IHeavyTask {
  id: string
  requester: string
  task_type: string
  command: string
  priority: number
  status: string
  progress_percent: number
  estimated_duration_sec: number | null
  actual_start: string | null
  actual_end: string | null
  checkpoint_path: string | null
  pid: number | null
  created_at: string
  notified_eta: string | null
}

export interface ITrendMetric {
  direction: 'rising' | 'falling' | 'stable'
  current: number
  predicted: number
  confidence: 'low' | 'medium' | 'high'
  slope: number
}

export interface ITrendAnalysis {
  cpu: ITrendMetric
  mem: ITrendMetric
  data_points: number
  window_span_sec: number
}

export interface IReservationSummary {
  count: number
  totalCpu: number
  totalMem: number
  totalGpu: number
}

export const useResourceStore = defineStore('resource', () => {
  const snapshots = ref<IResourceSnapshot[]>([])
  const profiles = ref<IResourceProfile[]>([])
  const idleStatus = ref<IIdleStatus | null>(null)
  const tasks = ref<IHeavyTask[]>([])
  const trend = ref<ITrendAnalysis | null>(null)
  const reservations = ref<IReservationSummary | null>(null)
  const loading = ref(false)

  const latestSnapshot = computed(() => snapshots.value[0] ?? null)
  const queuedTasks = computed(() => tasks.value.filter(t => t.status === 'queued'))
  const runningTasks = computed(() => tasks.value.filter(t => t.status === 'running'))
  const doneTasks = computed(() => tasks.value.filter(t => t.status === 'done' || t.status === 'failed'))

  async function fetchResources() {
    loading.value = true
    try {
      const [resRes, idleRes, tasksRes, trendRes, reservRes] = await Promise.all([
        fetch(`${import.meta.env.BASE_URL}api/resources`),
        fetch(`${import.meta.env.BASE_URL}api/profiler/idle`),
        fetch(`${import.meta.env.BASE_URL}api/tasks`),
        fetch(`${import.meta.env.BASE_URL}api/profiler/trend`),
        fetch(`${import.meta.env.BASE_URL}api/scheduler/reservations`),
      ])
      const resData = await resRes.json()
      snapshots.value = resData.snapshots ?? []
      profiles.value = resData.profiles ?? []
      idleStatus.value = await idleRes.json()
      tasks.value = await tasksRes.json()
      trend.value = await trendRes.json()
      reservations.value = await reservRes.json()
    } catch (e) {
      console.error('资源数据获取失败:', e)
    } finally {
      loading.value = false
    }
  }

  async function submitTask(taskType: string, command: string, priority = 0) {
    const res = await fetch(`${import.meta.env.BASE_URL}api/tasks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ task_type: taskType, command, priority }),
    })
    const data = await res.json()
    if (data.ok) await fetchResources()
    return data
  }

  async function cancelTask(taskId: string) {
    const res = await fetch(`${import.meta.env.BASE_URL}api/tasks/${taskId}`, { method: 'DELETE' })
    const data = await res.json()
    if (data.ok) await fetchResources()
    return data
  }

  return {
    snapshots, profiles, idleStatus, tasks, trend, reservations, loading,
    latestSnapshot, queuedTasks, runningTasks, doneTasks,
    fetchResources, submitTask, cancelTask,
  }
})
