import { defineStore } from 'pinia'
import { ref } from 'vue'

/** Same-origin API as `knowlever.ts` (Vite proxy → :4800). */

export interface IDigistInterest {
  id: string
  user: string
  name: string
  sources: string[]
  schedule: string
  linkedTopic: string | null
  lastSync: string | null
}

export interface IDigistSource {
  id: string
  platform: string
  config: Record<string, unknown>
  enabled: boolean
  lastCrawl: string | null
  itemCount: number
}

export interface IDigistStatus {
  available: boolean
  openCliAvailable: boolean
  chromeRunning: boolean
  dbPath: string
  totalItems: number
  totalInterests: number
  totalSources: number
  lastCrawlAt: string | null
  schedulerRunning: boolean
  reason?: string
}

export interface ICreateInterestBody {
  user?: string
  name: string
  sources: string[]
  schedule: string
  linkedTopic?: string | null
}

export interface IUpdateInterestBody {
  name?: string
  sources?: string[]
  schedule?: string
  linkedTopic?: string | null
}

export interface IAddSourceBody {
  platform: string
  config: Record<string, unknown>
}

const JSON_HEADERS = { 'Content-Type': 'application/json' } as const

const DEFAULT_POLL_MS = 10_000

export const useDigistStore = defineStore('digist', () => {
  const status = ref<IDigistStatus | null>(null)
  const interests = ref<IDigistInterest[]>([])
  const sources = ref<IDigistSource[]>([])
  const loading = ref(false)
  /** Set when any of the dashboard GETs fail (HTTP or network). */
  const lastError = ref<string | null>(null)

  let pollTimer: ReturnType<typeof setInterval> | null = null

  async function fetchAll() {
    loading.value = true
    lastError.value = null
    try {
      const [statusRes, interestsRes, sourcesRes] = await Promise.all([
        fetch(`${import.meta.env.BASE_URL}api/digist/status`),
        fetch(`${import.meta.env.BASE_URL}api/digist/interests?limit=10`),
        fetch(`${import.meta.env.BASE_URL}api/digist/sources?limit=10`),
      ])
      const errs: string[] = []
      if (statusRes.ok) status.value = await statusRes.json()
      else errs.push(`status HTTP ${statusRes.status}`)
      if (interestsRes.ok) interests.value = await interestsRes.json()
      else errs.push(`interests HTTP ${interestsRes.status}`)
      if (sourcesRes.ok) sources.value = await sourcesRes.json()
      else errs.push(`sources HTTP ${sourcesRes.status}`)
      if (errs.length) lastError.value = errs.join(' · ')
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      lastError.value = msg
      console.error('DiGist 数据获取失败:', e)
    } finally {
      loading.value = false
    }
  }

  function startPolling(intervalMs = DEFAULT_POLL_MS) {
    stopPolling()
    void fetchAll()
    pollTimer = setInterval(() => void fetchAll(), intervalMs)
  }

  function stopPolling() {
    if (pollTimer != null) {
      clearInterval(pollTimer)
      pollTimer = null
    }
  }

  async function triggerCrawl(body?: { interestId?: string }) {
    const res = await fetch(`${import.meta.env.BASE_URL}api/digist/crawl/trigger`, {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify(body ?? {}),
    })
    const data = await res.json().catch(() => ({}))
    await fetchAll()
    return data
  }

  async function createInterest(body: ICreateInterestBody) {
    const res = await fetch(`${import.meta.env.BASE_URL}api/digist/interests`, {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify(body),
    })
    const data = await res.json().catch(() => ({}))
    await fetchAll()
    return data
  }

  async function updateInterest(id: string, body: IUpdateInterestBody) {
    const res = await fetch(`${import.meta.env.BASE_URL}api/digist/interests/${encodeURIComponent(id)}`, {
      method: 'PUT',
      headers: JSON_HEADERS,
      body: JSON.stringify(body),
    })
    const data = await res.json().catch(() => ({}))
    await fetchAll()
    return data
  }

  async function deleteInterest(id: string) {
    const res = await fetch(`${import.meta.env.BASE_URL}api/digist/interests/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    })
    const data = await res.json().catch(() => ({}))
    await fetchAll()
    return data
  }

  async function addSource(body: IAddSourceBody) {
    const res = await fetch(`${import.meta.env.BASE_URL}api/digist/sources`, {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify(body),
    })
    const data = await res.json().catch(() => ({}))
    await fetchAll()
    return data
  }

  async function removeSource(id: string) {
    const res = await fetch(`${import.meta.env.BASE_URL}api/digist/sources/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    })
    const data = await res.json().catch(() => ({}))
    await fetchAll()
    return data
  }

  async function fetchCrawlHistory(limit = 50) {
    const q = new URLSearchParams({ limit: String(limit) })
    const res = await fetch(`${import.meta.env.BASE_URL}api/digist/crawl/history?${q}`)
    if (!res.ok) return null
    return res.json()
  }

  async function syncToKnowLever(body: { interestId: string; topicName: string }) {
    const res = await fetch(`${import.meta.env.BASE_URL}api/digist/sync-to-knowlever`, {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify(body),
    })
    return res.json().catch(() => ({}))
  }

  return {
    status,
    interests,
    sources,
    loading,
    lastError,
    fetchAll,
    startPolling,
    stopPolling,
    triggerCrawl,
    createInterest,
    updateInterest,
    deleteInterest,
    addSource,
    removeSource,
    fetchCrawlHistory,
    syncToKnowLever,
  }
})
