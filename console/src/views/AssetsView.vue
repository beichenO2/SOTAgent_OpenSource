<script setup lang="ts">
import { onMounted, onUnmounted, ref } from 'vue'
import { useAssetsStore } from '@/stores/assets'
import PageHeader from '@/components/PageHeader.vue'
import StatCard from '@/components/StatCard.vue'

const store = useAssetsStore()
let timer: ReturnType<typeof setInterval> | null = null

onMounted(() => {
  store.fetchAll()
  timer = setInterval(() => store.fetchAll(), 15_000)
})

onUnmounted(() => {
  if (timer) clearInterval(timer)
})

const icons = {
  assets: 'M19.428 15.428a2 2 0 00-1.022-.547l-2.387-.477a6 6 0 00-3.86.517l-.318.158a6 6 0 01-3.86.517L6.05 15.21a2 2 0 00-1.806.547M8 4h8l-1 1v5.172a2 2 0 00.586 1.414l5 5c1.26 1.26.367 3.414-1.415 3.414H4.828c-1.782 0-2.674-2.154-1.414-3.414l5-5A2 2 0 009 10.172V5L8 4z',
  sync: 'M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15',
  subs: 'M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0zm6 3a2 2 0 11-4 0 2 2 0 014 0zM7 10a2 2 0 11-4 0 2 2 0 014 0z',
  projects: 'M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z',
}

const typeLabel: Record<string, string> = {
  config: '配置',
  pattern: '模式',
  methodology: '方法论',
  architecture: '架构',
  framework: '框架',
  workflow: '工作流',
  skill: '技能',
}

const typeColor: Record<string, string> = {
  config: 'bg-blue-100 text-blue-700',
  pattern: 'bg-purple-100 text-purple-700',
  methodology: 'bg-emerald-100 text-emerald-700',
  architecture: 'bg-amber-100 text-amber-700',
  framework: 'bg-rose-100 text-rose-700',
  workflow: 'bg-cyan-100 text-cyan-700',
  skill: 'bg-indigo-100 text-indigo-700',
}

function assetSource(id: string): 'copilot' | 'claw' | null {
  if (id.startsWith('claw-skill:')) return 'claw'
  if (id.startsWith('skill:')) return 'copilot'
  return null
}

const actionColor: Record<string, string> = {
  auto_synced: 'bg-emerald-100 text-emerald-700',
  suggested: 'bg-blue-100 text-blue-700',
  pending: 'bg-amber-100 text-amber-700',
  rejected: 'bg-red-100 text-red-700',
}

const syncLevelColor: Record<string, string> = {
  auto: 'bg-emerald-100 text-emerald-700',
  suggest: 'bg-blue-100 text-blue-700',
}

const showSyncDetail = ref<number | null>(null)

function formatTime(iso: string) {
  return new Date(iso).toLocaleString('zh-CN', {
    month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  })
}

function shortPath(p: string) {
  const idx = p.indexOf('/Polarisor/')
  return idx >= 0 ? p.substring(idx + 11) : p
}

function formatNum(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1).replace(/\.0$/, '') + 'M'
  if (n >= 10_000) return (n / 1_000).toFixed(1).replace(/\.0$/, '') + 'k'
  if (n >= 1_000) return (n / 1_000).toFixed(1).replace(/\.0$/, '') + 'k'
  return String(n)
}
</script>

