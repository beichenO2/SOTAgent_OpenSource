<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import PageHeader from '@/components/PageHeader.vue'

interface IPortRow {
  port: number
  service_name: string
  project: string
  device_id: string
  status: string
  allocated_at: string
  last_verified: string
}

const ports = ref<IPortRow[]>([])
const isLoading = ref(false)
const searchQuery = ref('')
const statusFilter = ref<'all' | 'active' | 'released' | 'stale'>('all')

async function fetchPorts() {
  isLoading.value = true
  try {
    const res = await fetch(import.meta.env.BASE_URL + 'api/ports?all=true')
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    ports.value = await res.json()
  } catch (e) {
    console.error('获取端口列表失败:', e)
  } finally {
    isLoading.value = false
  }
}

const filteredPorts = computed(() => {
  return ports.value.filter(row => {
    const matchesStatus = statusFilter.value === 'all' || row.status === statusFilter.value
    const q = searchQuery.value.toLowerCase()
    const matchesSearch = !q ||
      String(row.port).includes(q) ||
      row.service_name?.toLowerCase().includes(q) ||
      row.project?.toLowerCase().includes(q) ||
      row.device_id?.toLowerCase().includes(q)
    return matchesStatus && matchesSearch
  })
})

const statusCounts = computed(() => {
  const counts: Record<string, number> = { active: 0, released: 0, stale: 0 }
  for (const row of ports.value) {
    if (row.status in counts) counts[row.status]++
  }
  return counts
})

function statusBadgeClass(status: string) {
  switch (status) {
    case 'active':   return 'bg-emerald-100 text-emerald-700 border border-emerald-200'
    case 'released': return 'bg-neutral-100 text-neutral-500 border border-neutral-200'
    case 'stale':    return 'bg-amber-100 text-amber-700 border border-amber-200'
    default:         return 'bg-neutral-100 text-neutral-500 border border-neutral-200'
  }
}

function statusLabel(status: string) {
  switch (status) {
    case 'active':   return '活跃'
    case 'released': return '已释放'
    case 'stale':    return '过期'
    default:         return status
  }
}

function formatTime(ts: string) {
  if (!ts) return '—'
  try {
    return new Date(ts).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
  } catch {
    return ts
  }
}

onMounted(fetchPorts)
</script>

<template>
  <div>
    <PageHeader title="端口注册表" description="所有 Polarisor 项目的 Web 服务端口分配（含历史记录）">
      <template #actions>
        <button
          class="rounded-lg border border-neutral-200 bg-white px-4 py-2 text-sm font-medium text-neutral-700 transition-colors hover:bg-neutral-50"
          :disabled="isLoading"
          @click="fetchPorts()"
        >
          {{ isLoading ? '刷新中...' : '刷新' }}
        </button>
      </template>
    </PageHeader>

    <!-- 统计 + 筛选栏 -->
    <div class="mt-6 flex flex-wrap items-center gap-3">
      <!-- 状态 tabs -->
      <div class="flex rounded-lg border border-neutral-200 bg-white p-0.5 text-sm">
        <button
          v-for="tab in [
            { key: 'all',      label: `全部 (${ports.length})` },
            { key: 'active',   label: `活跃 (${statusCounts.active})` },
            { key: 'released', label: `已释放 (${statusCounts.released})` },
            { key: 'stale',    label: `过期 (${statusCounts.stale})` },
          ]"
          :key="tab.key"
          class="rounded-md px-3 py-1.5 font-medium transition-colors"
          :class="statusFilter === tab.key
            ? 'bg-neutral-900 text-white'
            : 'text-neutral-500 hover:text-neutral-800'"
          @click="statusFilter = tab.key as any"
        >
          {{ tab.label }}
        </button>
      </div>

      <!-- 搜索框 -->
      <input
        v-model="searchQuery"
        type="text"
        placeholder="搜索端口、服务名、项目..."
        class="ml-auto w-56 rounded-lg border border-neutral-200 bg-white px-3 py-1.5 text-sm outline-none focus:border-neutral-400 focus:ring-2 focus:ring-neutral-100"
      />
    </div>

    <!-- 表格 -->
    <div class="mt-3 overflow-x-auto rounded-lg border border-neutral-200">
      <table class="w-full text-left text-sm">
        <thead class="border-b border-neutral-200 bg-neutral-50">
          <tr>
            <th class="px-4 py-2.5 text-xs font-semibold uppercase tracking-wider text-neutral-500">端口</th>
            <th class="px-4 py-2.5 text-xs font-semibold uppercase tracking-wider text-neutral-500">服务</th>
            <th class="px-4 py-2.5 text-xs font-semibold uppercase tracking-wider text-neutral-500">项目</th>
            <th class="px-4 py-2.5 text-xs font-semibold uppercase tracking-wider text-neutral-500">设备</th>
            <th class="px-4 py-2.5 text-xs font-semibold uppercase tracking-wider text-neutral-500">状态</th>
            <th class="px-4 py-2.5 text-xs font-semibold uppercase tracking-wider text-neutral-500">分配时间</th>
            <th class="px-4 py-2.5 text-xs font-semibold uppercase tracking-wider text-neutral-500">最近验证</th>
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="row in filteredPorts"
            :key="row.port"
            class="border-b border-neutral-100 transition-colors hover:bg-neutral-50 last:border-0"
            :class="row.status !== 'active' ? 'opacity-60' : ''"
          >
            <td class="px-4 py-3 font-mono font-semibold text-neutral-900">:{{ row.port }}</td>
            <td class="px-4 py-3 font-medium text-neutral-800">{{ row.service_name || '—' }}</td>
            <td class="px-4 py-3">
              <span class="rounded-full bg-neutral-100 px-2 py-0.5 text-xs font-medium text-neutral-700">
                {{ row.project || '—' }}
              </span>
            </td>
            <td class="px-4 py-3 text-neutral-600">{{ row.device_id || '—' }}</td>
            <td class="px-4 py-3">
              <span
                class="rounded-full px-2 py-0.5 text-xs font-medium"
                :class="statusBadgeClass(row.status)"
              >
                {{ statusLabel(row.status) }}
              </span>
            </td>
            <td class="px-4 py-3 text-xs text-neutral-400">{{ formatTime(row.allocated_at) }}</td>
            <td class="px-4 py-3 text-xs text-neutral-400">{{ formatTime(row.last_verified) }}</td>
          </tr>
          <tr v-if="filteredPorts.length === 0">
            <td colspan="7" class="px-4 py-8 text-center text-neutral-400">
              {{ isLoading ? '加载中...' : '暂无端口记录' }}
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <p class="mt-2 text-xs text-neutral-400">
      共 {{ ports.length }} 条记录，显示 {{ filteredPorts.length }} 条
    </p>
  </div>
</template>
