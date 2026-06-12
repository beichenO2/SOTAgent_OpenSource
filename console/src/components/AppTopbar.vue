<script setup lang="ts">
import { useSyncStore } from '@/stores/sync'

const store = useSyncStore()
</script>

<template>
  <header class="flex h-14 shrink-0 items-center justify-between border-b border-neutral-200 bg-white px-6">
    <div class="text-sm text-neutral-500">
      Polarisor 跨项目同步中心
    </div>
    <div class="flex items-center gap-3">
      <span v-if="store.lastScanned" class="text-xs text-neutral-400">
        上次扫描: {{ new Date(store.lastScanned).toLocaleString('zh-CN') }}
      </span>
      <button
        type="button"
        class="rounded-md bg-neutral-900 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-neutral-700 disabled:opacity-50"
        :disabled="store.isLoading"
        @click="store.fetchStatus()"
      >
        {{ store.isLoading ? '扫描中...' : '刷新扫描' }}
      </button>
    </div>
  </header>
</template>
