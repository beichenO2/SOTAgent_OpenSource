<script setup lang="ts">
import { onMounted, ref, computed } from 'vue'
import { useSyncStore } from '@/stores/sync'
import { useAgentStore } from '@/stores/agent'
import PageHeader from '@/components/PageHeader.vue'
import StatCard from '@/components/StatCard.vue'

interface IServiceQuickLink {
  id: string
  name: string
  port: number
  status: string
}

const store = useSyncStore()
const agent = useAgentStore()
const runningSvcs = ref<IServiceQuickLink[]>([])

const interfaceChangeCount = ref(0)

const serviceLinks = computed(() =>
  runningSvcs.value.filter(s => s.status === 'running' && s.port)
)

async function fetchRunningServices() {
  try {
    const res = await fetch(import.meta.env.BASE_URL + 'api/services')
    if (!res.ok) return
    const all: IServiceQuickLink[] = await res.json()
    runningSvcs.value = all.filter(s => s.port && s.port > 0)
  } catch { /* non-critical */ }
}

async function fetchInterfaceChanges() {
  try {
    const res = await fetch(import.meta.env.BASE_URL + 'api/interface-changes')
    if (!res.ok) return
    const data = await res.json()
    interfaceChangeCount.value = data.total ?? 0
  } catch { /* non-critical */ }
}

onMounted(() => {
  if (store.repos.length === 0) store.fetchStatus()
  agent.fetchStatus()
  fetchRunningServices()
  fetchInterfaceChanges()
})

const icons = {
  synced: 'M5 13l4 4L19 7',
  behind: 'M19 14l-7 7m0 0l-7-7m7 7V3',
  noRemote: 'M18.364 18.364A9 9 0 005.636 5.636m12.728 12.728A9 9 0 015.636 5.636m12.728 12.728L5.636 5.636',
  dirty: 'M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4c-.77-.833-1.964-.833-2.732 0L4.082 16.5c-.77.833.192 2.5 1.732 2.5z',
}
</script>

