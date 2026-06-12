<script setup lang="ts">
import { onMounted, onUnmounted, ref, computed } from 'vue'
import { useResourceStore } from '@/stores/resource'
import PageHeader from '@/components/PageHeader.vue'
import StatCard from '@/components/StatCard.vue'

const store = useResourceStore()
let timer: ReturnType<typeof setInterval> | null = null

onMounted(() => {
  store.fetchResources()
  timer = setInterval(() => store.fetchResources(), 10_000)
})

onUnmounted(() => {
  if (timer) clearInterval(timer)
})

const icons = {
  cpu: 'M9 3v2m6-2v2M9 19v2m6-2v2M5 9H3m2 6H3m18-6h-2m2 6h-2M7 19h10a2 2 0 002-2V7a2 2 0 00-2-2H7a2 2 0 00-2 2v10a2 2 0 002 2zM9 9h6v6H9V9z',
  memory: 'M4 7v10c0 2.21 3.582 4 8 4s8-1.79 8-4V7M4 7c0 2.21 3.582 4 8 4s8-1.79 8-4M4 7c0-2.21 3.582-4 8-4s8 1.79 8 4m0 5c0 2.21-3.582 4-8 4s-8-1.79-8-4',
  idle: 'M20.354 15.354A9 9 0 018.646 3.646 9.003 9.003 0 0012 21a9.003 9.003 0 008.354-5.646z',
  tasks: 'M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-6 9l2 2 4-4',
  trend: 'M13 7h8m0 0v8m0-8l-8 8-4-4-6 6',
  reserve: 'M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z',
}

const cpuColor = computed(() => {
  const cpu = store.latestSnapshot?.cpu_percent ?? 0
  if (cpu > 80) return { bg: 'bg-red-50', text: 'text-red-600' }
  if (cpu > 50) return { bg: 'bg-amber-50', text: 'text-amber-600' }
  return { bg: 'bg-emerald-50', text: 'text-emerald-600' }
})

const memColor = computed(() => {
  const mem = store.latestSnapshot?.mem_percent ?? 0
  if (mem > 90) return { bg: 'bg-red-50', text: 'text-red-600' }
  if (mem > 70) return { bg: 'bg-amber-50', text: 'text-amber-600' }
  return { bg: 'bg-emerald-50', text: 'text-emerald-600' }
})

const idleLabel = computed(() => {
  if (!store.idleStatus) return '加载中'
  if (store.idleStatus.idle) return '空闲'
  const reasons: Record<string, string> = {
    cpu_busy: 'CPU 繁忙',
    mem_pressure: '内存紧张',
    cpu_spikes: 'CPU 尖峰',
    not_enough_data: '数据不足',
  }
  return reasons[store.idleStatus.reason] || '繁忙'
})

const confidenceLabel: Record<string, string> = {
  low: '初期',
  medium: '学习中',
  high: '成熟',
}

const confidenceColor: Record<string, string> = {
  low: 'bg-neutral-100 text-neutral-600',
  medium: 'bg-amber-100 text-amber-700',
  high: 'bg-emerald-100 text-emerald-700',
}

const statusColor: Record<string, string> = {
  queued: 'bg-blue-100 text-blue-700',
  running: 'bg-emerald-100 text-emerald-700',
  paused: 'bg-amber-100 text-amber-700',
  done: 'bg-neutral-100 text-neutral-600',
  failed: 'bg-red-100 text-red-700',
}

const cpuHistory = computed(() => {
  return store.snapshots.slice(0, 20).reverse().map(s => s.cpu_percent)
})

const memHistory = computed(() => {
  return store.snapshots.slice(0, 20).reverse().map(s => s.mem_percent)
})

// 趋势方向标签和颜色
const directionLabel: Record<string, string> = { rising: '上升', falling: '下降', stable: '稳定' }
const directionIcon: Record<string, string> = { rising: '↑', falling: '↓', stable: '→' }
const directionColor: Record<string, string> = {
  rising: 'text-red-600',
  falling: 'text-emerald-600',
  stable: 'text-neutral-500',
}

// 任务状态筛选 Tab
const taskFilter = ref<'all' | 'queued' | 'running' | 'done' | 'failed'>('all')
const filteredTasks = computed(() => {
  if (taskFilter.value === 'all') return store.tasks
  return store.tasks.filter(t => t.status === taskFilter.value)
})
const taskFilterCounts = computed(() => ({
  all: store.tasks.length,
  queued: store.queuedTasks.length,
  running: store.runningTasks.length,
  done: store.tasks.filter(t => t.status === 'done').length,
  failed: store.tasks.filter(t => t.status === 'failed').length,
}))

const showSubmitForm = ref(false)
const newTaskType = ref('')
const newTaskCommand = ref('')
const newTaskPriority = ref(0)

