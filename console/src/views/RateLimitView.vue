<script setup lang="ts">
import { onMounted, onUnmounted, ref, computed } from 'vue'
import PageHeader from '@/components/PageHeader.vue'
import StatCard from '@/components/StatCard.vue'

interface IServiceStats {
  service: string
  in_flight: number
  max_concurrent: number
  rpm_configured: number
  rpm_current: number
  bucket_available: number
  cooldown_remaining_sec: number
  window_60s: { ok: number; '429': number; error: number }
  total_acquired: number
  total_rejected: number
}

interface IUtilization {
  concurrent_pct: number
  rpm_pct: number
  error_rate_pct: number
}

interface IClient {
  priority: number
  in_flight: number
  total: number
  idle_sec: number
}

interface IServiceMeta {
  display_name: string
  models: string[]
}

interface IDashboard {
  summary: {
    total_in_flight: number
    total_capacity: number
    services_cooling: string[]
    total_acquired: number
    total_rejected: number
  }
  services: Record<string, IServiceStats>
  utilization: Record<string, IUtilization>
  service_meta: Record<string, IServiceMeta>
  absorbers: Record<string, { queue_depth: number }>
  clients: Record<string, IClient>
  ts: string
}

const data = ref<IDashboard | null>(null)
const isLoading = ref(false)
let refreshTimer: ReturnType<typeof setInterval> | null = null

const serviceList = computed(() => {
  if (!data.value) return []
  return Object.entries(data.value.services).map(([name, s]) => ({
    ...s,
    name,
    meta: data.value!.service_meta?.[name],
    util: data.value!.utilization[name],
    absorber: data.value!.absorbers[name],
  }))
})

const clientList = computed(() => {
  if (!data.value) return []
  return Object.entries(data.value.clients).map(([id, c]) => ({ id, ...c }))
})

function barColor(pct: number): string {
  if (pct >= 90) return 'bg-red-500'
  if (pct >= 70) return 'bg-amber-500'
  return 'bg-emerald-500'
}

function formatModels(models: string[] | undefined): string {
  if (!models || models.length === 0) return ''
  const top = models.slice(0, 6)
  const suffix = models.length > 6 ? ` +${models.length - 6}` : ''
  return top.join(', ') + suffix
}

async function fetchData() {
  isLoading.value = true
  try {
    const res = await fetch(import.meta.env.BASE_URL + 'api/rate-limits')
    if (res.ok) data.value = await res.json()
  } catch { /* silent */ }
  finally { isLoading.value = false }
}

onMounted(() => {
  fetchData()
  refreshTimer = setInterval(fetchData, 10_000)
})

onUnmounted(() => {
  if (refreshTimer) clearInterval(refreshTimer)
})
</script>

