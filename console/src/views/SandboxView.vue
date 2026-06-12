<script setup lang="ts">
import { onMounted, onUnmounted, ref, computed } from 'vue'
import PageHeader from '@/components/PageHeader.vue'
import StatCard from '@/components/StatCard.vue'

interface IWatchdogTarget {
  name: string
  healthEndpoint: string
  restartCommand: string
  failures: number
  restartAttempts: number
  status: string
  lastCheck: string
  restartTimestamps: number[]
}

interface ITask {
  task_id: string
  task_type: string
  command: string
  status: string
  progress: number
  priority: number
  owner: string | null
  created_at: string
  started_at: string | null
  finished_at: string | null
  error: string | null
}

interface IScheduler {
  idle: boolean
  running_tasks: number
  queue_depth: number
  avg_cpu: number
  avg_mem: number
}

const watchdogTargets = ref<IWatchdogTarget[]>([])
const tasks = ref<ITask[]>([])
const scheduler = ref<IScheduler | null>(null)
const ppHealthy = ref(false)
const isLoading = ref(false)
let pollTimer: ReturnType<typeof setInterval> | null = null

const BASE = import.meta.env.BASE_URL

async function fetchAll() {
  isLoading.value = true
  try {
    const [healthRes, wdRes, taskRes, schedRes] = await Promise.allSettled([
      fetch(BASE + 'api/polarprocess/health'),
      fetch(BASE + 'api/polarprocess/watchdog'),
      fetch(BASE + 'api/polarprocess/tasks'),
      fetch(BASE + 'api/polarprocess/scheduler'),
    ])
    if (healthRes.status === 'fulfilled' && healthRes.value.ok) {
      const h = await healthRes.value.json()
      ppHealthy.value = h.ok === true
    } else {
      ppHealthy.value = false
    }
    if (wdRes.status === 'fulfilled' && wdRes.value.ok) {
      watchdogTargets.value = await wdRes.value.json()
    }
    if (taskRes.status === 'fulfilled' && taskRes.value.ok) {
      tasks.value = await taskRes.value.json()
    }
    if (schedRes.status === 'fulfilled' && schedRes.value.ok) {
      scheduler.value = await schedRes.value.json()
    }
  } finally {
    isLoading.value = false
  }
}

onMounted(async () => {
  await fetchAll()
  pollTimer = setInterval(fetchAll, 8000)
})

onUnmounted(() => {
  if (pollTimer) clearInterval(pollTimer)
})

const healthyCount = computed(() => watchdogTargets.value.filter(t => t.status === 'healthy').length)
const unhealthyCount = computed(() => watchdogTargets.value.filter(t => t.status !== 'healthy').length)

const displayTasks = computed(() => {
  const running = tasks.value.filter(t => t.status === 'running')
  const others = tasks.value.filter(t => t.status !== 'running')
  const combined = [...running, ...others.slice(0, 20)]
  const seen = new Set<string>()
  return combined.filter(t => {
    if (seen.has(t.task_id)) return false
    seen.add(t.task_id)
    return true
  })
})

function statusColor(status: string) {
  switch (status) {
    case 'healthy': case 'running': return 'bg-emerald-500'
    case 'unhealthy': case 'error': case 'failed': return 'bg-red-500'
    case 'restarting': return 'bg-amber-400'
    case 'stopped': case 'paused': case 'cancelled': return 'bg-neutral-400'
    case 'queued': return 'bg-amber-400'
    case 'done': return 'bg-blue-400'
    case 'crash_loop': return 'bg-red-600'
    default: return 'bg-neutral-300'
  }
}

function statusBadge(status: string) {
  switch (status) {
    case 'healthy': return { cls: 'bg-emerald-50 text-emerald-700', label: '健康' }
    case 'running': return { cls: 'bg-emerald-50 text-emerald-700', label: '运行中' }
    case 'unhealthy': return { cls: 'bg-red-50 text-red-700', label: '异常' }
    case 'error': return { cls: 'bg-red-50 text-red-700', label: '错误' }
    case 'restarting': return { cls: 'bg-amber-50 text-amber-700', label: '重启中' }
    case 'crash_loop': return { cls: 'bg-red-50 text-red-700', label: '崩溃循环' }
    case 'stopped': return { cls: 'bg-neutral-100 text-neutral-500', label: '已停止' }
    case 'queued': return { cls: 'bg-amber-50 text-amber-700', label: '排队中' }
    case 'done': return { cls: 'bg-blue-50 text-blue-700', label: '已完成' }
    case 'failed': return { cls: 'bg-red-50 text-red-700', label: '失败' }
    case 'cancelled': return { cls: 'bg-neutral-100 text-neutral-500', label: '已取消' }
    default: return { cls: 'bg-neutral-100 text-neutral-500', label: status }
  }
}

function timeAgo(ts: string | null) {
  if (!ts) return '-'
  const d = new Date(ts)
  const now = Date.now()
  const diff = Math.floor((now - d.getTime()) / 1000)
  if (diff < 60) return `${diff}s 前`
  if (diff < 3600) return `${Math.floor(diff / 60)}m 前`
  if (diff < 86400) return `${Math.floor(diff / 3600)}h 前`
  return `${Math.floor(diff / 86400)}d 前`
}
</script>

