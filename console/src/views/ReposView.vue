<script setup lang="ts">
import { onMounted, ref, computed } from 'vue'
import { useSyncStore } from '@/stores/sync'
import PageHeader from '@/components/PageHeader.vue'

const store = useSyncStore()
const filter = ref<'all' | 'synced' | 'behind' | 'no_remote'>('all')
const isPulling = ref<string | null>(null)

onMounted(() => {
  if (store.repos.length === 0) store.fetchStatus()
})

const filteredRepos = computed(() => {
  if (filter.value === 'all') return store.repos
  return store.repos.filter(r => r.syncStatus === filter.value)
})

function statusLabel(status: string) {
  const map: Record<string, string> = {
    synced: '已同步',
    behind: '落后',
    ahead: '超前',
    diverged: '分歧',
    no_remote: '无远程',
  }
  return map[status] || status
}

function statusClass(status: string) {
  const map: Record<string, string> = {
    synced: 'bg-emerald-100 text-emerald-800',
    behind: 'bg-amber-100 text-amber-800',
    ahead: 'bg-blue-100 text-blue-800',
    diverged: 'bg-purple-100 text-purple-800',
    no_remote: 'bg-red-100 text-red-800',
  }
  return map[status] || 'bg-neutral-100 text-neutral-800'
}

async function handlePull(name: string) {
  isPulling.value = name
  try {
    await store.pullRepo(name)
  } finally {
    isPulling.value = null
  }
}

async function handlePullAll() {
  isPulling.value = '__all__'
  try {
    await store.pullAll()
  } finally {
    isPulling.value = null
  }
}
</script>

<template>
  <div>
    <div class="flex items-center justify-between">
      <PageHeader title="Git 仓库" description="管理 Polarisor 所有项目的 Git 同步状态" />
      <button
        type="button"
        class="rounded-md bg-neutral-900 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-neutral-700 disabled:opacity-50"
        :disabled="isPulling !== null"
        @click="handlePullAll"
      >
        {{ isPulling === '__all__' ? '拉取中...' : '全部拉取' }}
      </button>
    </div>

    <!-- 过滤器 -->
    <div class="mt-6 flex gap-2">
      <button
        v-for="f in (['all', 'synced', 'behind', 'no_remote'] as const)"
        :key="f"
        type="button"
        class="rounded-full px-3 py-1 text-xs font-medium transition-colors"
        :class="filter === f
          ? 'bg-neutral-900 text-white'
          : 'bg-neutral-100 text-neutral-600 hover:bg-neutral-200'"
        @click="filter = f"
      >
        {{ f === 'all' ? '全部' : f === 'synced' ? '已同步' : f === 'behind' ? '落后' : '无远程' }}
      </button>
    </div>

    <!-- 仓库列表 -->
    <div class="mt-4 overflow-x-auto rounded-lg border border-neutral-200">
      <table class="w-full text-left text-sm">
        <thead class="border-b border-neutral-200 bg-neutral-50">
          <tr>
            <th class="px-4 py-2.5 text-xs font-semibold uppercase tracking-wider text-neutral-500">项目</th>
            <th class="px-4 py-2.5 text-xs font-semibold uppercase tracking-wider text-neutral-500">分支</th>
            <th class="px-4 py-2.5 text-xs font-semibold uppercase tracking-wider text-neutral-500">状态</th>
            <th class="px-4 py-2.5 text-xs font-semibold uppercase tracking-wider text-neutral-500">未提交</th>
            <th class="px-4 py-2.5 text-xs font-semibold uppercase tracking-wider text-neutral-500">远程</th>
            <th class="px-4 py-2.5 text-xs font-semibold uppercase tracking-wider text-neutral-500">操作</th>
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="repo in filteredRepos"
            :key="repo.name"
            class="border-b border-neutral-100 transition-colors hover:bg-neutral-50 last:border-0"
          >
            <td class="px-4 py-3 font-mono font-medium text-neutral-900">{{ repo.name }}</td>
            <td class="px-4 py-3 font-mono text-neutral-600">{{ repo.branch }}</td>
            <td class="px-4 py-3">
              <span
                class="inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium"
                :class="statusClass(repo.syncStatus)"
              >
                {{ statusLabel(repo.syncStatus) }}
                <template v-if="repo.behind > 0"> -{{ repo.behind }}</template>
                <template v-if="repo.ahead > 0"> +{{ repo.ahead }}</template>
              </span>
            </td>
            <td class="px-4 py-3">
              <span v-if="repo.dirty > 0" class="font-mono text-amber-600">{{ repo.dirty }}</span>
              <span v-else class="text-neutral-400">0</span>
            </td>
            <td class="max-w-[200px] truncate px-4 py-3 text-xs text-neutral-500">{{ repo.remote || '—' }}</td>
            <td class="px-4 py-3">
              <button
                v-if="repo.syncStatus === 'behind' && repo.dirty === 0"
                type="button"
                class="rounded-md bg-emerald-50 px-2.5 py-1 text-xs font-medium text-emerald-700 transition-colors hover:bg-emerald-100 disabled:opacity-50"
                :disabled="isPulling !== null"
                @click="handlePull(repo.name)"
              >
                {{ isPulling === repo.name ? '...' : 'Pull' }}
              </button>
              <span v-else class="text-xs text-neutral-400">—</span>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>
</template>
