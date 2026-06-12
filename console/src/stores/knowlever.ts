import { defineStore } from 'pinia'
import { ref, computed } from 'vue'


export type PipelineStep =
  | 'idle'
  | 'ingest'
  | 'compile'
  | 'build'
  | 'autooffice:pptx'
  | 'autooffice:pdf'
  | 'site:enhanced'
  | 'done'
  | 'error'

export type OutputFormat = 'html' | 'pptx' | 'pdf' | 'enhanced'

export interface ITopicMeta {
  topic_id: string
  name: string
  mode: string
  created_at: string
  retrieval_indexed?: boolean
  last_indexed_pages?: number
  last_indexed_chunks?: number
}

export interface IPipelineRun {
  topicId: string
  step: PipelineStep
  progress: number
  startedAt: string
  outputs: string[]
  logs: string[]
  pid: number | null
  error: string | null
  resourceUsage: { cpu: number; mem: number } | null
  elapsedMs: number
}

export interface ITopicStatus {
  name: string
  user: string
  meta: ITopicMeta | null
  rawFileCount: number
  normalizedCount: number
  wikiPageCount: number
  outputPageCount: number
  lastRawChange: string | null
  lastCompile: string | null
  lastBuild: string | null
  pipeline: IPipelineRun | null
}

export interface IKnowLeverStatus {
  available: boolean
  topicCount: number
  runningPipelines: number
  autoCompile: boolean
  cooldownMinutes: number
  autoOfficeAvailable: boolean
}

export interface IKnowLeverConfig {
  autoCompile: boolean
  cooldownMinutes: number
  defaultOutputs: OutputFormat[]
  autoOfficeUrl: string
}

export const useKnowLeverStore = defineStore('knowlever', () => {
  const status = ref<IKnowLeverStatus | null>(null)
  const topics = ref<ITopicStatus[]>([])
  const config = ref<IKnowLeverConfig | null>(null)
  const loading = ref(false)
  const activePipelineTopic = ref<string | null>(null)
  const pipelineDetail = ref<IPipelineRun | null>(null)

  const runningTopics = computed(() =>
    topics.value.filter(t => t.pipeline && t.pipeline.step !== 'idle' && t.pipeline.step !== 'done' && t.pipeline.step !== 'error'),
  )

  async function fetchAll() {
    loading.value = true
    try {
      const [statusRes, topicsRes, configRes] = await Promise.all([
        fetch(`${import.meta.env.BASE_URL}api/knowlever/status`),
        fetch(`${import.meta.env.BASE_URL}api/knowlever/topics?user=all`),
        fetch(`${import.meta.env.BASE_URL}api/knowlever/config`),
      ])
      status.value = await statusRes.json()
      topics.value = await topicsRes.json()
      config.value = await configRes.json()
    } catch (e) {
      console.error('KnowLever 数据获取失败:', e)
    } finally {
      loading.value = false
    }
  }

  async function startPipeline(topicName: string, outputs: OutputFormat[], user = 'admin') {
    const res = await fetch(`${import.meta.env.BASE_URL}api/knowlever/topics/${topicName}/run?user=${encodeURIComponent(user)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ outputs }),
    })
    const data = await res.json()
    if (data.ok) {
      activePipelineTopic.value = topicName
      await fetchAll()
    }
    return data
  }

  async function cancelPipeline(topicName: string, user = 'admin') {
    const res = await fetch(`${import.meta.env.BASE_URL}api/knowlever/topics/${topicName}/cancel?user=${encodeURIComponent(user)}`, { method: 'POST' })
    const data = await res.json()
    await fetchAll()
    return data
  }

  async function fetchProgress(topicName: string, user = 'admin') {
    try {
      const res = await fetch(`${import.meta.env.BASE_URL}api/knowlever/topics/${topicName}/progress?user=${encodeURIComponent(user)}`)
      if (res.ok) {
        pipelineDetail.value = await res.json()
      }
    } catch { /* ignore */ }
  }

  async function updateConfig(updates: Partial<IKnowLeverConfig>) {
    const res = await fetch(`${import.meta.env.BASE_URL}api/knowlever/config`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(updates),
    })
    config.value = await res.json()
    return config.value
  }

  return {
    status, topics, config, loading, activePipelineTopic, pipelineDetail,
    runningTopics,
    fetchAll, startPipeline, cancelPipeline, fetchProgress, updateConfig,
  }
})
