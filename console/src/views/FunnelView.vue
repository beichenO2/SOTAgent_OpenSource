<script setup lang="ts">
import { onMounted, onUnmounted, ref } from 'vue'
import { useFunnelStore } from '@/stores/funnel'
import PageHeader from '@/components/PageHeader.vue'
import StatCard from '@/components/StatCard.vue'

const store = useFunnelStore()
const showAddModal = ref(false)
const showConfirmReset = ref(false)
const healthMap = ref<Record<string, 'ok' | 'down' | 'checking'>>({})
let pollTimer: ReturnType<typeof setInterval> | null = null

const BASE = import.meta.env.BASE_URL

async function checkAllHealth() {
  const proxies: string[] = []
  for (const domain of store.status.domains) {
    for (const handler of domain.handlers) {
      if (handler.proxy.startsWith('http')) {
        const target = handler.proxy.replace(/^https?:\/\//, '').replace(/\/$/, '')
        healthMap.value[target] = 'checking'
        proxies.push(handler.proxy)
      }
    }
  }
  if (proxies.length === 0) return
  try {
    const res = await fetch(BASE + 'api/funnel/health-check', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ proxies }),
    })
    if (res.ok) {
      const data = await res.json() as { ok: boolean; results: Record<string, 'ok' | 'down'> }
      if (data.ok && data.results) {
        for (const [target, status] of Object.entries(data.results)) {
          healthMap.value[target] = status
        }
      }
    }
  } catch {
    for (const proxy of proxies) {
      const target = proxy.replace(/^https?:\/\//, '').replace(/\/$/, '')
      healthMap.value[target] = 'down'
    }
  }
}

onMounted(async () => {
  await store.fetchStatus()
  checkAllHealth()
  pollTimer = setInterval(async () => {
    await store.fetchStatus()
    checkAllHealth()
  }, 8000)
})

onUnmounted(() => {
  if (pollTimer) clearInterval(pollTimer)
})

// ─── 新增路由表单 ──────────────────────────────────

interface INewRoute {
  mountPath: string
  target: string
  asFunnel: boolean
}

const newRoute = ref<INewRoute>({
  mountPath: '',
  target: '',
  asFunnel: true,
})

async function handleAdd() {
  if (!newRoute.value.mountPath || !newRoute.value.target) return
  try {
    await store.addRoute(newRoute.value.mountPath, newRoute.value.target, newRoute.value.asFunnel)
    showAddModal.value = false
    newRoute.value = { mountPath: '', target: '', asFunnel: true }
  } catch { /* store 已设置 error */ }
}

async function handleRemove(mountPath: string) {
  try {
    await store.removeRoute(mountPath)
  } catch { /* store 已设置 error */ }
}

async function handleResetAll() {
  try {
    await store.resetAll()
    showConfirmReset.value = false
  } catch { /* store 已设置 error */ }
}
</script>

