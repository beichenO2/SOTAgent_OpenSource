<script setup lang="ts">
import { onMounted, onUnmounted, ref, computed } from 'vue'
import { useProcessStore } from '@/stores/process'
import PageHeader from '@/components/PageHeader.vue'
import StatCard from '@/components/StatCard.vue'
import type { IProcessStatus } from '@/types'

const store = useProcessStore()
const showRegisterModal = ref(false)
const activeTab = ref<'services' | 'watchdog'>('services')
let pollTimer: ReturnType<typeof setInterval> | null = null

onMounted(async () => {
  await store.fetchServices()
  pollTimer = setInterval(() => store.fetchServices(), 10000)
})

onUnmounted(() => {
  if (pollTimer) clearInterval(pollTimer)
})

function statusColor(s: IProcessStatus['status']) {
  switch (s) {
    case 'running': return 'bg-emerald-50 text-emerald-700'
    case 'starting': return 'bg-amber-50 text-amber-700'
    case 'stopped': return 'bg-neutral-100 text-neutral-500'
    case 'error': return 'bg-red-50 text-red-700'
  }
}

function statusLabel(s: IProcessStatus['status']) {
  const map = { running: '运行中', starting: '启动中', stopped: '已停止', error: '异常' }
  return map[s]
}

function wdStatusBadge(status: string) {
  switch (status) {
    case 'healthy': return { cls: 'bg-emerald-50 text-emerald-700', label: '健康' }
    case 'unhealthy': return { cls: 'bg-red-50 text-red-700', label: '异常' }
    case 'restarting': return { cls: 'bg-amber-50 text-amber-700', label: '重启中' }
    case 'crash_loop': return { cls: 'bg-red-50 text-red-700', label: '崩溃循环' }
    default: return { cls: 'bg-neutral-100 text-neutral-500', label: status }
  }
}

function wdDotColor(status: string) {
  switch (status) {
    case 'healthy': return 'bg-emerald-500'
    case 'unhealthy': return 'bg-red-500'
    case 'restarting': return 'bg-amber-400'
    case 'crash_loop': return 'bg-red-600'
    default: return 'bg-neutral-300'
  }
}

function timeAgo(iso: string | null): string {
  if (!iso) return '-'
  const diff = Date.now() - new Date(iso).getTime()
  if (diff < 0) return '刚刚'
  if (diff < 60000) return '刚刚'
  if (diff < 3600000) return `${Math.floor(diff / 60000)} 分钟前`
  if (diff < 86400000) return `${Math.floor(diff / 3600000)} 小时前`
  return `${Math.floor(diff / 86400000)} 天前`
}

async function handleAction(id: string, action: 'start' | 'stop' | 'restart') {
  try {
    await store.serviceAction(id, action)
  } catch { /* store 已设置 error */ }
}

interface INewService {
  id: string
  name: string
  command: string
  work_dir: string
  device_id: string
  auto_start: boolean
  restart_on_failure: boolean
  port: number | null
  health_check_url: string
}

const newService = ref<INewService>({
  id: '',
  name: '',
  command: '',
  work_dir: '',
  device_id: 'any',
  auto_start: false,
  restart_on_failure: false,
  port: null,
  health_check_url: '',
})