async function handleSubmit() {
  if (!newTaskType.value || !newTaskCommand.value) return
  await store.submitTask(newTaskType.value, newTaskCommand.value, newTaskPriority.value)
  newTaskType.value = ''
  newTaskCommand.value = ''
  newTaskPriority.value = 0
  showSubmitForm.value = false
}

function formatTime(iso: string | null) {
  if (!iso) return '-'
  return new Date(iso).toLocaleString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' })
}
</script>

<template>
  <div>
    <PageHeader title="资源画像" description="系统资源监控 + 任务调度队列" />

    <!-- 概览统计卡片 -->
    <section class="mt-8 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
      <StatCard
        label="CPU 使用率"
        :value="`${store.latestSnapshot?.cpu_percent ?? '-'}%`"
        :icon="icons.cpu"
        :accent-bg="cpuColor.bg"
        :accent-text="cpuColor.text"
      />
      <StatCard
        label="内存使用率"
        :value="`${store.latestSnapshot?.mem_percent ?? '-'}%`"
        :icon="icons.memory"
        :accent-bg="memColor.bg"
        :accent-text="memColor.text"
      />
      <StatCard
        label="系统状态"
        :value="idleLabel"
        :icon="icons.idle"
        :accent-bg="store.idleStatus?.idle ? 'bg-emerald-50' : 'bg-amber-50'"
        :accent-text="store.idleStatus?.idle ? 'text-emerald-600' : 'text-amber-600'"
      />
      <StatCard
        label="任务队列"
        :value="`${store.queuedTasks.length} 排队 / ${store.runningTasks.length} 运行`"
        :icon="icons.tasks"
        accent-bg="bg-blue-50"
        accent-text="text-blue-600"
      />
    </section>

    <!-- CPU/内存 mini 柱状图 + 趋势预测 -->
    <section class="mt-8 grid grid-cols-1 gap-6 lg:grid-cols-2">
      <!-- CPU 趋势 -->
      <div class="rounded-xl border border-neutral-200 bg-white p-5 shadow-sm">
        <div class="flex items-center justify-between">
          <h3 class="text-sm font-medium text-neutral-700">CPU 趋势</h3>
          <div v-if="store.trend?.cpu" class="flex items-center gap-1.5">
            <span class="text-xs font-medium" :class="directionColor[store.trend.cpu.direction]">
              {{ directionIcon[store.trend.cpu.direction] }} {{ directionLabel[store.trend.cpu.direction] }}
            </span>
            <span class="rounded-full px-1.5 py-0.5 text-[10px] font-medium" :class="confidenceColor[store.trend.cpu.confidence]">
              {{ confidenceLabel[store.trend.cpu.confidence] }}
            </span>
          </div>
        </div>
        <p class="text-xs text-neutral-400">最近 {{ cpuHistory.length }} 次快照（每 30s）</p>
        <div class="mt-3 flex items-end gap-1" style="height: 80px;">
          <div
            v-for="(val, i) in cpuHistory"
            :key="i"
            class="flex-1 rounded-t transition-all"
            :class="val > 80 ? 'bg-red-400' : val > 50 ? 'bg-amber-400' : 'bg-emerald-400'"
            :style="{ height: `${Math.max(val, 2)}%` }"
            :title="`CPU: ${val}%`"
          />
        </div>
        <div class="mt-2 flex items-center justify-between text-xs text-neutral-500">
          <span>
            平均: {{ store.idleStatus?.avgCpu ?? '-' }}% /
            峰值: {{ store.idleStatus?.maxCpu ?? '-' }}%
          </span>
          <span v-if="store.trend?.cpu" class="font-mono">
            预测 5min: {{ store.trend.cpu.predicted }}%
          </span>
        </div>
      </div>

      <!-- 内存趋势 -->
      <div class="rounded-xl border border-neutral-200 bg-white p-5 shadow-sm">
        <div class="flex items-center justify-between">
          <h3 class="text-sm font-medium text-neutral-700">内存趋势</h3>
          <div v-if="store.trend?.mem" class="flex items-center gap-1.5">
            <span class="text-xs font-medium" :class="directionColor[store.trend.mem.direction]">
              {{ directionIcon[store.trend.mem.direction] }} {{ directionLabel[store.trend.mem.direction] }}
            </span>
            <span class="rounded-full px-1.5 py-0.5 text-[10px] font-medium" :class="confidenceColor[store.trend.mem.confidence]">
              {{ confidenceLabel[store.trend.mem.confidence] }}
            </span>
          </div>
        </div>
        <p class="text-xs text-neutral-400">
          {{ store.latestSnapshot ? `${store.latestSnapshot.mem_used_mb}MB / ${store.latestSnapshot.mem_total_mb}MB` : '-' }}
        </p>
        <div class="mt-3 flex items-end gap-1" style="height: 80px;">
          <div
            v-for="(val, i) in memHistory"
            :key="i"
            class="flex-1 rounded-t transition-all"
            :class="val > 90 ? 'bg-red-400' : val > 70 ? 'bg-amber-400' : 'bg-emerald-400'"
            :style="{ height: `${Math.max(val, 2)}%` }"
            :title="`MEM: ${val}%`"
          />
        </div>
        <div class="mt-2 flex items-center justify-between text-xs text-neutral-500">
          <span>平均: {{ store.idleStatus?.avgMem ?? '-' }}%</span>
          <span v-if="store.trend?.mem" class="font-mono">
            预测 5min: {{ store.trend.mem.predicted }}%
          </span>
        </div>
      </div>
    </section>

    <!-- 趋势预测 + 资源预留 摘要条 -->
    <section v-if="store.trend || store.reservations" class="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2">
      <div v-if="store.trend" class="flex items-center gap-3 rounded-xl border border-neutral-200 bg-white px-5 py-3 shadow-sm">
        <svg class="h-5 w-5 text-neutral-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
          <path stroke-linecap="round" stroke-linejoin="round" :d="icons.trend" />
        </svg>
        <div class="text-xs text-neutral-600">
          <span class="font-medium">趋势预测</span>
          · {{ store.trend.data_points }} 个数据点
          · 窗口 {{ Math.round(store.trend.window_span_sec) }}s
          · CPU {{ store.trend.cpu.current }}% → <span :class="directionColor[store.trend.cpu.direction]">{{ store.trend.cpu.predicted }}%</span>
          · 内存 {{ store.trend.mem.current }}% → <span :class="directionColor[store.trend.mem.direction]">{{ store.trend.mem.predicted }}%</span>
        </div>
      </div>
      <div v-if="store.reservations" class="flex items-center gap-3 rounded-xl border border-neutral-200 bg-white px-5 py-3 shadow-sm">
        <svg class="h-5 w-5 text-neutral-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
          <path stroke-linecap="round" stroke-linejoin="round" :d="icons.reserve" />
        </svg>
        <div class="text-xs text-neutral-600">
          <span class="font-medium">资源预留</span>
          · {{ store.reservations.count }} 个任务
          · CPU {{ Math.round(store.reservations.totalCpu) }}%
          · 内存 {{ Math.round(store.reservations.totalMem) }}MB
          <template v-if="store.reservations.totalGpu > 0"> · GPU {{ Math.round(store.reservations.totalGpu) }}MB</template>
        </div>
      </div>
    </section>

    <!-- 进程画像 -->
    <section class="mt-8">
      <h2 class="text-sm font-medium uppercase tracking-wide text-neutral-500">进程画像</h2>
      <div class="mt-3 overflow-hidden rounded-xl border border-neutral-200 bg-white shadow-sm">
        <table class="w-full text-left text-sm">
          <thead class="border-b border-neutral-100 bg-neutral-50 text-xs uppercase text-neutral-500">
            <tr>
              <th class="px-4 py-3">类型</th>
              <th class="px-4 py-3">平均 CPU</th>
              <th class="px-4 py-3">峰值 CPU</th>
              <th class="px-4 py-3">平均内存</th>
              <th class="px-4 py-3">峰值内存</th>
              <th class="px-4 py-3">GPU</th>
              <th class="px-4 py-3">采样数</th>
              <th class="px-4 py-3">置信度</th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="p in store.profiles"
              :key="p.task_type"
              class="border-b border-neutral-50 last:border-0"
            >
              <td class="px-4 py-3 font-mono text-xs font-medium text-neutral-900">{{ p.task_type }}</td>
              <td class="px-4 py-3">{{ Math.round(p.avg_cpu_percent) }}%</td>
              <td class="px-4 py-3">{{ Math.round(p.peak_cpu_percent) }}%</td>
              <td class="px-4 py-3">{{ Math.round(p.avg_mem_mb) }}MB</td>
              <td class="px-4 py-3">{{ Math.round(p.peak_mem_mb) }}MB</td>
              <td class="px-4 py-3">{{ p.gpu_mem_mb > 0 ? `${Math.round(p.gpu_mem_mb)}MB` : '-' }}</td>
              <td class="px-4 py-3 font-mono">{{ p.sample_count }}</td>
              <td class="px-4 py-3">
                <span class="rounded-full px-2 py-0.5 text-xs font-medium" :class="confidenceColor[p.confidence] ?? 'bg-neutral-100'">
                  {{ confidenceLabel[p.confidence] ?? p.confidence }}
                </span>
              </td>
            </tr>
            <tr v-if="store.profiles.length === 0">
              <td colspan="8" class="px-4 py-8 text-center text-neutral-400">暂无画像数据</td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>

    <!-- 任务队列 -->
    <section class="mt-8">
      <div class="flex items-center justify-between">
        <h2 class="text-sm font-medium uppercase tracking-wide text-neutral-500">任务队列</h2>
        <button
          class="rounded-lg bg-neutral-900 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-neutral-700"
          @click="showSubmitForm = !showSubmitForm"
        >
          {{ showSubmitForm ? '取消' : '提交新任务' }}
        </button>
      </div>

      <!-- 状态筛选 Tabs -->
      <div class="mt-3 flex gap-1">
        <button
          v-for="tab in (['all', 'queued', 'running', 'done', 'failed'] as const)"
          :key="tab"
          class="rounded-lg px-3 py-1.5 text-xs font-medium transition-colors"
          :class="taskFilter === tab ? 'bg-neutral-900 text-white' : 'bg-neutral-100 text-neutral-600 hover:bg-neutral-200'"
          @click="taskFilter = tab"
        >
          {{ { all: '全部', queued: '排队', running: '运行中', done: '完成', failed: '失败' }[tab] }}
          <span class="ml-1 rounded-full bg-white/20 px-1.5 text-[10px]">{{ taskFilterCounts[tab] }}</span>
        </button>
      </div>

      <!-- 新任务表单 -->
      <div v-if="showSubmitForm" class="mt-3 rounded-xl border border-neutral-200 bg-white p-5 shadow-sm">
        <div class="grid grid-cols-1 gap-4 sm:grid-cols-3">
          <div>
            <label class="mb-1 block text-xs text-neutral-500">任务类型</label>
            <input
              v-model="newTaskType"
              type="text"
              placeholder="whisper / llm-local / gpu"
              class="w-full rounded-lg border border-neutral-300 px-3 py-2 text-sm focus:border-neutral-900 focus:outline-none"
            />
          </div>
          <div>
            <label class="mb-1 block text-xs text-neutral-500">优先级</label>
            <select
              v-model="newTaskPriority"
              class="w-full rounded-lg border border-neutral-300 px-3 py-2 text-sm focus:border-neutral-900 focus:outline-none"
            >
              <option :value="0">Low (0)</option>
              <option :value="1">Normal (1)</option>
              <option :value="2">High (2)</option>
            </select>
          </div>
          <div class="flex items-end">
            <button
              class="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-emerald-500"
              @click="handleSubmit"
            >
              提交
            </button>
          </div>
        </div>
        <div class="mt-3">
          <label class="mb-1 block text-xs text-neutral-500">命令</label>
          <input
            v-model="newTaskCommand"
            type="text"
            placeholder="echo hello && sleep 10"
            class="w-full rounded-lg border border-neutral-300 px-3 py-2 text-sm focus:border-neutral-900 focus:outline-none"
          />
        </div>
      </div>

      <!-- 任务列表 -->
      <div class="mt-3 overflow-hidden rounded-xl border border-neutral-200 bg-white shadow-sm">
        <table class="w-full text-left text-sm">
          <thead class="border-b border-neutral-100 bg-neutral-50 text-xs uppercase text-neutral-500">
            <tr>
              <th class="px-4 py-3">ID</th>
              <th class="px-4 py-3">类型</th>
              <th class="px-4 py-3">优先级</th>
              <th class="px-4 py-3">状态</th>
              <th class="px-4 py-3">PID</th>
              <th class="px-4 py-3">创建时间</th>
              <th class="px-4 py-3">操作</th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="t in filteredTasks"
              :key="t.id"
              class="border-b border-neutral-50 last:border-0"
            >
              <td class="px-4 py-3 font-mono text-xs text-neutral-600">{{ t.id }}</td>
              <td class="px-4 py-3 font-mono text-xs font-medium text-neutral-900">{{ t.task_type }}</td>
              <td class="px-4 py-3">{{ ['Low', 'Normal', 'High'][t.priority] ?? t.priority }}</td>
              <td class="px-4 py-3">
                <span class="rounded-full px-2 py-0.5 text-xs font-medium" :class="statusColor[t.status] ?? 'bg-neutral-100'">
                  {{ t.status }}
                </span>
              </td>
              <td class="px-4 py-3 font-mono text-xs">{{ t.pid ?? '-' }}</td>
              <td class="px-4 py-3 text-xs text-neutral-500">{{ formatTime(t.created_at) }}</td>
              <td class="px-4 py-3">
                <button
                  v-if="t.status === 'queued'"
                  class="text-xs text-red-600 hover:text-red-800"
                  @click="store.cancelTask(t.id)"
                >
                  取消
                </button>
              </td>
            </tr>
            <tr v-if="filteredTasks.length === 0">
              <td colspan="7" class="px-4 py-8 text-center text-neutral-400">
                {{ taskFilter === 'all' ? '队列为空' : '无匹配任务' }}
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>
  </div>
</template>
