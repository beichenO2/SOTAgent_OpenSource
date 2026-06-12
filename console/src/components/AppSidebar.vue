<script setup lang="ts">
import { ref } from 'vue'
import { RouterLink, useRoute } from 'vue-router'

const isCollapsed = ref(false)
const route = useRoute()

interface INavItem {
  to: string
  label: string
  icon: string
}

interface INavGroup {
  title: string
  items: INavItem[]
}

const navGroups: INavGroup[] = [
  {
    title: '同步',
    items: [
      { to: '/repos', label: 'Git 仓库', icon: 'M4 6a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2H6a2 2 0 01-2-2V6zM14 6a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2h-2a2 2 0 01-2-2V6zM4 16a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2H6a2 2 0 01-2-2v-2zM14 16a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2h-2a2 2 0 01-2-2v-2z' },
      { to: '/ports', label: '端口注册', icon: 'M9 3v2m6-2v2M9 19v2m6-2v2M5 9H3m2 6H3m18-6h-2m2 6h-2M7 19h10a2 2 0 002-2V7a2 2 0 00-2-2H7a2 2 0 00-2 2v10a2 2 0 002 2zM9 9h6v6H9V9z' },
      { to: '/funnel', label: 'Funnel', icon: 'M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1' },
      { to: '/assets', label: '技术资产', icon: 'M19.428 15.428a2 2 0 00-1.022-.547l-2.387-.477a6 6 0 00-3.86.517l-.318.158a6 6 0 01-3.86.517L6.05 15.21a2 2 0 00-1.806.547M8 4h8l-1 1v5.172a2 2 0 00.586 1.414l5 5c1.26 1.26.367 3.414-1.415 3.414H4.828c-1.782 0-2.674-2.154-1.414-3.414l5-5A2 2 0 009 10.172V5L8 4z' },
    ],
  },
  {
    title: '知识',
    items: [
      { to: '/knowlever', label: 'KnowLever', icon: 'M12 6.253v13m0-13C10.832 5.477 9.246 5 7.5 5S4.168 5.477 3 6.253v13C4.168 18.477 5.754 18 7.5 18s3.332.477 4.5 1.253m0-13C13.168 5.477 14.754 5 16.5 5c1.747 0 3.332.477 4.5 1.253v13C19.832 18.477 18.247 18 16.5 18c-1.746 0-3.332.477-4.5 1.253' },
      { to: '/digist', label: 'DiGist', icon: 'M19 20H5a2 2 0 01-2-2V6a2 2 0 012-2h10a2 2 0 012 2v1m2 13a2 2 0 01-2-2V7m2 13a2 2 0 002-2V9a2 2 0 00-2-2h-2m-4-3H9M7 16h6M7 8h6v4H7V8z' },
    ],
  },
  {
    title: '系统',
    items: [
      { to: '/services', label: '服务管理', icon: 'M5 12h14M5 12a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v4a2 2 0 01-2 2M5 12a2 2 0 00-2 2v4a2 2 0 002 2h14a2 2 0 002-2v-4a2 2 0 00-2-2' },
      { to: '/resources', label: '资源画像', icon: 'M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z' },
      // TODO: Agent 页面尚未完成，暂时隐藏入口。完成后取消注释恢复。
      // { to: '/agent', label: 'Agent', icon: 'M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z' },
      { to: '/architecture', label: '架构总览', icon: 'M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10' },
      { to: '/costs', label: '成本透明', icon: 'M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 11-18 0 9 9 0 0118 0z' },
      { to: '/rate-limits', label: 'LLM 限速', icon: 'M13 10V3L4 14h7v7l9-11h-7z' },
    ],
  },
]

function isActive(to: string) {
  return route.path.startsWith(to)
}
</script>

<template>
  <aside
    class="flex shrink-0 flex-col border-r border-neutral-200 bg-white transition-[width] duration-200"
    :class="isCollapsed ? 'w-14' : 'w-56'"
  >
    <div class="flex h-14 shrink-0 items-center border-b border-neutral-200 px-3">
      <button
        type="button"
        class="flex h-8 w-8 items-center justify-center rounded-md text-neutral-500 transition-colors hover:bg-neutral-100 hover:text-neutral-900"
        @click="isCollapsed = !isCollapsed"
      >
        <svg class="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path v-if="isCollapsed" d="M4 6h16M4 12h16M4 18h16" />
          <path v-else d="M4 6h16M4 12h10M4 18h16" />
        </svg>
      </button>
      <span v-if="!isCollapsed" class="ml-2 text-base font-bold tracking-tight text-neutral-900">
        SOTAgent
      </span>
    </div>

    <nav class="flex flex-1 flex-col gap-0.5 overflow-y-auto p-2">
      <div v-for="group in navGroups" :key="group.title || '__root'">
        <div
          v-if="group.title && !isCollapsed"
          class="mb-1 mt-3 px-3 text-[10px] font-semibold uppercase tracking-wider text-neutral-400 first:mt-0"
        >
          {{ group.title }}
        </div>
        <div v-else-if="group.title && isCollapsed" class="mx-auto my-2 h-px w-5 bg-neutral-200" />

        <RouterLink
          v-for="item in group.items"
          :key="item.to"
          :to="item.to"
          :title="isCollapsed ? item.label : undefined"
          class="relative flex items-center rounded-md transition-colors"
          :class="[
            isCollapsed ? 'justify-center px-2 py-2' : 'gap-2.5 px-3 py-2',
            isActive(item.to)
              ? 'bg-neutral-100 font-medium text-neutral-900'
              : 'text-neutral-600 hover:bg-neutral-50 hover:text-neutral-900',
            !isCollapsed && 'text-sm',
          ]"
        >
          <span
            v-if="isActive(item.to) && !isCollapsed"
            class="absolute inset-y-1 left-0 w-[3px] rounded-full bg-neutral-900"
          />
          <svg class="h-4 w-4 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path :d="item.icon" />
          </svg>
          <span v-if="!isCollapsed">{{ item.label }}</span>
        </RouterLink>
      </div>
    </nav>
  </aside>
</template>