<template>
  <div>
    <PageHeader title="仪表盘" description="Polarisor 项目群同步状态总览" />

    <section class="mt-8 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
      <StatCard
        label="已同步" :value="store.syncedCount"
        :icon="icons.synced" accent-bg="bg-emerald-50" accent-text="text-emerald-600"
      />
      <StatCard
        label="版本落后" :value="store.behindCount"
        :icon="icons.behind" accent-bg="bg-amber-50" accent-text="text-amber-600"
      />
      <StatCard
        label="无远程" :value="store.noRemoteCount"
        :icon="icons.noRemote" accent-bg="bg-red-50" accent-text="text-red-500"
      />
      <StatCard
        label="有未提交" :value="store.dirtyCount"
        :icon="icons.dirty" accent-bg="bg-blue-50" accent-text="text-blue-600"
      />
    </section>

    <!-- Agent 状态（页面暂未完成，隐藏链接，仅展示状态指示） -->
    <!-- <section class="mt-8">
      <RouterLink
        to="/agent"
        class="flex items-center justify-between rounded-xl border bg-white p-5 shadow-sm transition-all hover:shadow-md"
        :class="agent.isRunning ? 'border-emerald-200' : 'border-neutral-200'"
      >
        <div class="flex items-center gap-3">
          <span
            class="h-3 w-3 rounded-full"
            :class="agent.isRunning ? 'bg-emerald-500 animate-pulse' : 'bg-neutral-300'"
          />
          <div>
            <span class="text-sm font-medium text-neutral-900">SOTAgent Assistant</span>
            <span class="ml-2 text-xs text-neutral-500">
              {{ agent.isRunning ? '运行中 — 点击进入控制面板' : '未启动 — 点击启动' }}
            </span>
          </div>
        </div>
        <span class="text-xs text-neutral-400">
          {{ agent.isRunning && agent.state.lastActiveAt
            ? `最近活动: ${new Date(agent.state.lastActiveAt).toLocaleTimeString('zh-CN')}`
            : agent.state.shutdownAt
              ? `上次运行: ${new Date(agent.state.shutdownAt).toLocaleString('zh-CN')}`
              : '从未启动'
          }}
        </span>
      </RouterLink>
    </section> -->

    <!-- 接口变更预警 -->
    <section v-if="interfaceChangeCount > 0" class="mt-8">
      <RouterLink
        to="/architecture"
        class="flex items-center justify-between rounded-xl border border-amber-200 bg-amber-50 p-5 shadow-sm transition-all hover:shadow-md"
      >
        <div class="flex items-center gap-3">
          <svg class="h-5 w-5 text-amber-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
          </svg>
          <div>
            <span class="text-sm font-medium text-amber-900">接口变更 {{ interfaceChangeCount }} 项</span>
            <span class="ml-2 text-xs text-amber-700">点击查看架构总览</span>
          </div>
        </div>
        <span class="rounded-full bg-amber-200 px-2.5 py-1 text-xs font-semibold text-amber-800">{{ interfaceChangeCount }}</span>
      </RouterLink>
    </section>

    <!-- 快速操作 -->
    <section class="mt-10">
      <h2 class="text-sm font-medium uppercase tracking-wide text-neutral-500">快速操作</h2>
      <div class="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <RouterLink
          to="/repos"
          class="group flex items-start gap-3 rounded-xl border border-neutral-200 bg-white p-4 shadow-sm transition-all hover:border-neutral-300 hover:shadow-md"
        >
          <svg class="mt-0.5 h-4 w-4 shrink-0 text-neutral-400 group-hover:text-neutral-600" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M4 6a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2H6a2 2 0 01-2-2V6z" />
          </svg>
          <div>
            <div class="font-medium text-neutral-900 group-hover:text-neutral-700">Git 仓库管理</div>
            <div class="mt-1 text-xs text-neutral-500">查看和同步所有仓库状态</div>
          </div>
        </RouterLink>

        <RouterLink
          to="/ports"
          class="group flex items-start gap-3 rounded-xl border border-neutral-200 bg-white p-4 shadow-sm transition-all hover:border-neutral-300 hover:shadow-md"
        >
          <svg class="mt-0.5 h-4 w-4 shrink-0 text-neutral-400 group-hover:text-neutral-600" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M9 3v2m6-2v2M9 19v2m6-2v2M5 9H3m2 6H3m18-6h-2m2 6h-2M7 19h10a2 2 0 002-2V7a2 2 0 00-2-2H7a2 2 0 00-2 2v10a2 2 0 002 2zM9 9h6v6H9V9z" />
          </svg>
          <div>
            <div class="font-medium text-neutral-900 group-hover:text-neutral-700">端口注册表</div>
            <div class="mt-1 text-xs text-neutral-500">查看所有 Web 服务端口分配</div>
          </div>
        </RouterLink>

        <RouterLink
          to="/architecture"
          class="group flex items-start gap-3 rounded-xl border border-neutral-200 bg-white p-4 shadow-sm transition-all hover:border-neutral-300 hover:shadow-md"
        >
          <svg class="mt-0.5 h-4 w-4 shrink-0 text-neutral-400 group-hover:text-neutral-600" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10" />
          </svg>
          <div>
            <div class="font-medium text-neutral-900 group-hover:text-neutral-700">架构总览</div>
            <div class="mt-1 text-xs text-neutral-500">项目依赖拓扑图与接口监控</div>
          </div>
        </RouterLink>

        <a
          v-for="svc in serviceLinks"
          :key="svc.id"
          :href="`http://localhost:${svc.port}`"
          target="_blank"
          class="group flex items-start gap-3 rounded-xl border border-neutral-200 bg-white p-4 shadow-sm transition-all hover:border-emerald-300 hover:shadow-md"
        >
          <svg class="mt-0.5 h-4 w-4 shrink-0 text-emerald-500 group-hover:text-emerald-600" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M5 12h14M5 12a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v4a2 2 0 01-2 2M5 12a2 2 0 00-2 2v4a2 2 0 002 2h14a2 2 0 002-2v-4a2 2 0 00-2-2" />
          </svg>
          <div>
            <div class="font-medium text-neutral-900 group-hover:text-neutral-700">{{ svc.name }}</div>
            <div class="mt-1 text-xs text-neutral-500">:{{ svc.port }} · {{ svc.status === 'running' ? '运行中' : svc.status }}</div>
          </div>
        </a>
      </div>
    </section>

    <!-- 需要关注的项目 -->
    <section v-if="store.behindCount > 0" class="mt-10">
      <h2 class="text-sm font-medium uppercase tracking-wide text-neutral-500">需要关注</h2>
      <div class="mt-3 overflow-x-auto rounded-lg border border-neutral-200">
        <table class="w-full min-w-[480px] text-left text-sm">
          <thead class="border-b border-neutral-200 bg-neutral-50">
            <tr>
              <th class="px-4 py-2.5 text-xs font-semibold uppercase tracking-wider text-neutral-500">项目</th>
              <th class="px-4 py-2.5 text-xs font-semibold uppercase tracking-wider text-neutral-500">状态</th>
              <th class="px-4 py-2.5 text-xs font-semibold uppercase tracking-wider text-neutral-500">详情</th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="repo in store.repos.filter(r => r.syncStatus !== 'synced')"
              :key="repo.name"
              class="border-b border-neutral-100 transition-colors hover:bg-neutral-50 last:border-0"
            >
              <td class="px-4 py-2.5 font-mono font-medium text-neutral-900">{{ repo.name }}</td>
              <td class="px-4 py-2.5">
                <span
                  class="inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium"
                  :class="{
                    'bg-amber-100 text-amber-800': repo.syncStatus === 'behind',
                    'bg-red-100 text-red-800': repo.syncStatus === 'no_remote',
                    'bg-purple-100 text-purple-800': repo.syncStatus === 'diverged',
                    'bg-blue-100 text-blue-800': repo.syncStatus === 'ahead',
                  }"
                >
                  {{ repo.syncStatus === 'behind' ? '落后' : repo.syncStatus === 'no_remote' ? '无远程' : repo.syncStatus === 'diverged' ? '分歧' : '超前' }}
                </span>
              </td>
              <td class="px-4 py-2.5 text-neutral-600">
                <template v-if="repo.behind > 0">落后 {{ repo.behind }} 个提交</template>
                <template v-if="repo.ahead > 0">超前 {{ repo.ahead }} 个提交</template>
                <template v-if="repo.dirty > 0"> · {{ repo.dirty }} 个未提交文件</template>
                <template v-if="repo.syncStatus === 'no_remote'">未配置远程仓库</template>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>
  </div>
</template>
