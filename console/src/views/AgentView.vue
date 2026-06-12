<script setup lang="ts">
import { onMounted, onUnmounted, ref } from 'vue'
import { useAgentStore } from '@/stores/agent'
import PageHeader from '@/components/PageHeader.vue'

const store = useAgentStore()
const chatMsg = ref('')

onMounted(() => {
  store.fetchStatus()
  if (store.isRunning) store.startPolling()
})
onUnmounted(() => store.stopPolling())

async function handleStart() {
  await store.start()
}

async function handleStop() {
  await store.stop()
}

async function handleAnalyze() {
  await store.analyze()
}

async function handleExecuteAll() {
  await store.executeAll()
}

async function handleChat() {
  if (!chatMsg.value.trim()) return
  await store.sendChat(chatMsg.value)
  chatMsg.value = ''
}

function actionIcon(action: string) {
  const map: Record<string, string> = {
    pull: '⬇️',
    create_remote: '🔗',
    register_port: '🔌',
    shell: '💻',
    skip: '⏭️',
    report: '📋',
  }
  return map[action] || '❓'
}

function actionLabel(action: string) {
  const map: Record<string, string> = {
    pull: 'Pull',
    create_remote: '创建远程',
    register_port: '注册端口',
    shell: '执行命令',
    skip: '跳过',
    report: '报告',
  }
  return map[action] || action
}

function logTypeClass(type: string) {
  const map: Record<string, string> = {
    info: 'text-neutral-500',
    action: 'text-emerald-600',
    error: 'text-red-500',
    llm: 'text-purple-600',
  }
  return map[type] || 'text-neutral-500'
}
</script>