<template>
  <div>
    <PageHeader
      title="Funnel 管理"
      description="管理 Tailscale Serve/Funnel 路由，将本机服务暴露到 Tailnet 或公网"
    >
      <template #actions>
        <button
          class="rounded-lg bg-neutral-900 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-neutral-800"
          @click="showAddModal = true"
        >
          添加路由
        </button>
        <button
          class="rounded-lg border border-neutral-200 bg-white px-4 py-2 text-sm font-medium text-neutral-700 transition-colors hover:bg-neutral-50"
          :disabled="store.isLoading"
          @click="store.fetchStatus()"
        >
          {{ store.isLoading ? '刷新中...' : '刷新' }}
        </button>
      </template>
    </PageHeader>

    <!-- 统计卡片 -->
    <div class="mt-6 grid grid-cols-1 gap-4 sm:grid-cols-3">
      <StatCard
        label="路由总数"
        :value="store.totalRoutes"
        icon="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1"
        accent-bg="bg-neutral-100"
        accent-text="text-neutral-700"
      />
      <StatCard
        label="Funnel（公网）"
        :value="store.funnelDomains.length"
        icon="M3.055 11H5a2 2 0 012 2v1a2 2 0 002 2 2 2 0 012 2v2.945M8 3.935V5.5A2.5 2.5 0 0010.5 8h.5a2 2 0 012 2 2 2 0 104 0 2 2 0 012-2h1.064M15 20.488V18a2 2 0 012-2h3.064M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
        accent-bg="bg-indigo-50"
        accent-text="text-indigo-600"
      />
      <StatCard
        label="Serve（仅 Tailnet）"
        :value="store.serveDomains.length"
        icon="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z"
        accent-bg="bg-emerald-50"
        accent-text="text-emerald-600"
      />
    </div>

    <!-- 错误提示 -->
    <div
      v-if="store.error"
      class="mt-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700"
    >
      {{ store.error }}
      <button class="ml-2 font-medium underline" @click="store.error = null">关闭</button>
    </div>

    <!-- 空状态 -->
    <div
      v-if="!store.isLoading && store.status.domains.length === 0"
      class="mt-12 flex flex-col items-center py-12 text-center"
    >
      <svg class="h-12 w-12 text-neutral-300" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
        <path d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1" />
      </svg>
      <p class="mt-3 text-sm text-neutral-500">
        暂无 Funnel/Serve 路由
      </p>
      <button
        class="mt-4 rounded-lg bg-neutral-900 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-neutral-800"
        @click="showAddModal = true"
      >
        添加第一个路由
      </button>
    </div>

    <!-- 域名列表 -->
    <div v-for="domain in store.status.domains" :key="`${domain.domain}:${domain.port}`" class="mt-6">
      <div class="flex items-center gap-3">
        <h3 class="text-sm font-semibold text-neutral-900">{{ domain.domain }}</h3>
        <span
          class="rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide"
          :class="domain.isFunnel ? 'bg-indigo-50 text-indigo-700' : 'bg-emerald-50 text-emerald-700'"
        >
          {{ domain.isFunnel ? 'Funnel' : 'Serve' }}
        </span>
        <span class="font-mono text-xs text-neutral-400">:{{ domain.port }}</span>
      </div>

      <div class="mt-3 space-y-2">
        <div
          v-for="handler in domain.handlers"
          :key="handler.path"
          class="flex items-center justify-between rounded-xl border border-neutral-200 bg-white px-5 py-4 shadow-sm transition-colors hover:border-neutral-300"
        >
          <div class="flex items-center gap-4">
            <span
              class="inline-flex h-2.5 w-2.5 rounded-full"
              :class="{
                'bg-emerald-500': healthMap[handler.proxy.replace(/^https?:\/\//, '').replace(/\/$/, '')] === 'ok',
                'bg-red-400': healthMap[handler.proxy.replace(/^https?:\/\//, '').replace(/\/$/, '')] === 'down',
                'bg-neutral-300 animate-pulse': healthMap[handler.proxy.replace(/^https?:\/\//, '').replace(/\/$/, '')] === 'checking' || !healthMap[handler.proxy.replace(/^https?:\/\//, '').replace(/\/$/, '')],
              }"
              :title="healthMap[handler.proxy.replace(/^https?:\/\//, '').replace(/\/$/, '')] === 'ok' ? '服务可达' : healthMap[handler.proxy.replace(/^https?:\/\//, '').replace(/\/$/, '')] === 'down' ? '服务不可达' : '检查中...'"
            />
            <div>
              <div class="font-mono text-sm font-semibold text-neutral-900">{{ handler.path }}</div>
              <div class="mt-0.5 text-xs text-neutral-500">
                <span class="font-mono text-neutral-600">{{ handler.proxy }}</span>
              </div>
            </div>
          </div>

          <div class="flex items-center gap-2">
            <a
              v-if="domain.isFunnel"
              :href="`https://${domain.domain}${handler.path}`"
              target="_blank"
              rel="noopener"
              class="rounded-md bg-indigo-50 px-3 py-1.5 text-xs font-medium text-indigo-700 transition-colors hover:bg-indigo-100"
            >
              访问
            </a>
            <button
              class="rounded-md bg-red-50 px-3 py-1.5 text-xs font-medium text-red-700 transition-colors hover:bg-red-100 disabled:opacity-40"
              :disabled="store.isPending"
              @click="handleRemove(handler.path)"
            >
              移除
            </button>
          </div>
        </div>
      </div>
    </div>

    <!-- 重置按钮 -->
    <div v-if="store.totalRoutes > 0" class="mt-8 flex justify-end">
      <button
        class="rounded-lg border border-red-200 bg-white px-4 py-2 text-sm font-medium text-red-700 transition-colors hover:bg-red-50 disabled:opacity-40"
        :disabled="store.isPending"
        @click="showConfirmReset = true"
      >
        重置全部配置
      </button>
    </div>

    <!-- 添加路由弹窗 -->
    <Teleport to="body">
      <div
        v-if="showAddModal"
        class="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
        @click.self="showAddModal = false"
      >
        <div class="w-full max-w-lg rounded-2xl bg-white p-6 shadow-xl">
          <h3 class="text-lg font-semibold text-neutral-900">添加 Funnel 路由</h3>
          <div class="mt-4 space-y-4">
            <div>
              <label class="mb-1 block text-xs font-medium text-neutral-600">挂载路径</label>
              <input
                v-model="newRoute.mountPath"
                class="w-full rounded-lg border border-neutral-200 px-3 py-2 font-mono text-sm focus:border-neutral-400 focus:outline-none"
                placeholder="如 /8790/PolarPrivate"
              />
              <p class="mt-1 text-[11px] text-neutral-400">对外暴露的 URL 路径</p>
            </div>
            <div>
              <label class="mb-1 block text-xs font-medium text-neutral-600">代理目标</label>
              <input
                v-model="newRoute.target"
                class="w-full rounded-lg border border-neutral-200 px-3 py-2 font-mono text-sm focus:border-neutral-400 focus:outline-none"
                placeholder="如 http://127.0.0.1:8790"
              />
              <p class="mt-1 text-[11px] text-neutral-400">本地服务地址</p>
            </div>
            <div>
              <label class="flex items-center gap-2 text-sm text-neutral-700">
                <input v-model="newRoute.asFunnel" type="checkbox" class="rounded" />
                公网可访问（Funnel）
              </label>
              <p class="ml-6 mt-0.5 text-[11px] text-neutral-400">
                关闭则仅 Tailnet 内部可访问（Serve）
              </p>
            </div>
          </div>
          <div class="mt-6 flex justify-end gap-3">
            <button
              class="rounded-lg border border-neutral-200 px-4 py-2 text-sm font-medium text-neutral-700 transition-colors hover:bg-neutral-50"
              @click="showAddModal = false"
            >
              取消
            </button>
            <button
              class="rounded-lg bg-neutral-900 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-neutral-800 disabled:opacity-40"
              :disabled="!newRoute.mountPath || !newRoute.target || store.isPending"
              @click="handleAdd()"
            >
              {{ store.isPending ? '添加中...' : '添加' }}
            </button>
          </div>
        </div>
      </div>
    </Teleport>

    <!-- 重置确认弹窗 -->
    <Teleport to="body">
      <div
        v-if="showConfirmReset"
        class="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
        @click.self="showConfirmReset = false"
      >
        <div class="w-full max-w-sm rounded-2xl bg-white p-6 shadow-xl">
          <h3 class="text-lg font-semibold text-neutral-900">确认重置</h3>
          <p class="mt-2 text-sm text-neutral-600">
            这将移除所有 Tailscale Serve/Funnel 路由配置。确定继续？
          </p>
          <div class="mt-6 flex justify-end gap-3">
            <button
              class="rounded-lg border border-neutral-200 px-4 py-2 text-sm font-medium text-neutral-700 transition-colors hover:bg-neutral-50"
              @click="showConfirmReset = false"
            >
              取消
            </button>
            <button
              class="rounded-lg bg-red-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-red-700 disabled:opacity-40"
              :disabled="store.isPending"
              @click="handleResetAll()"
            >
              {{ store.isPending ? '重置中...' : '确认重置' }}
            </button>
          </div>
        </div>
      </div>
    </Teleport>
  </div>
</template>
