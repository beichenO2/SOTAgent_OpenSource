<script setup lang="ts">
import { onMounted, ref, computed } from 'vue'
import PageHeader from '@/components/PageHeader.vue'
import StatCard from '@/components/StatCard.vue'

interface ICostBucket {
  period: string
  tokens: number
  cost: number
  calls: number
}

interface ICostGroup {
  name: string
  tokens: number
  cost: number
  calls: number
}

interface ICostData {
  total: { tokens: number; cost_usd: number; calls: number }
  daily: ICostBucket[]
  weekly: ICostBucket[]
  monthly: ICostBucket[]
  by_model: ICostGroup[]
  by_task: ICostGroup[]
  by_user: ICostGroup[]
}

const data = ref<ICostData | null>(null)
const isLoading = ref(false)
const timeRange = ref<'daily' | 'weekly' | 'monthly'>('daily')
const groupView = ref<'model' | 'task' | 'user'>('model')

const timeBuckets = computed(() => {
  if (!data.value) return []
  return data.value[timeRange.value] ?? []
})

const groupBuckets = computed(() => {
  if (!data.value) return []
  return data.value[`by_${groupView.value}` as keyof ICostData] as ICostGroup[] ?? []
})

const maxTokens = computed(() => Math.min(Math.max(...timeBuckets.value.map(b => b.tokens), 1), 1_000_000_000))

function formatTokens(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M'
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'K'
  return String(n)
}

function formatCost(n: number): string {
  return '$' + n.toFixed(4)
}

async function fetchData() {
  isLoading.value = true
  try {
    const res = await fetch(import.meta.env.BASE_URL + 'api/costs')
    if (res.ok) data.value = await res.json()
  } catch (e) {
    console.error('获取成本数据失败:', e)
  } finally {
    isLoading.value = false
  }
}

onMounted(fetchData)
</script>

<template>
  <div>
    <PageHeader
      title="成本透明"
      :description="data ? `${data.total.calls} 次调用 · ${formatTokens(data.total.tokens)} tokens · ${formatCost(data.total.cost_usd)}` : '加载中...'"
    >
      <template #actions>
        <button
          class="rounded-lg border border-neutral-200 bg-white px-4 py-2 text-sm font-medium text-neutral-700 transition-colors hover:bg-neutral-50"
          :disabled="isLoading"
          @click="fetchData()"
        >{{ isLoading ? '刷新中...' : '刷新' }}</button>
      </template>
    </PageHeader>

    <!-- Stat Cards -->
    <div v-if="data" class="mt-6 grid grid-cols-1 gap-4 sm:grid-cols-3">
      <StatCard
        label="总调用次数"
        :value="data.total.calls"
        icon="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2"
        accent-bg="bg-indigo-100"
        accent-text="text-indigo-600"
      />
      <StatCard
        label="总 Token 消耗"
        :value="formatTokens(data.total.tokens)"
        icon="M13 10V3L4 14h7v7l9-11h-7z"
        accent-bg="bg-amber-100"
        accent-text="text-amber-600"
      />
      <StatCard
        label="总费用估算"
        :value="formatCost(data.total.cost_usd)"
        icon="M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
        accent-bg="bg-emerald-100"
        accent-text="text-emerald-600"
      />
    </div>

    <!-- Empty State -->
    <div v-if="data && data.total.calls === 0" class="mt-8 rounded-xl border border-neutral-200 bg-white p-12 text-center">
      <svg class="mx-auto h-12 w-12 text-neutral-300" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4" />
      </svg>
      <p class="mt-3 text-sm font-medium text-neutral-500">暂无 LLM 使用数据</p>
      <p class="mt-1 text-xs text-neutral-400">PolarClaw 产生 LLM 调用后，数据将自动显示在此处</p>
    </div>

    <!-- Timeline Chart -->
    <section v-if="data && data.total.calls > 0" class="mt-6">
      <div class="rounded-xl border border-neutral-200 bg-white p-5 shadow-sm">
        <div class="flex items-center justify-between">
          <h3 class="text-sm font-semibold text-neutral-700">消耗趋势</h3>
          <div class="flex gap-1 rounded-lg border border-neutral-200 bg-neutral-50 p-0.5">
            <button
              v-for="opt in (['daily', 'weekly', 'monthly'] as const)"
              :key="opt"
              class="rounded-md px-3 py-1 text-xs font-medium transition-colors"
              :class="timeRange === opt ? 'bg-white text-neutral-900 shadow-sm' : 'text-neutral-500 hover:text-neutral-700'"
              @click="timeRange = opt"
            >{{ opt === 'daily' ? '日' : opt === 'weekly' ? '周' : '月' }}</button>
          </div>
        </div>

        <div class="mt-4 flex items-end gap-1" style="height: 200px">
          <div
            v-for="bucket in timeBuckets"
            :key="bucket.period"
            class="group relative flex flex-1 flex-col items-center justify-end"
          >
            <div
              class="w-full min-w-[4px] rounded-t bg-indigo-500 transition-all hover:bg-indigo-600"
              :style="{ height: Math.max(4, (bucket.tokens / maxTokens) * 180) + 'px' }"
            />
            <span class="mt-1 text-[9px] text-neutral-400 truncate max-w-full">{{ bucket.period.slice(-5) }}</span>
            <div class="pointer-events-none absolute -top-16 z-10 hidden rounded-lg bg-neutral-800 px-2.5 py-1.5 text-[10px] text-white shadow-lg group-hover:block">
              <div>{{ formatTokens(bucket.tokens) }} tokens</div>
              <div>{{ formatCost(bucket.cost) }}</div>
              <div>{{ bucket.calls }} 次调用</div>
            </div>
          </div>
        </div>
      </div>
    </section>

    <!-- Group Breakdown -->
    <section v-if="data && data.total.calls > 0" class="mt-6">
      <div class="rounded-xl border border-neutral-200 bg-white p-5 shadow-sm">
        <div class="flex items-center justify-between">
          <h3 class="text-sm font-semibold text-neutral-700">分类统计</h3>
          <div class="flex gap-1 rounded-lg border border-neutral-200 bg-neutral-50 p-0.5">
            <button
              v-for="opt in (['model', 'task', 'user'] as const)"
              :key="opt"
              class="rounded-md px-3 py-1 text-xs font-medium transition-colors"
              :class="groupView === opt ? 'bg-white text-neutral-900 shadow-sm' : 'text-neutral-500 hover:text-neutral-700'"
              @click="groupView = opt"
            >{{ opt === 'model' ? '模型' : opt === 'task' ? '任务' : '用户' }}</button>
          </div>
        </div>

        <div class="mt-4 space-y-2">
          <div
            v-for="g in groupBuckets"
            :key="g.name"
            class="flex items-center gap-3 rounded-lg bg-neutral-50 px-4 py-3 text-sm"
          >
            <span class="min-w-0 flex-1 truncate font-medium text-neutral-700">{{ g.name }}</span>
            <span class="shrink-0 font-mono text-xs text-neutral-500">{{ formatTokens(g.tokens) }}</span>
            <span class="shrink-0 font-mono text-xs text-emerald-600">{{ formatCost(g.cost) }}</span>
            <span class="shrink-0 text-xs text-neutral-400">{{ g.calls }} 次</span>
          </div>
          <div v-if="groupBuckets.length === 0" class="py-4 text-center text-xs text-neutral-400">暂无分类数据</div>
        </div>
      </div>
    </section>

    <!-- Loading -->
    <div v-if="isLoading && !data" class="mt-8 text-center text-sm text-neutral-400">加载中...</div>
  </div>
</template>
