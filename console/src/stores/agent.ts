import { defineStore } from 'pinia'
import { ref, computed } from 'vue'

export interface IAgentLog {
  timestamp: string
  type: 'info' | 'action' | 'error' | 'llm'
  message: string
}

export interface IAgentAction {
  action: string
  repo?: string
  reason?: string
  github_name?: string
  port?: number
  service?: string
  project?: string
  command?: string
  message?: string
}

export interface IAgentState {
  isRunning: boolean
  startedAt: string | null
  lastActiveAt: string | null
  shutdownAt: string | null
  logs: IAgentLog[]
  pendingActions: IAgentAction[]
}

export const useAgentStore = defineStore('agent', () => {
  const state = ref<IAgentState>({
    isRunning: false,
    startedAt: null,
    lastActiveAt: null,
    shutdownAt: null,
    logs: [],
    pendingActions: [],
  })
  const isLoading = ref(false)
  const chatInput = ref('')
  const chatResponse = ref('')

  const isRunning = computed(() => state.value.isRunning)
  const logs = computed(() => state.value.logs)
  const pendingActions = computed(() => state.value.pendingActions)

  let pollTimer: ReturnType<typeof setInterval> | null = null

  async function fetchStatus() {
    try {
      const res = await fetch(import.meta.env.BASE_URL + 'api/agent/status')
      if (res.ok) state.value = await res.json()
    } catch { /* 静默 */ }
  }

  function startPolling() {
    if (pollTimer) return
    pollTimer = setInterval(fetchStatus, 3000)
  }

  function stopPolling() {
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null }
  }

  async function start() {
    isLoading.value = true
    try {
      const res = await fetch(import.meta.env.BASE_URL + 'api/agent/start', { method: 'POST' })
      if (res.ok) state.value = await res.json()
      startPolling()
    } finally {
      isLoading.value = false
    }
  }

  async function stop() {
    isLoading.value = true
    try {
      const res = await fetch(import.meta.env.BASE_URL + 'api/agent/stop', { method: 'POST' })
      if (res.ok) state.value = await res.json()
      stopPolling()
    } finally {
      isLoading.value = false
    }
  }

  async function analyze() {
    isLoading.value = true
    try {
      const res = await fetch(import.meta.env.BASE_URL + 'api/agent/analyze', { method: 'POST' })
      const data = await res.json()
      if (data.ok) state.value.pendingActions = data.actions
      await fetchStatus()
    } finally {
      isLoading.value = false
    }
  }

  async function executeAll() {
    isLoading.value = true
    try {
      const res = await fetch(import.meta.env.BASE_URL + 'api/agent/execute-all', { method: 'POST' })
      await res.json()
      state.value.pendingActions = []
      await fetchStatus()
    } finally {
      isLoading.value = false
    }
  }

  async function sendChat(message: string) {
    isLoading.value = true
    chatResponse.value = ''
    try {
      const res = await fetch(import.meta.env.BASE_URL + 'api/agent/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message }),
      })
      const data = await res.json()
      chatResponse.value = data.ok ? data.response : data.message
      await fetchStatus()
    } finally {
      isLoading.value = false
    }
  }

  return {
    state,
    isLoading,
    isRunning,
    logs,
    pendingActions,
    chatInput,
    chatResponse,
    fetchStatus,
    start,
    stop,
    analyze,
    executeAll,
    sendChat,
    startPolling,
    stopPolling,
  }
})