<template>
  <div>
    <PageHeader title="PolarProcess 进程管理" description="服务守护 · 任务调度">
      <template #actions>
        <button
          class="rounded-lg border border-neutral-200 bg-white px-4 py-2 text-sm font-medium text-neutral-700 transition-colors hover:bg-neutral-50"
          :disabled="isLoading"
          @click="fetchAll()"
        >
          {{ isLoading ? '刷新中...' : '刷新' }}
        </button>
      </template>
    </PageHeader>

    <!-- Connection Warning -->
    <div
      v-if="!ppHealthy && !isLoading"
      class="mt-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800"
    >
      PolarProcess 服务不可用（端口 11055 无响应）
    </div>

    <!-- Stats -->
    <div class="mt-6 grid grid-cols-2 gap-4 sm:grid-cols-4">
      <StatCard
        label="Watchdog 监控"
        :value="watchdogTargets.length"
        icon="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z"
        accent-bg="bg-indigo-50"
        accent-text="text-indigo-600"
      />
      <StatCard
        label="健康"
        :value="healthyCount"
        icon="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"
        accent-bg="bg-emerald-50"
        accent-text="text-emerald-600"
      />
      <StatCard
        label="异常"
        :value="unhealthyCount"
        icon="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"
        accent-bg="bg-red-50"
        accent-text="text-red-600"
      />
      <StatCard
        label="任务队列"
        :value="tasks.length"
        icon="M4 6h16M4 10h16M4 14h16M4 18h16"
        accent-bg="bg-neutral-100"
        accent-text="text-neutral-700"
      />
    </div>

    <!-- Scheduler Summary -->
    <div v-if="scheduler && ppHealthy" class="mt-4 flex items-center gap-6 rounded-lg border border-neutral-200 bg-white px-5 py-3 text-sm">
      <span class="text-neutral-500">调度器</span>
      <span :class="scheduler.idle ? 'text-neutral-400' : 'text-emerald-600'" class="font-medium">
        {{ scheduler.idle ? '空闲' : '活跃' }}
      </span>
      <span class="text-neutral-400">|</span>
      <span class="text-neutral-600">运行 {{ scheduler.running_tasks }} / 队列 {{ scheduler.queue_depth }}</span>
      <span class="text-neutral-400">|</span>
      <span class="text-neutral-500">CPU {{ scheduler.avg_cpu.toFixed(0) }}% · MEM {{ scheduler.avg_mem.toFixed(0) }}%</span>
    </div>

    <!-- Section: Watchdog -->
    <section class="mt-8">
      <h3 class="mb-3 text-sm font-semibold uppercase tracking-wider text-neutral-500">Watchdog 服务守护</h3>
      <div class="space-y-2">
        <div
          v-for="target in watchdogTargets"
          :key="target.name"
          class="flex items-center justify-between rounded-xl border border-neutral-200 bg-white px-5 py-3 shadow-sm"
        >
          <div class="flex items-center gap-3">
            <span class="inline-flex h-2.5 w-2.5 rounded-full" :class="statusColor(target.status)" />
            <div>
              <span class="text-sm font-semibold text-neutral-900">{{ target.name }}</span>
              <span class="ml-3 text-xs text-neutral-400 font-mono">{{ target.healthEndpoint }}</span>
            </div>
          </div>
          <div class="flex items-center gap-3">
            <span v-if="target.restartAttempts > 0" class="text-xs text-amber-600">
              重启 {{ target.restartAttempts }} 次
            </span>
            <span class="rounded-full px-2.5 py-0.5 text-xs font-medium" :class="statusBadge(target.status).cls">
              {{ statusBadge(target.status).label }}
            </span>
            <span class="text-xs text-neutral-400">{{ timeAgo(target.lastCheck) }}</span>
          </div>
        </div>
        <div v-if="watchdogTargets.length === 0 && ppHealthy" class="py-8 text-center text-sm text-neutral-400">
          暂无 Watchdog 监控目标
        </div>
      </div>
    </section>

    <!-- Section: Task Queue -->
    <section class="mt-8">
      <h3 class="mb-3 text-sm font-semibold uppercase tracking-wider text-neutral-500">
        任务队列
        <span v-if="tasks.length > 0" class="ml-2 text-xs font-normal text-neutral-400">
          显示 {{ displayTasks.length }} / 总计 {{ tasks.length }}
        </span>
      </h3>
      <div class="space-y-2">
        <div
          v-for="task in displayTasks"
          :key="task.task_id"
          class="flex items-center justify-between rounded-xl border border-neutral-200 bg-white px-5 py-3 shadow-sm"
        >
          <div class="flex items-center gap-3">
            <span class="inline-flex h-2.5 w-2.5 rounded-full" :class="statusColor(task.status)" />
            <div>
              <span class="text-sm font-semibold text-neutral-900">{{ task.task_type }}</span>
              <span class="ml-2 text-xs text-neutral-400 font-mono truncate max-w-[300px] inline-block align-bottom">{{ task.command }}</span>
              <span v-if="task.owner" class="ml-2 text-xs text-neutral-400">by {{ task.owner }}</span>
            </div>
          </div>
          <div class="flex items-center gap-3">
            <div v-if="task.status === 'running' && task.progress > 0" class="w-20">
              <div class="h-1.5 w-full rounded-full bg-neutral-200">
                <div class="h-1.5 rounded-full bg-emerald-500" :style="{ width: task.progress + '%' }" />
              </div>
            </div>
            <span class="rounded-full px-2.5 py-0.5 text-xs font-medium" :class="statusBadge(task.status).cls">
              {{ statusBadge(task.status).label }}
            </span>
            <span class="text-xs text-neutral-400">{{ timeAgo(task.created_at) }}</span>
          </div>
        </div>
        <div v-if="tasks.length === 0 && ppHealthy" class="py-8 text-center text-sm text-neutral-400">
          当前无任务（等待 Agent 提交）
        </div>
      </div>
    </section>
  </div>
</template>