<template>
  <div class="space-y-6 p-6">
    <PageHeader title="LLM 限速面板" description="PolarPrivate 网关负载均衡与限速实时状态">
      <template #actions>
        <span v-if="data?.ts" class="text-xs text-neutral-400">{{ data.ts }}</span>
        <button
          class="rounded-lg border border-neutral-300 px-3 py-1.5 text-sm font-medium transition-colors hover:bg-neutral-50"
          :disabled="isLoading"
          @click="fetchData"
        >
          {{ isLoading ? '...' : '刷新' }}
        </button>
      </template>
    </PageHeader>

    <!-- Summary cards -->
    <div v-if="data" class="grid grid-cols-2 gap-4 lg:grid-cols-4">
      <StatCard
        label="当前并发"
        :value="`${data.summary.total_in_flight} / ${data.summary.total_capacity}`"
        icon="M13 10V3L4 14h7v7l9-11h-7z"
        accent-bg="bg-blue-50"
        accent-text="text-blue-600"
      />
      <StatCard
        label="总请求"
        :value="data.summary.total_acquired"
        icon="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z"
        accent-bg="bg-emerald-50"
        accent-text="text-emerald-600"
      />
      <StatCard
        label="被拒绝"
        :value="data.summary.total_rejected"
        icon="M18.364 18.364A9 9 0 005.636 5.636m12.728 12.728A9 9 0 015.636 5.636m12.728 12.728L5.636 5.636"
        accent-bg="bg-red-50"
        accent-text="text-red-600"
      />
      <StatCard
        label="冷却中"
        :value="data.summary.services_cooling.length"
        icon="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z"
        accent-bg="bg-amber-50"
        accent-text="text-amber-600"
      />
    </div>

    <!-- Service detail table -->
    <div v-if="data" class="overflow-hidden rounded-xl border border-neutral-200 bg-white shadow-sm">
      <div class="border-b border-neutral-200 px-5 py-3">
        <h2 class="text-sm font-semibold text-neutral-700">API Key 额度（同一 Key 下所有模型共享并发/RPM）</h2>
      </div>
      <table class="w-full text-sm">
        <thead>
          <tr class="border-b border-neutral-100 bg-neutral-50 text-left text-xs font-medium uppercase tracking-wider text-neutral-500">
            <th class="px-5 py-2.5">Key / 供应商</th>
            <th class="px-3 py-2.5">并发</th>
            <th class="px-3 py-2.5">RPM</th>
            <th class="px-3 py-2.5 w-40">并发利用率</th>
            <th class="px-3 py-2.5 w-40">RPM 利用率</th>
            <th class="px-3 py-2.5">60s 窗口</th>
            <th class="px-3 py-2.5">冷却</th>
            <th class="px-3 py-2.5">队列</th>
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="svc in serviceList"
            :key="svc.name"
            class="border-b border-neutral-100 last:border-0"
          >
            <td class="px-5 py-3">
              <div class="font-medium text-sm text-neutral-800">
                {{ svc.meta?.display_name || svc.name }}
              </div>
              <div class="font-mono text-[10px] text-neutral-400 mt-0.5">
                {{ svc.name }}
              </div>
              <div v-if="svc.meta?.models?.length" class="mt-1 text-[10px] text-neutral-500 leading-tight">
                {{ formatModels(svc.meta.models) }}
              </div>
            </td>
            <td class="px-3 py-3 font-mono text-xs">
              {{ svc.in_flight }} / {{ svc.max_concurrent }}
            </td>
            <td class="px-3 py-3 font-mono text-xs">
              <span :class="svc.rpm_current < svc.rpm_configured ? 'text-amber-600' : ''">
                {{ svc.rpm_current }}
              </span>
              <span class="text-neutral-400"> / {{ svc.rpm_configured }}</span>
            </td>
            <td class="px-3 py-3">
              <div class="flex items-center gap-2">
                <div class="h-2 w-full rounded-full bg-neutral-100">
                  <div
                    class="h-2 rounded-full transition-all"
                    :class="barColor(svc.util?.concurrent_pct ?? 0)"
                    :style="{ width: Math.min(100, svc.util?.concurrent_pct ?? 0) + '%' }"
                  />
                </div>
                <span class="w-10 text-right font-mono text-[11px] text-neutral-500">
                  {{ svc.util?.concurrent_pct ?? 0 }}%
                </span>
              </div>
            </td>
            <td class="px-3 py-3">
              <div class="flex items-center gap-2">
                <div class="h-2 w-full rounded-full bg-neutral-100">
                  <div
                    class="h-2 rounded-full transition-all"
                    :class="barColor(svc.util?.rpm_pct ?? 0)"
                    :style="{ width: Math.min(100, svc.util?.rpm_pct ?? 0) + '%' }"
                  />
                </div>
                <span class="w-10 text-right font-mono text-[11px] text-neutral-500">
                  {{ svc.util?.rpm_pct ?? 0 }}%
                </span>
              </div>
            </td>
            <td class="px-3 py-3 font-mono text-[11px]">
              <span class="text-emerald-600">{{ svc.window_60s.ok }}</span> /
              <span class="text-amber-600">{{ svc.window_60s['429'] }}</span> /
              <span class="text-red-500">{{ svc.window_60s.error }}</span>
            </td>
            <td class="px-3 py-3 font-mono text-xs">
              <span v-if="svc.cooldown_remaining_sec > 0" class="text-red-500 font-medium">
                {{ svc.cooldown_remaining_sec }}s
              </span>
              <span v-else class="text-neutral-300">-</span>
            </td>
            <td class="px-3 py-3 font-mono text-xs">
              <span v-if="svc.absorber?.queue_depth" class="text-amber-600">
                {{ svc.absorber.queue_depth }}
              </span>
              <span v-else class="text-neutral-300">0</span>
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <!-- Clients table -->
    <div v-if="data && clientList.length > 0" class="overflow-hidden rounded-xl border border-neutral-200 bg-white shadow-sm">
      <div class="border-b border-neutral-200 px-5 py-3">
        <h2 class="text-sm font-semibold text-neutral-700">客户端分配</h2>
      </div>
      <table class="w-full text-sm">
        <thead>
          <tr class="border-b border-neutral-100 bg-neutral-50 text-left text-xs font-medium uppercase tracking-wider text-neutral-500">
            <th class="px-5 py-2.5">Client ID</th>
            <th class="px-3 py-2.5">优先级</th>
            <th class="px-3 py-2.5">当前并发</th>
            <th class="px-3 py-2.5">历史请求</th>
            <th class="px-3 py-2.5">空闲时间</th>
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="c in clientList"
            :key="c.id"
            class="border-b border-neutral-100 last:border-0"
          >
            <td class="px-5 py-2.5 font-mono text-xs font-medium text-neutral-800">{{ c.id }}</td>
            <td class="px-3 py-2.5 font-mono text-xs">
              <span
                class="inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-medium"
                :class="c.priority >= 8 ? 'bg-blue-50 text-blue-700' : c.priority >= 5 ? 'bg-neutral-100 text-neutral-700' : 'bg-neutral-50 text-neutral-400'"
              >
                P{{ c.priority }}
              </span>
            </td>
            <td class="px-3 py-2.5 font-mono text-xs">{{ c.in_flight }}</td>
            <td class="px-3 py-2.5 font-mono text-xs">{{ c.total }}</td>
            <td class="px-3 py-2.5 font-mono text-xs text-neutral-400">{{ c.idle_sec }}s</td>
          </tr>
        </tbody>
      </table>
    </div>

    <!-- Empty state -->
    <div v-if="!data && !isLoading" class="rounded-xl border border-neutral-200 bg-white p-10 text-center">
      <p class="text-neutral-500">无法连接 PolarPrivate 限速服务</p>
      <button
        class="mt-3 rounded-lg bg-neutral-900 px-4 py-2 text-sm font-medium text-white hover:bg-neutral-800"
        @click="fetchData"
      >
        重试
      </button>
    </div>
  </div>
</template>