<template>
  <div>
    <PageHeader title="技术资产" description="SOTA 技术资产注册表、同步日志与订阅关系" />

    <!-- 概览卡片 -->
    <section class="mt-8 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
      <StatCard
        label="注册资产"
        :value="formatNum(store.stats.total)"
        :icon="icons.assets"
        accent-bg="bg-blue-50"
        accent-text="text-blue-600"
      />
      <StatCard
        label="同步记录"
        :value="formatNum(store.stats.totalSyncs)"
        :icon="icons.sync"
        accent-bg="bg-emerald-50"
        accent-text="text-emerald-600"
      />
      <StatCard
        label="活跃订阅"
        :value="formatNum(store.stats.totalSubscriptions)"
        :icon="icons.subs"
        accent-bg="bg-purple-50"
        accent-text="text-purple-600"
      />
      <StatCard
        label="关联项目"
        :value="formatNum(store.stats.uniqueProjects)"
        :icon="icons.projects"
        accent-bg="bg-amber-50"
        accent-text="text-amber-600"
      />
    </section>

    <!-- 类型筛选 + 资产表格 -->
    <section class="mt-8">
      <div class="flex items-center justify-between">
        <h2 class="text-sm font-medium uppercase tracking-wide text-neutral-500">资产注册表</h2>
        <div class="flex gap-1">
          <button
            class="rounded-lg px-3 py-1.5 text-xs font-medium transition-colors"
            :class="!store.selectedType ? 'bg-neutral-900 text-white' : 'bg-neutral-100 text-neutral-600 hover:bg-neutral-200'"
            @click="store.selectedType = null"
          >
            全部 <span class="ml-1 opacity-60">{{ store.stats.total }}</span>
          </button>
          <button
            v-for="t in store.stats.byType"
            :key="t.type"
            class="rounded-lg px-3 py-1.5 text-xs font-medium transition-colors"
            :class="store.selectedType === t.type ? 'bg-neutral-900 text-white' : 'bg-neutral-100 text-neutral-600 hover:bg-neutral-200'"
            @click="store.selectedType = t.type"
          >
            {{ typeLabel[t.type] || t.type }} <span class="ml-1 opacity-60">{{ t.count }}</span>
          </button>
        </div>
      </div>

      <div class="mt-3 overflow-hidden rounded-xl border border-neutral-200 bg-white shadow-sm">
        <table class="w-full text-left text-sm">
          <thead class="border-b border-neutral-100 bg-neutral-50 text-xs uppercase text-neutral-500">
            <tr>
              <th class="px-4 py-3">ID</th>
              <th class="px-4 py-3">类型</th>
              <th class="px-4 py-3">规范路径</th>
              <th class="px-4 py-3">版本</th>
              <th class="px-4 py-3">最近更新者</th>
              <th class="px-4 py-3">订阅数</th>
              <th class="px-4 py-3">更新时间</th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="a in store.filteredAssets"
              :key="a.id"
              class="cursor-pointer border-b border-neutral-50 transition-colors last:border-0 hover:bg-neutral-50"
              :class="store.selectedAssetId === a.id ? 'bg-blue-50/50' : ''"
              @click="store.selectedAssetId = store.selectedAssetId === a.id ? null : a.id"
            >
              <td class="px-4 py-3 font-mono text-xs font-medium text-neutral-900">
                {{ a.id }}
                <span
                  v-if="assetSource(a.id) === 'claw'"
                  class="ml-1.5 rounded-full bg-orange-100 px-1.5 py-0.5 text-[10px] font-medium text-orange-700"
                >Claw</span>
                <span
                  v-else-if="assetSource(a.id) === 'copilot'"
                  class="ml-1.5 rounded-full bg-sky-100 px-1.5 py-0.5 text-[10px] font-medium text-sky-700"
                >Copilot</span>
              </td>
              <td class="px-4 py-3">
                <span class="rounded-full px-2 py-0.5 text-xs font-medium" :class="typeColor[a.type] ?? 'bg-neutral-100 text-neutral-600'">
                  {{ typeLabel[a.type] || a.type }}
                </span>
              </td>
              <td class="max-w-xs truncate px-4 py-3 text-xs text-neutral-500" :title="a.canonical_path">
                {{ shortPath(a.canonical_path) }}
              </td>
              <td class="px-4 py-3 font-mono text-xs">v{{ a.version }}</td>
              <td class="px-4 py-3 text-xs text-neutral-600">{{ a.updated_by ?? '-' }}</td>
              <td class="px-4 py-3 font-mono text-xs">{{ store.assetSubscribers.get(a.id)?.length ?? 0 }}</td>
              <td class="px-4 py-3 text-xs text-neutral-500">{{ formatTime(a.updated_at) }}</td>
            </tr>
            <tr v-if="store.filteredAssets.length === 0">
              <td colspan="7" class="px-4 py-8 text-center text-neutral-400">暂无资产数据</td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>

    <!-- 选中资产的订阅详情 -->
    <section v-if="store.selectedAssetId" class="mt-6">
      <h2 class="text-sm font-medium uppercase tracking-wide text-neutral-500">
        {{ store.selectedAssetId }} 的订阅者
      </h2>
      <div class="mt-3 overflow-hidden rounded-xl border border-neutral-200 bg-white shadow-sm">
        <table class="w-full text-left text-sm">
          <thead class="border-b border-neutral-100 bg-neutral-50 text-xs uppercase text-neutral-500">
            <tr>
              <th class="px-4 py-3">项目</th>
              <th class="px-4 py-3">同步级别</th>
              <th class="px-4 py-3">项目路径</th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="sub in store.assetSubscribers.get(store.selectedAssetId) ?? []"
              :key="sub.project_id"
              class="border-b border-neutral-50 last:border-0"
            >
              <td class="px-4 py-3 font-medium text-neutral-900">{{ sub.project_id }}</td>
              <td class="px-4 py-3">
                <span class="rounded-full px-2 py-0.5 text-xs font-medium" :class="syncLevelColor[sub.sync_level] ?? 'bg-neutral-100'">
                  {{ sub.sync_level }}
                </span>
              </td>
              <td class="px-4 py-3 text-xs text-neutral-500">{{ shortPath(sub.project_path) }}</td>
            </tr>
            <tr v-if="!(store.assetSubscribers.get(store.selectedAssetId)?.length)">
              <td colspan="3" class="px-4 py-6 text-center text-neutral-400">暂无订阅者</td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>

    <!-- 同步日志 -->
    <section class="mt-8">
      <div class="flex items-center justify-between">
        <h2 class="text-sm font-medium uppercase tracking-wide text-neutral-500">
          同步日志
          <span v-if="store.selectedAssetId" class="ml-2 text-xs font-normal normal-case text-neutral-400">
            (筛选: {{ store.selectedAssetId }})
          </span>
        </h2>
        <button
          v-if="store.selectedAssetId"
          class="text-xs text-blue-600 hover:text-blue-800"
          @click="store.selectedAssetId = null"
        >
          清除筛选
        </button>
      </div>

      <div class="mt-3 overflow-hidden rounded-xl border border-neutral-200 bg-white shadow-sm">
        <table class="w-full text-left text-sm">
          <thead class="border-b border-neutral-100 bg-neutral-50 text-xs uppercase text-neutral-500">
            <tr>
              <th class="px-4 py-3">#</th>
              <th class="px-4 py-3">资产</th>
              <th class="px-4 py-3">来源</th>
              <th class="px-4 py-3">目标</th>
              <th class="px-4 py-3">动作</th>
              <th class="px-4 py-3">时间</th>
              <th class="px-4 py-3 w-8"></th>
            </tr>
          </thead>
          <tbody>
            <template v-for="entry in store.filteredSyncLog" :key="entry.id">
              <tr
                class="cursor-pointer border-b border-neutral-50 transition-colors last:border-0 hover:bg-neutral-50"
                @click="showSyncDetail = showSyncDetail === entry.id ? null : entry.id"
              >
                <td class="px-4 py-3 font-mono text-xs text-neutral-400">{{ entry.id }}</td>
                <td class="px-4 py-3 font-mono text-xs font-medium text-neutral-900">{{ entry.asset_id }}</td>
                <td class="px-4 py-3 text-xs text-neutral-600">{{ entry.from_project }}</td>
                <td class="px-4 py-3 text-xs text-neutral-600">{{ entry.to_project }}</td>
                <td class="px-4 py-3">
                  <span class="rounded-full px-2 py-0.5 text-xs font-medium" :class="actionColor[entry.action] ?? 'bg-neutral-100 text-neutral-600'">
                    {{ entry.action }}
                  </span>
                </td>
                <td class="px-4 py-3 text-xs text-neutral-500">{{ formatTime(entry.timestamp) }}</td>
                <td class="px-4 py-3 text-neutral-400">
                  <svg
                    v-if="entry.diff_summary"
                    class="h-4 w-4 transition-transform"
                    :class="showSyncDetail === entry.id ? 'rotate-90' : ''"
                    fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"
                  >
                    <path stroke-linecap="round" stroke-linejoin="round" d="M9 5l7 7-7 7" />
                  </svg>
                </td>
              </tr>
              <tr v-if="showSyncDetail === entry.id && entry.diff_summary">
                <td colspan="7" class="bg-neutral-50 px-6 py-4">
                  <pre class="whitespace-pre-wrap text-xs text-neutral-700">{{ entry.diff_summary }}</pre>
                </td>
              </tr>
            </template>
            <tr v-if="store.filteredSyncLog.length === 0">
              <td colspan="7" class="px-4 py-8 text-center text-neutral-400">暂无同步记录</td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>
  </div>
</template>