async function registerService() {
  if (!newService.value.id || !newService.value.name || !newService.value.command) return
  try {
    const body = {
      ...newService.value,
      port: newService.value.port || undefined,
      health_check_url: newService.value.health_check_url || undefined,
      work_dir: newService.value.work_dir || undefined,
    }
    const res = await fetch(import.meta.env.BASE_URL + 'api/services', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    if (!res.ok) throw new Error('注册失败')
    showRegisterModal.value = false
    newService.value = { id: '', name: '', command: '', work_dir: '', device_id: 'any', auto_start: false, restart_on_failure: false, port: null, health_check_url: '' }
    await store.fetchServices()
  } catch (e) {
    store.error = e instanceof Error ? e.message : String(e)
  }
}
</script>

<template>
  <div>
    <PageHeader title="服务管理" description="进程生命周期 · 健康监控 · 任务调度">
      <template #actions>
        <button
          class="rounded-lg bg-neutral-900 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-neutral-800"
          @click="showRegisterModal = true"
        >
          注册服务
        </button>
        <button
          class="rounded-lg border border-neutral-200 bg-white px-4 py-2 text-sm font-medium text-neutral-700 transition-colors hover:bg-neutral-50"
          :disabled="store.isLoading"
          @click="store.fetchServices()"
        >
          {{ store.isLoading ? '刷新中...' : '刷新' }}
        </button>
      </template>
    </PageHeader>

    <!-- 统计卡片 -->
    <div class="mt-6 grid grid-cols-2 gap-4 sm:grid-cols-4">
      <StatCard
        label="服务总数"
        :value="store.services.length"
        icon="M5 12h14M5 12a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v4a2 2 0 01-2 2M5 12a2 2 0 00-2 2v4a2 2 0 002 2h14a2 2 0 002-2v-4a2 2 0 00-2-2"
        accent-bg="bg-neutral-100"
        accent-text="text-neutral-700"
      />
      <StatCard
        label="运行中"
        :value="store.runningCount"
        icon="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"
        accent-bg="bg-emerald-50"
        accent-text="text-emerald-600"
      />
      <StatCard
        label="异常"
        :value="store.errorCount"
        icon="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"
        accent-bg="bg-red-50"
        accent-text="text-red-600"
      />
      <StatCard
        label="Watchdog 监控"
        :value="store.watchdogTargets.length"
        icon="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z"
        accent-bg="bg-indigo-50"
        accent-text="text-indigo-600"
      />
    </div>

    <!-- Scheduler Summary -->
    <div v-if="store.scheduler && store.ppHealthy" class="mt-4 flex items-center gap-6 rounded-lg border border-neutral-200 bg-white px-5 py-3 text-sm">
      <span class="text-neutral-500">调度器</span>
      <span :class="store.scheduler.idle ? 'text-neutral-400' : 'text-emerald-600'" class="font-medium">
        {{ store.scheduler.idle ? '空闲' : '活跃' }}
      </span>
      <span class="text-neutral-400">|</span>
      <span class="text-neutral-600">运行 {{ store.scheduler.running_tasks }} / 队列 {{ store.scheduler.queue_depth }}</span>
      <span class="text-neutral-400">|</span>
      <span class="text-neutral-500">CPU {{ store.scheduler.avg_cpu.toFixed(0) }}% · MEM {{ store.scheduler.avg_mem.toFixed(0) }}%</span>
    </div>

    <!-- PolarProcess 不可用提示 -->
    <div
      v-if="!store.ppHealthy && !store.isLoading"
      class="mt-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800"
    >
      PolarProcess 服务不可用（端口 11055 无响应）
    </div>

    <!-- 错误提示 -->
    <div
      v-if="store.error"
      class="mt-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700"
    >
      {{ store.error }}
      <button class="ml-2 font-medium underline" @click="store.error = null">关闭</button>
    </div>

    <!-- Tab 切换 -->
    <div class="mt-6 flex gap-1 rounded-lg bg-neutral-100 p-1">
      <button
        class="flex-1 rounded-md px-4 py-2 text-sm font-medium transition-colors"
        :class="activeTab === 'services' ? 'bg-white text-neutral-900 shadow-sm' : 'text-neutral-500 hover:text-neutral-700'"
        @click="activeTab = 'services'"
      >
        进程管理 ({{ store.services.length }})
      </button>
      <button
        class="flex-1 rounded-md px-4 py-2 text-sm font-medium transition-colors"
        :class="activeTab === 'watchdog' ? 'bg-white text-neutral-900 shadow-sm' : 'text-neutral-500 hover:text-neutral-700'"
        @click="activeTab = 'watchdog'"
      >
        Watchdog 健康监控 ({{ store.watchdogTargets.length }})
      </button>
    </div>

    <!-- ═══ Tab: 进程管理 ═══ -->
    <template v-if="activeTab === 'services'">
      <!-- 本机服务 -->
      <section class="mt-6">
        <h3 class="text-sm font-semibold uppercase tracking-wider text-neutral-500">本机服务</h3>
        <div class="mt-3 space-y-3">
          <div
            v-for="svc in store.localServices"
            :key="svc.id"
            class="flex items-center justify-between rounded-xl border border-neutral-200 bg-white px-5 py-4 shadow-sm transition-colors hover:border-neutral-300"
          >
            <div class="flex items-center gap-4">
              <span
                class="inline-flex h-2.5 w-2.5 rounded-full"
                :class="{
                  'bg-emerald-500': svc.status === 'running',
                  'bg-amber-400 animate-pulse': svc.status === 'starting',
                  'bg-neutral-300': svc.status === 'stopped',
                  'bg-red-500': svc.status === 'error',
                }"
              />
              <div>
                <div class="text-sm font-semibold text-neutral-900">{{ svc.name }}</div>
                <div class="mt-0.5 flex items-center gap-3 text-xs text-neutral-500">
                  <span v-if="svc.port" class="font-mono">:{{ svc.port }}</span>
                  <span v-if="svc.pid" :class="svc.pid_verified === false ? 'text-red-500' : ''">
                    PID {{ svc.pid }}
                    <span v-if="svc.pid_verified === false" title="PID 未通过存活验证">⚠</span>
                  </span>
                  <span v-if="svc.auto_start" class="text-blue-600">自动启动</span>
                  <span v-if="svc.restart_count > 0" class="text-amber-600">
                    重启 {{ svc.restart_count }}/{{ svc.max_restarts }}
                  </span>
                </div>
              </div>
            </div>

              <div class="flex items-center gap-3">
              <span
                class="rounded-full px-2.5 py-0.5 text-xs font-medium"
                :class="statusColor(svc.status)"
              >
                {{ statusLabel(svc.status) }}
              </span>
              <span class="text-xs text-neutral-400">{{ timeAgo(svc.last_health_check || svc.started_at) }}</span>

              <div class="flex gap-1">
                <button
                  v-if="(svc.status === 'stopped' || svc.status === 'error') && svc.restart_count < svc.max_restarts"
                  class="rounded-md bg-emerald-50 px-3 py-1.5 text-xs font-medium text-emerald-700 transition-colors hover:bg-emerald-100 disabled:opacity-40"
                  :disabled="store.isPending(svc.id)"
                  @click="handleAction(svc.id, 'start')"
                >
                  启动
                </button>
                <button
                  v-if="(svc.status === 'stopped' || svc.status === 'error') && svc.restart_count >= svc.max_restarts"
                  class="rounded-md bg-amber-50 px-3 py-1.5 text-xs font-medium text-amber-700 transition-colors hover:bg-amber-100 disabled:opacity-40"
                  :disabled="store.isPending(svc.id)"
                  @click="store.resetAndStart(svc.id).catch(() => {})"
                >
                  重置并启动
                </button>
                <button
                  v-if="svc.status === 'running'"
                  class="rounded-md bg-red-50 px-3 py-1.5 text-xs font-medium text-red-700 transition-colors hover:bg-red-100 disabled:opacity-40"
                  :disabled="store.isPending(svc.id)"
                  @click="handleAction(svc.id, 'stop')"
                >
                  停止
                </button>
                <button
                  v-if="svc.status === 'running'"
                  class="rounded-md bg-amber-50 px-3 py-1.5 text-xs font-medium text-amber-700 transition-colors hover:bg-amber-100 disabled:opacity-40"
                  :disabled="store.isPending(svc.id)"
                  @click="handleAction(svc.id, 'restart')"
                >
                  重启
                </button>
              </div>
            </div>
            <!-- 错误详情 -->
            <div
              v-if="svc.status === 'error' && svc.last_error"
              class="mt-2 rounded-lg bg-red-50 px-4 py-2 text-xs text-red-700"
            >
              <span class="font-semibold">错误:</span>
              <span class="ml-1 font-mono">{{ svc.last_error }}</span>
            </div>
          </div>
          <div v-if="store.localServices.length === 0" class="py-8 text-center text-sm text-neutral-400">
            {{ store.isLoading ? '加载中...' : '暂无本机服务' }}
          </div>
        </div>
      </section>

      <!-- 远程服务 -->
      <section v-if="store.remoteServices.length > 0" class="mt-8">
        <h3 class="text-sm font-semibold uppercase tracking-wider text-neutral-500">远程服务</h3>
        <div class="mt-3 space-y-3">
          <div
            v-for="svc in store.remoteServices"
            :key="svc.id"
            class="flex items-center justify-between rounded-xl border border-neutral-200 bg-white px-5 py-4 shadow-sm"
          >
            <div class="flex items-center gap-4">
              <span
                class="inline-flex h-2.5 w-2.5 rounded-full"
                :class="{
                  'bg-emerald-500': svc.status === 'running',
                  'bg-amber-400': svc.status === 'starting',
                  'bg-neutral-300': svc.status === 'stopped',
                  'bg-red-500': svc.status === 'error',
                }"
              />
              <div>
                <div class="text-sm font-semibold text-neutral-900">{{ svc.name }}</div>
                <div class="mt-0.5 flex items-center gap-3 text-xs text-neutral-500">
                  <span class="rounded bg-purple-50 px-1.5 py-0.5 text-purple-700">
                    {{ svc.remote_device ?? svc.device_id }}
                  </span>
                  <span v-if="svc.port" class="font-mono">:{{ svc.port }}</span>
                  <span v-if="svc.auto_start" class="text-blue-600">自动启动</span>
                </div>
              </div>
            </div>

            <div class="flex items-center gap-3">
              <span
                class="rounded-full px-2.5 py-0.5 text-xs font-medium"
                :class="statusColor(svc.status)"
              >
                {{ statusLabel(svc.status) }}
              </span>
              <div class="flex gap-1">
                <button
                  v-if="svc.status === 'stopped' || svc.status === 'error'"
                  class="rounded-md bg-emerald-50 px-3 py-1.5 text-xs font-medium text-emerald-700 transition-colors hover:bg-emerald-100 disabled:opacity-40"
                  :disabled="store.isPending(svc.id)"
                  @click="handleAction(svc.id, 'start')"
                >
                  启动
                </button>
                <button
                  v-if="svc.status === 'running'"
                  class="rounded-md bg-red-50 px-3 py-1.5 text-xs font-medium text-red-700 transition-colors hover:bg-red-100 disabled:opacity-40"
                  :disabled="store.isPending(svc.id)"
                  @click="handleAction(svc.id, 'stop')"
                >
                  停止
                </button>
                <button
                  v-if="svc.status === 'running'"
                  class="rounded-md bg-amber-50 px-3 py-1.5 text-xs font-medium text-amber-700 transition-colors hover:bg-amber-100 disabled:opacity-40"
                  :disabled="store.isPending(svc.id)"
                  @click="handleAction(svc.id, 'restart')"
                >
                  重启
                </button>
              </div>
            </div>
          </div>
        </div>
      </section>
    </template>

    <!-- ═══ Tab: Watchdog 健康监控 ═══ -->
    <template v-if="activeTab === 'watchdog'">
      <section class="mt-6">
        <div class="space-y-2">
          <div
            v-for="target in store.watchdogTargets"
            :key="target.name"
            class="flex items-center justify-between rounded-xl border border-neutral-200 bg-white px-5 py-3 shadow-sm"
          >
            <div class="flex items-center gap-3">
              <span class="inline-flex h-2.5 w-2.5 rounded-full" :class="wdDotColor(target.status)" />
              <div>
                <span class="text-sm font-semibold text-neutral-900">{{ target.name }}</span>
                <span class="ml-3 text-xs text-neutral-400 font-mono">{{ target.healthEndpoint }}</span>
              </div>
            </div>
            <div class="flex items-center gap-3">
              <span v-if="target.restartAttempts > 0" class="text-xs text-amber-600">
                重启 {{ target.restartAttempts }} 次
              </span>
              <span class="rounded-full px-2.5 py-0.5 text-xs font-medium" :class="wdStatusBadge(target.status).cls">
                {{ wdStatusBadge(target.status).label }}
              </span>
              <span class="text-xs text-neutral-400">{{ timeAgo(target.lastCheck) }}</span>
            </div>
          </div>
          <div v-if="store.watchdogTargets.length === 0 && store.ppHealthy" class="py-8 text-center text-sm text-neutral-400">
            暂无 Watchdog 监控目标
          </div>
        </div>
      </section>
    </template>

    <!-- 注册服务弹窗 -->
    <Teleport to="body">
      <div
        v-if="showRegisterModal"
        class="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
        @click.self="showRegisterModal = false"
      >
        <div class="w-full max-w-lg rounded-2xl bg-white p-6 shadow-xl">
          <h3 class="text-lg font-semibold text-neutral-900">注册新服务</h3>
          <div class="mt-4 space-y-3">
            <div class="grid grid-cols-2 gap-3">
              <div>
                <label class="mb-1 block text-xs font-medium text-neutral-600">服务 ID</label>
                <input
                  v-model="newService.id"
                  class="w-full rounded-lg border border-neutral-200 px-3 py-2 text-sm focus:border-neutral-400 focus:outline-none"
                  placeholder="如 whisper-server"
                />
              </div>
              <div>
                <label class="mb-1 block text-xs font-medium text-neutral-600">显示名称</label>
                <input
                  v-model="newService.name"
                  class="w-full rounded-lg border border-neutral-200 px-3 py-2 text-sm focus:border-neutral-400 focus:outline-none"
                  placeholder="如 Whisper 语音服务"
                />
              </div>
            </div>
            <div>
              <label class="mb-1 block text-xs font-medium text-neutral-600">启动命令</label>
              <input
                v-model="newService.command"
                class="w-full rounded-lg border border-neutral-200 px-3 py-2 font-mono text-sm focus:border-neutral-400 focus:outline-none"
                placeholder="如 python -m whisper.serve"
              />
            </div>
            <div>
              <label class="mb-1 block text-xs font-medium text-neutral-600">工作目录</label>
              <input
                v-model="newService.work_dir"
                class="w-full rounded-lg border border-neutral-200 px-3 py-2 font-mono text-sm focus:border-neutral-400 focus:outline-none"
                placeholder="如 ~/Projects/whisper（留空则当前目录）"
              />
            </div>
            <div class="grid grid-cols-2 gap-3">
              <div>
                <label class="mb-1 block text-xs font-medium text-neutral-600">目标设备</label>
                <select
                  v-model="newService.device_id"
                  class="w-full rounded-lg border border-neutral-200 px-3 py-2 text-sm focus:border-neutral-400 focus:outline-none"
                >
                  <option value="any">任意设备</option>
                  <option v-for="dev in store.devices" :key="dev.device_id" :value="dev.device_id">
                    {{ dev.display_name }}
                  </option>
                </select>
              </div>
              <div>
                <label class="mb-1 block text-xs font-medium text-neutral-600">端口（可选）</label>
                <input
                  v-model.number="newService.port"
                  type="number"
                  class="w-full rounded-lg border border-neutral-200 px-3 py-2 text-sm focus:border-neutral-400 focus:outline-none"
                  placeholder="如 8080"
                />
              </div>
            </div>
            <div>
              <label class="mb-1 block text-xs font-medium text-neutral-600">健康检查 URL（可选）</label>
              <input
                v-model="newService.health_check_url"
                class="w-full rounded-lg border border-neutral-200 px-3 py-2 font-mono text-sm focus:border-neutral-400 focus:outline-none"
                placeholder="如 http://localhost:8080/health"
              />
            </div>
            <div class="flex gap-4">
              <label class="flex items-center gap-2 text-sm text-neutral-700">
                <input v-model="newService.auto_start" type="checkbox" class="rounded" />
                自动启动
              </label>
              <label class="flex items-center gap-2 text-sm text-neutral-700">
                <input v-model="newService.restart_on_failure" type="checkbox" class="rounded" />
                失败自动重启
              </label>
            </div>
          </div>
          <div class="mt-6 flex justify-end gap-3">
            <button
              class="rounded-lg border border-neutral-200 px-4 py-2 text-sm font-medium text-neutral-700 transition-colors hover:bg-neutral-50"
              @click="showRegisterModal = false"
            >
              取消
            </button>
            <button
              class="rounded-lg bg-neutral-900 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-neutral-800 disabled:opacity-40"
              :disabled="!newService.id || !newService.name || !newService.command"
              @click="registerService()"
            >
              注册
            </button>
          </div>
        </div>
      </div>
    </Teleport>
  </div>
</template>