<template>
  <div>
    <div class="flex items-center justify-between">
      <PageHeader title="Agent" description="按需启动的智能运维助手 — 通过 PolarPrivate 代理调用 LLM" />
      <div class="flex items-center gap-3">
        <!-- 状态指示器 -->
        <div class="flex items-center gap-2">
          <span
            class="h-2.5 w-2.5 rounded-full"
            :class="store.isRunning ? 'bg-emerald-500 animate-pulse' : 'bg-neutral-300'"
          />
          <span class="text-sm font-medium" :class="store.isRunning ? 'text-emerald-700' : 'text-neutral-500'">
            {{ store.isRunning ? '运行中' : '已停止' }}
          </span>
        </div>
        <button
          v-if="!store.isRunning"
          type="button"
          class="rounded-md bg-emerald-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-emerald-500 disabled:opacity-50"
          :disabled="store.isLoading"
          @click="handleStart"
        >
          启动 Agent
        </button>
        <button
          v-else
          type="button"
          class="rounded-md bg-red-50 px-4 py-2 text-sm font-medium text-red-700 transition-colors hover:bg-red-100 disabled:opacity-50"
          :disabled="store.isLoading"
          @click="handleStop"
        >
          停止
        </button>
      </div>
    </div>

    <!-- Agent 未启动提示 -->
    <div v-if="!store.isRunning" class="mt-8 rounded-xl border border-neutral-200 bg-white p-12 text-center">
      <svg class="mx-auto h-12 w-12 text-neutral-300" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
        <path d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z" />
      </svg>
      <h3 class="mt-4 text-lg font-medium text-neutral-900">Agent 未启动</h3>
      <p class="mt-2 text-sm text-neutral-500">
        点击「启动 Agent」开始智能分析。Agent 将在 10 分钟无操作后自动关闭。
      </p>
      <p v-if="store.state.shutdownAt" class="mt-1 text-xs text-neutral-400">
        上次运行: {{ new Date(store.state.shutdownAt).toLocaleString('zh-CN') }}
      </p>
    </div>

    <!-- Agent 运行中 -->
    <template v-if="store.isRunning">
      <!-- 运行信息 -->
      <div class="mt-6 flex gap-4">
        <div class="rounded-lg border border-neutral-200 bg-white px-4 py-3">
          <div class="text-xs text-neutral-400">启动时间</div>
          <div class="mt-0.5 font-mono text-sm text-neutral-700">
            {{ store.state.startedAt ? new Date(store.state.startedAt).toLocaleString('zh-CN') : '—' }}
          </div>
        </div>
        <div class="rounded-lg border border-neutral-200 bg-white px-4 py-3">
          <div class="text-xs text-neutral-400">最近活动</div>
          <div class="mt-0.5 font-mono text-sm text-neutral-700">
            {{ store.state.lastActiveAt ? new Date(store.state.lastActiveAt).toLocaleString('zh-CN') : '—' }}
          </div>
        </div>
        <div class="rounded-lg border border-neutral-200 bg-white px-4 py-3">
          <div class="text-xs text-neutral-400">待处理操作</div>
          <div class="mt-0.5 font-mono text-sm text-neutral-700">
            {{ store.pendingActions.length }}
          </div>
        </div>
      </div>

      <!-- 快速操作按钮 -->
      <div class="mt-6 flex gap-3">
        <button
          type="button"
          class="rounded-md bg-neutral-900 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-neutral-700 disabled:opacity-50"
          :disabled="store.isLoading"
          @click="handleAnalyze"
        >
          {{ store.isLoading ? '分析中...' : '分析仓库状态' }}
        </button>
        <button
          v-if="store.pendingActions.length > 0"
          type="button"
          class="rounded-md bg-emerald-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-emerald-500 disabled:opacity-50"
          :disabled="store.isLoading"
          @click="handleExecuteAll"
        >
          执行全部 ({{ store.pendingActions.length }})
        </button>
      </div>

      <!-- 对话输入 -->
      <div class="mt-6 rounded-xl border border-neutral-200 bg-white p-4">
        <label class="text-xs font-semibold uppercase tracking-wider text-neutral-400">自然语言指令</label>
        <div class="mt-2 flex gap-2">
          <input
            v-model="chatMsg"
            type="text"
            placeholder="例: 帮我把所有落后的仓库拉到最新 / 给 3D 项目创建 GitHub 仓库"
            class="flex-1 rounded-md border border-neutral-200 bg-neutral-50 px-3 py-2 text-sm text-neutral-900 placeholder:text-neutral-400 focus:border-neutral-400 focus:outline-none"
            @keydown.enter="handleChat"
          />
          <button
            type="button"
            class="rounded-md bg-neutral-900 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-neutral-700 disabled:opacity-50"
            :disabled="store.isLoading || !chatMsg.trim()"
            @click="handleChat"
          >
            发送
          </button>
        </div>
        <div v-if="store.chatResponse" class="mt-3 rounded-lg bg-neutral-50 p-3">
          <pre class="whitespace-pre-wrap font-mono text-xs leading-5 text-neutral-700">{{ store.chatResponse }}</pre>
        </div>
      </div>

      <!-- 操作建议 -->
      <div v-if="store.pendingActions.length > 0" class="mt-6">
        <h2 class="text-sm font-medium uppercase tracking-wide text-neutral-500">操作建议</h2>
        <div class="mt-3 space-y-2">
          <div
            v-for="(act, i) in store.pendingActions"
            :key="i"
            class="flex items-start gap-3 rounded-lg border border-neutral-200 bg-white p-3"
          >
            <span class="text-lg">{{ actionIcon(act.action) }}</span>
            <div class="min-w-0 flex-1">
              <div class="flex items-center gap-2">
                <span class="rounded bg-neutral-100 px-1.5 py-0.5 text-xs font-medium text-neutral-700">
                  {{ actionLabel(act.action) }}
                </span>
                <span v-if="act.repo" class="font-mono text-sm text-neutral-900">{{ act.repo }}</span>
                <span v-if="act.github_name" class="text-xs text-neutral-500">→ {{ act.github_name }}</span>
              </div>
              <p v-if="act.reason" class="mt-1 text-xs text-neutral-500">{{ act.reason }}</p>
              <p v-if="act.message" class="mt-1 text-xs text-neutral-600">{{ act.message }}</p>
              <p v-if="act.command" class="mt-1 font-mono text-xs text-neutral-500">$ {{ act.command }}</p>
            </div>
          </div>
        </div>
      </div>

      <!-- 日志 -->
      <div class="mt-6">
        <h2 class="text-sm font-medium uppercase tracking-wide text-neutral-500">Agent 日志</h2>
        <div class="mt-3 max-h-[400px] overflow-y-auto rounded-lg border border-neutral-200 bg-neutral-900 p-4">
          <div v-if="store.logs.length === 0" class="text-sm text-neutral-500">暂无日志</div>
          <div
            v-for="(entry, i) in [...store.logs].reverse()"
            :key="i"
            class="flex gap-3 py-1 font-mono text-xs"
          >
            <span class="shrink-0 text-neutral-500">
              {{ new Date(entry.timestamp).toLocaleTimeString('zh-CN') }}
            </span>
            <span
              class="shrink-0 w-12 text-right uppercase"
              :class="logTypeClass(entry.type)"
            >
              {{ entry.type }}
            </span>
            <span class="text-neutral-300">{{ entry.message }}</span>
          </div>
        </div>
      </div>
    </template>
  </div>
</template>
