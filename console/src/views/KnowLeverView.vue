<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { RouterLink } from 'vue-router'
import { useKnowLeverStore, type OutputFormat, type ITopicStatus, type PipelineStep } from '@/stores/knowlever'
import { useProcessStore } from '@/stores/process'
import PageHeader from '@/components/PageHeader.vue'
import StatCard from '@/components/StatCard.vue'

const store = useKnowLeverStore()
const processStore = useProcessStore()

/** Managed service id for POST /api/services/:id/start|stop (S1 registration may use slug). */
const autoOfficeServiceId = computed(() => {
  const list = processStore.services
  const byId = list.find(s => s.id === 'autooffice')
  if (byId) return byId.id
  const match = list.find(s => /autooffice/i.test(s.id) || /autooffice/i.test(s.name))
  return match?.id ?? 'autooffice'
})

const autoOfficeActionPending = computed(() => processStore.isPending(autoOfficeServiceId.value))

async function startAutoOfficeService() {
  try {
    await processStore.serviceAction(autoOfficeServiceId.value, 'start')
    await store.fetchAll()
  } catch { /* processStore.error */ }
}

async function stopAutoOfficeService() {
  try {
    await processStore.serviceAction(autoOfficeServiceId.value, 'stop')
    await store.fetchAll()
  } catch { /* processStore.error */ }
}

let timer: ReturnType<typeof setInterval> | null = null
let progressTimer: ReturnType<typeof setInterval> | null = null

onMounted(() => {
  void processStore.fetchServices()
  store.fetchAll()
  timer = setInterval(() => store.fetchAll(), 10_000)
})

onUnmounted(() => {
  if (timer) clearInterval(timer)
  if (progressTimer) clearInterval(progressTimer)
})

const icons = {
  topics: 'M12 6.253v13m0-13C10.832 5.477 9.246 5 7.5 5S4.168 5.477 3 6.253v13C4.168 18.477 5.754 18 7.5 18s3.332.477 4.5 1.253m0-13C13.168 5.477 14.754 5 16.5 5c1.747 0 3.332.477 4.5 1.253v13C19.832 18.477 18.247 18 16.5 18c-1.746 0-3.332.477-4.5 1.253',
  pipeline: 'M13 10V3L4 14h7v7l9-11h-7z',
  autoCompile: 'M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15',
  autoOffice: 'M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z',
  raw: 'M4 7v10c0 2.21 3.582 4 8 4s8-1.79 8-4V7M4 7c0 2.21 3.582 4 8 4s8-1.79 8-4M4 7c0-2.21 3.582-4 8-4s8 1.79 8 4',
  wiki: 'M19.428 15.428a2 2 0 00-1.022-.547l-2.387-.477a6 6 0 00-3.86.517l-.318.158a6 6 0 01-3.86.517L6.05 15.21a2 2 0 00-1.806.547M8 4h8l-1 1v5.172a2 2 0 00.586 1.414l5 5c1.26 1.26.367 3.414-1.415 3.414H4.828c-1.782 0-2.674-2.154-1.414-3.414l5-5A2 2 0 009 10.172V5L8 4z',
  output: 'M7 21h10a2 2 0 002-2V9.414a1 1 0 00-.293-.707l-5.414-5.414A1 1 0 0012.586 3H7a2 2 0 00-2 2v14a2 2 0 002 2z',
}

// ─── Run dialog ────────────────────────────────────

const showRunDialog = ref(false)
const selectedTopic = ref<ITopicStatus | null>(null)
const selectedOutputs = ref<OutputFormat[]>(['html'])

const outputOptions: { id: OutputFormat; label: string; desc: string }[] = [
  { id: 'html', label: 'HTML 网站', desc: '标准静态站点' },
  { id: 'pptx', label: 'PPT 演示', desc: 'via AutoOffice' },
  { id: 'pdf', label: 'PDF 文档', desc: 'via AutoOffice' },
  { id: 'enhanced', label: 'Astro 站点', desc: 'Starlight 增强版' },
]

const ingestPaste = ref('')
const ingestBusy = ref(false)
const ingestMessage = ref('')
const ingestError = ref('')

function openRunDialog(topic: ITopicStatus) {
  selectedTopic.value = topic
  selectedOutputs.value = store.config?.defaultOutputs ?? ['html']
  ingestPaste.value = ''
  ingestMessage.value = ''
  ingestError.value = ''
  showRunDialog.value = true
}

async function onIngestFileSelected(ev: Event) {
  const input = ev.target as HTMLInputElement
  const file = input.files?.[0]
  if (!file || !selectedTopic.value) return
  ingestBusy.value = true
  ingestMessage.value = ''
  ingestError.value = ''
  try {
    const fd = new FormData()
    fd.append('file', file)
    const name = selectedTopic.value.name
    const res = await fetch(`${import.meta.env.BASE_URL}api/knowlever/topics/${encodeURIComponent(name)}/ingest`, { method: 'POST', body: fd })
    const data = await res.json().catch(() => ({}))
    if (data.skipped) {
      ingestMessage.value = data.message || 'KnowLever 不可用，已跳过'
    } else if (data.ok) {
      ingestMessage.value = '导入完成'
      await store.fetchAll()
    } else {
      ingestError.value = data.message || data.stderr || '导入失败'
    }
  } catch (e: unknown) {
    ingestError.value = e instanceof Error ? e.message : String(e)
  } finally {
    ingestBusy.value = false
    input.value = ''
  }
}

async function submitPasteIngest() {
  if (!selectedTopic.value || !ingestPaste.value.trim()) return
  ingestBusy.value = true
  ingestMessage.value = ''
  ingestError.value = ''
  try {
    const name = selectedTopic.value.name
    const res = await fetch(`${import.meta.env.BASE_URL}api/knowlever/topics/${encodeURIComponent(name)}/ingest`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: ingestPaste.value }),
    })
    const data = await res.json().catch(() => ({}))
    if (data.skipped) {
      ingestMessage.value = data.message || 'KnowLever 不可用，已跳过'
    } else if (data.ok) {
      ingestMessage.value = '导入完成'
      ingestPaste.value = ''
      await store.fetchAll()
    } else {
      ingestError.value = data.message || data.stderr || '导入失败'
    }
  } catch (e: unknown) {
    ingestError.value = e instanceof Error ? e.message : String(e)
  } finally {
    ingestBusy.value = false
  }
}

function toggleOutput(fmt: OutputFormat) {
  const idx = selectedOutputs.value.indexOf(fmt)
  if (idx >= 0) {
    if (selectedOutputs.value.length > 1) selectedOutputs.value.splice(idx, 1)
  } else {
    selectedOutputs.value.push(fmt)
  }
}

async function startRun() {
  if (!selectedTopic.value) return
  await store.startPipeline(selectedTopic.value.name, selectedOutputs.value, selectedTopic.value.user)
  showRunDialog.value = false
  startProgressPolling(selectedTopic.value.name, selectedTopic.value.user)
}

function startProgressPolling(topicName: string, user = 'admin') {
  store.activePipelineTopic = topicName
  if (progressTimer) clearInterval(progressTimer)
  progressTimer = setInterval(async () => {
    await store.fetchProgress(topicName, user)
    if (
      store.pipelineDetail?.step === 'done' ||
      store.pipelineDetail?.step === 'error'
    ) {
      if (progressTimer) clearInterval(progressTimer)
      progressTimer = null
      store.fetchAll()
    }
  }, 3_000)
}

async function handleCancel(topicName: string, user = 'admin') {
  await store.cancelPipeline(topicName, user)
  if (progressTimer) clearInterval(progressTimer)
  progressTimer = null
}

// ─── Config ────────────────────────────────────────

const showConfig = ref(false)
const configDraft = ref({ autoCompile: true, cooldownMinutes: 30 })

function openConfig() {
  configDraft.value = {
    autoCompile: store.config?.autoCompile ?? true,
    cooldownMinutes: store.config?.cooldownMinutes ?? 30,
  }
  showConfig.value = true
}

async function saveConfig() {
  await store.updateConfig(configDraft.value)
  showConfig.value = false
}

// ─── Helpers ───────────────────────────────────────

function formatTime(iso: string | null) {
  if (!iso) return '-'
  return new Date(iso).toLocaleString('zh-CN', {
    month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit',
  })
}

function formatDuration(ms: number) {
  if (ms < 1000) return `${ms}ms`
  const sec = Math.round(ms / 1000)
  if (sec < 60) return `${sec}s`
  return `${Math.floor(sec / 60)}m ${sec % 60}s`
}

const stepLabel: Record<PipelineStep, string> = {
  idle: '空闲',
  ingest: '导入',
  compile: 'LLM 编译',
  build: 'HTML 构建',
  'autooffice:pptx': 'PPT 生成',
  'autooffice:pdf': 'PDF 生成',
  'site:enhanced': 'Astro 构建',
  done: '完成',
  error: '错误',
}

const stepColor: Record<string, string> = {
  idle: 'bg-neutral-100 text-neutral-600',
  ingest: 'bg-blue-100 text-blue-700',
  compile: 'bg-violet-100 text-violet-700',
  build: 'bg-indigo-100 text-indigo-700',
  'autooffice:pptx': 'bg-orange-100 text-orange-700',
  'autooffice:pdf': 'bg-rose-100 text-rose-700',
  'site:enhanced': 'bg-cyan-100 text-cyan-700',
  done: 'bg-emerald-100 text-emerald-700',
  error: 'bg-red-100 text-red-700',
}

const isRunning = (t: ITopicStatus) =>
  t.pipeline && t.pipeline.step !== 'idle' && t.pipeline.step !== 'done' && t.pipeline.step !== 'error'
</script>

<template>
  <div>
    <PageHeader title="KnowLever" description="知识流水线监控 · 自动编译 · 产出物管理">
      <template #actions>
        <button
          class="rounded-lg border border-neutral-200 px-3 py-1.5 text-sm font-medium text-neutral-700 transition-colors hover:bg-neutral-50"
          @click="openConfig"
        >
          设置
        </button>
        <button
          class="rounded-lg bg-neutral-900 px-3 py-1.5 text-sm font-medium text-white transition-colors hover:bg-neutral-700"
          @click="store.fetchAll"
        >
          刷新
        </button>
      </template>
    </PageHeader>

    <!-- 概览统计卡片 -->
    <section class="mt-8 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
      <StatCard
        label="Topics"
        :value="store.status?.topicCount ?? '-'"
        :icon="icons.topics"
        accent-bg="bg-blue-50"
        accent-text="text-blue-600"
      />
      <StatCard
        label="运行中流水线"
        :value="store.status?.runningPipelines ?? 0"
        :icon="icons.pipeline"
        :accent-bg="(store.status?.runningPipelines ?? 0) > 0 ? 'bg-amber-50' : 'bg-emerald-50'"
        :accent-text="(store.status?.runningPipelines ?? 0) > 0 ? 'text-amber-600' : 'text-emerald-600'"
      />
      <StatCard
        label="自动编译"
        :value="store.status?.autoCompile ? `开启 (${store.status.cooldownMinutes}min)` : '关闭'"
        :icon="icons.autoCompile"
        :accent-bg="store.status?.autoCompile ? 'bg-emerald-50' : 'bg-neutral-100'"
        :accent-text="store.status?.autoCompile ? 'text-emerald-600' : 'text-neutral-500'"
      />
      <div class="flex flex-col gap-2">
        <StatCard
          label="AutoOffice"
          :value="store.status?.autoOfficeAvailable ? '在线' : '离线'"
          :icon="icons.autoOffice"
          :accent-bg="store.status?.autoOfficeAvailable ? 'bg-emerald-50' : 'bg-red-50'"
          :accent-text="store.status?.autoOfficeAvailable ? 'text-emerald-600' : 'text-red-500'"
        />
        <div class="flex min-h-[2.25rem] flex-wrap items-center justify-end gap-2">
          <template v-if="!store.status?.autoOfficeAvailable">
            <button
              v-if="!autoOfficeActionPending"
              type="button"
              class="rounded-lg bg-neutral-900 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-neutral-700 disabled:opacity-50"
              :disabled="autoOfficeActionPending"
              @click="startAutoOfficeService"
            >
              启动
            </button>
            <span
              v-else
              class="inline-flex items-center gap-1.5 rounded-lg border border-neutral-200 bg-white px-3 py-1.5 text-xs font-medium text-neutral-600"
            >
              <svg class="h-3.5 w-3.5 animate-spin text-neutral-500" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4" />
                <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
              </svg>
              启动中…
            </span>
          </template>
          <template v-else>
            <button
              v-if="!autoOfficeActionPending"
              type="button"
              class="rounded-lg border border-neutral-200 bg-white px-3 py-1.5 text-xs font-medium text-neutral-700 transition-colors hover:bg-neutral-50"
              @click="stopAutoOfficeService"
            >
              停止
            </button>
            <span
              v-else
              class="inline-flex items-center gap-1.5 rounded-lg border border-neutral-200 bg-white px-3 py-1.5 text-xs font-medium text-neutral-600"
            >
              <svg class="h-3.5 w-3.5 animate-spin text-neutral-500" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4" />
                <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
              </svg>
              停止中…
            </span>
          </template>
        </div>
      </div>
    </section>

    <!-- 运行中流水线面板 -->
    <section v-if="store.pipelineDetail && store.activePipelineTopic" class="mt-8">
      <div class="rounded-xl border border-neutral-200 bg-white shadow-sm">
        <div class="flex items-center justify-between border-b border-neutral-100 px-5 py-3">
          <div class="flex items-center gap-3">
            <h3 class="text-sm font-semibold text-neutral-900">
              流水线: {{ store.activePipelineTopic }}
            </h3>
            <span
              class="rounded-full px-2 py-0.5 text-xs font-medium"
              :class="stepColor[store.pipelineDetail.step]"
            >
              {{ stepLabel[store.pipelineDetail.step] }}
            </span>
          </div>
          <div class="flex items-center gap-3">
            <span class="text-xs text-neutral-500">
              {{ formatDuration(store.pipelineDetail.elapsedMs) }}
            </span>
            <span v-if="store.pipelineDetail.resourceUsage" class="text-xs text-neutral-400">
              CPU {{ store.pipelineDetail.resourceUsage.cpu.toFixed(1) }}%
              · MEM {{ store.pipelineDetail.resourceUsage.mem.toFixed(1) }}%
            </span>
            <button
              v-if="store.pipelineDetail.step !== 'done' && store.pipelineDetail.step !== 'error'"
              class="rounded border border-red-200 px-2 py-1 text-xs font-medium text-red-600 transition-colors hover:bg-red-50"
              @click="handleCancel(store.activePipelineTopic!)"
            >
              取消
            </button>
          </div>
        </div>

        <!-- 进度条 -->
        <div class="px-5 pt-3">
          <div class="h-2 w-full overflow-hidden rounded-full bg-neutral-100">
            <div
              class="h-full rounded-full transition-all duration-500"
              :class="store.pipelineDetail.step === 'error' ? 'bg-red-500' : store.pipelineDetail.step === 'done' ? 'bg-emerald-500' : 'bg-blue-500'"
              :style="{ width: `${store.pipelineDetail.progress}%` }"
            />
          </div>
          <div class="mt-1 flex justify-between text-xs text-neutral-400">
            <span>{{ store.pipelineDetail.progress }}%</span>
            <span v-if="store.pipelineDetail.outputs.length">
              产出: {{ store.pipelineDetail.outputs.join(', ') }}
            </span>
          </div>
        </div>

        <!-- 日志 -->
        <div class="mt-3 max-h-48 overflow-y-auto border-t border-neutral-100 bg-neutral-50 px-5 py-3 font-mono text-xs leading-5 text-neutral-600">
          <div v-for="(log, i) in store.pipelineDetail.logs.slice(-30)" :key="i">{{ log }}</div>
          <div v-if="store.pipelineDetail.error" class="mt-1 text-red-600">
            错误: {{ store.pipelineDetail.error }}
          </div>
        </div>
      </div>
    </section>

    <!-- Topics 列表 -->
    <section class="mt-8">
      <h2 class="text-base font-semibold text-neutral-900">Topics</h2>
      <div class="mt-3 overflow-hidden rounded-xl border border-neutral-200 bg-white shadow-sm">
        <table class="w-full text-sm">
          <thead class="border-b border-neutral-100 bg-neutral-50">
            <tr>
              <th class="px-5 py-3 text-left font-medium text-neutral-500">名称</th>
              <th class="px-5 py-3 text-left font-medium text-neutral-500">用户</th>
              <th class="px-5 py-3 text-center font-medium text-neutral-500">Raw</th>
              <th class="px-5 py-3 text-center font-medium text-neutral-500">Wiki</th>
              <th class="px-5 py-3 text-center font-medium text-neutral-500">Output</th>
              <th class="px-5 py-3 text-left font-medium text-neutral-500">最近 Raw 变更</th>
              <th class="px-5 py-3 text-left font-medium text-neutral-500">最近编译</th>
              <th class="px-5 py-3 text-center font-medium text-neutral-500">状态</th>
              <th class="px-5 py-3 text-center font-medium text-neutral-500">操作</th>
            </tr>
          </thead>
          <tbody class="divide-y divide-neutral-100">
            <tr v-for="topic in store.topics" :key="`${topic.user}/${topic.name}`" class="transition-colors hover:bg-neutral-50">
              <td class="px-5 py-3">
                <div class="font-medium text-neutral-900">{{ topic.name }}</div>
                <div v-if="topic.meta?.mode" class="text-xs text-neutral-400">{{ topic.meta.mode }}</div>
              </td>
              <td class="px-5 py-3">
                <span class="rounded-full bg-neutral-100 px-2 py-0.5 text-xs font-medium text-neutral-600">{{ topic.user }}</span>
              </td>
              <td class="px-5 py-3 text-center font-mono text-neutral-700">{{ topic.rawFileCount }}</td>
              <td class="px-5 py-3 text-center font-mono text-neutral-700">{{ topic.wikiPageCount }}</td>
              <td class="px-5 py-3 text-center font-mono text-neutral-700">{{ topic.outputPageCount }}</td>
              <td class="px-5 py-3 text-neutral-600">{{ formatTime(topic.lastRawChange) }}</td>
              <td class="px-5 py-3 text-neutral-600">{{ formatTime(topic.lastCompile) }}</td>
              <td class="px-5 py-3 text-center">
                <span
                  v-if="isRunning(topic)"
                  class="inline-flex items-center gap-1 rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-700"
                >
                  <span class="h-1.5 w-1.5 animate-pulse rounded-full bg-amber-500" />
                  {{ stepLabel[topic.pipeline!.step] }}
                </span>
                <span
                  v-else-if="topic.pipeline?.step === 'error'"
                  class="rounded-full bg-red-100 px-2 py-0.5 text-xs font-medium text-red-700"
                >
                  错误
                </span>
                <span
                  v-else
                  class="rounded-full bg-neutral-100 px-2 py-0.5 text-xs font-medium text-neutral-500"
                >
                  就绪
                </span>
              </td>
              <td class="px-5 py-3 text-center">
                <div class="flex flex-wrap items-center justify-center gap-1.5">
                  <button
                    v-if="!isRunning(topic)"
                    class="rounded-md bg-neutral-900 px-3 py-1 text-xs font-medium text-white transition-colors hover:bg-neutral-700"
                    @click="openRunDialog(topic)"
                  >
                    运行
                  </button>
                  <button
                    v-else
                    class="rounded-md border border-neutral-200 px-3 py-1 text-xs font-medium text-neutral-600 transition-colors hover:bg-neutral-50"
                    @click="startProgressPolling(topic.name, topic.user)"
                  >
                    查看
                  </button>
                  <RouterLink
                    v-if="!isRunning(topic) && topic.rawFileCount === 0 && topic.wikiPageCount === 0"
                    to="/digist"
                    class="rounded-md border border-amber-200 bg-amber-50 px-2.5 py-1 text-xs font-medium text-amber-900 transition-colors hover:bg-amber-100"
                  >
                    DiGist
                  </RouterLink>
                </div>
              </td>
            </tr>
            <tr v-if="store.topics.length === 0">
              <td colspan="9" class="px-5 py-8 text-center text-neutral-400">
                {{ store.loading ? '加载中...' : '未发现 Topic' }}
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>

    <!-- 运行对话框 -->
    <Teleport to="body">
      <div
        v-if="showRunDialog"
        class="fixed inset-0 z-50 flex items-center justify-center bg-black/30 backdrop-blur-sm"
        @click.self="showRunDialog = false"
      >
        <div class="w-full max-w-md rounded-2xl bg-white p-6 shadow-xl">
          <h3 class="text-lg font-semibold text-neutral-900">
            运行流水线: {{ selectedTopic?.name }}
          </h3>
          <p class="mt-1 text-sm text-neutral-500">
            选择产出物格式，流水线将依次执行编译→构建→生成。
          </p>

          <div
            v-if="selectedTopic && selectedTopic.rawFileCount === 0 && selectedTopic.wikiPageCount === 0"
            class="mt-4 rounded-lg border border-amber-200 bg-amber-50/90 p-4 text-left"
          >
            <p class="text-sm font-medium text-amber-950">Raw / Wiki 均为 0 — 建议先导入素材</p>
            <div class="mt-3 flex flex-col gap-3 text-sm">
              <RouterLink
                to="/digist"
                class="inline-flex w-fit items-center rounded-md bg-amber-900 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-amber-800"
              >
                打开 DiGist 采集 / 同步
              </RouterLink>
              <div>
                <span class="text-xs font-medium text-neutral-700">上传文件</span>
                <input
                  type="file"
                  class="mt-1 block w-full text-xs text-neutral-600 file:mr-2 file:rounded file:border-0 file:bg-neutral-900 file:px-2 file:py-1 file:text-white"
                  :disabled="ingestBusy"
                  @change="onIngestFileSelected"
                />
              </div>
              <div>
                <span class="text-xs font-medium text-neutral-700">粘贴文本 / Markdown</span>
                <textarea
                  v-model="ingestPaste"
                  rows="4"
                  class="mt-1 w-full rounded-lg border border-neutral-200 px-2 py-1.5 font-mono text-xs text-neutral-800 focus:border-neutral-900 focus:outline-none focus:ring-1 focus:ring-neutral-900"
                  placeholder="粘贴内容后点击下方按钮写入 Raw…"
                  :disabled="ingestBusy"
                />
                <button
                  type="button"
                  class="mt-2 rounded-md bg-neutral-900 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-neutral-700 disabled:opacity-50"
                  :disabled="ingestBusy || !ingestPaste.trim()"
                  @click="submitPasteIngest"
                >
                  {{ ingestBusy ? '导入中…' : '导入文本' }}
                </button>
              </div>
              <p v-if="ingestMessage" class="text-xs text-emerald-800">{{ ingestMessage }}</p>
              <p v-if="ingestError" class="text-xs text-red-700">{{ ingestError }}</p>
            </div>
          </div>

          <div class="mt-5 space-y-2">
            <button
              v-for="opt in outputOptions"
              :key="opt.id"
              class="flex w-full items-center gap-3 rounded-lg border p-3 text-left transition-colors"
              :class="selectedOutputs.includes(opt.id)
                ? 'border-neutral-900 bg-neutral-50'
                : 'border-neutral-200 hover:border-neutral-300'"
              @click="toggleOutput(opt.id)"
            >
              <div
                class="flex h-5 w-5 shrink-0 items-center justify-center rounded border"
                :class="selectedOutputs.includes(opt.id) ? 'border-neutral-900 bg-neutral-900' : 'border-neutral-300'"
              >
                <svg v-if="selectedOutputs.includes(opt.id)" class="h-3 w-3 text-white" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3">
                  <path d="M5 13l4 4L19 7" />
                </svg>
              </div>
              <div>
                <div class="text-sm font-medium text-neutral-900">{{ opt.label }}</div>
                <div class="text-xs text-neutral-500">{{ opt.desc }}</div>
              </div>
              <span
                v-if="(opt.id === 'pptx' || opt.id === 'pdf') && !store.status?.autoOfficeAvailable"
                class="ml-auto rounded bg-red-50 px-1.5 py-0.5 text-[10px] font-medium text-red-600"
              >
                离线
              </span>
            </button>
          </div>

          <div class="mt-6 flex justify-end gap-2">
            <button
              class="rounded-lg border border-neutral-200 px-4 py-2 text-sm font-medium text-neutral-700 transition-colors hover:bg-neutral-50"
              @click="showRunDialog = false"
            >
              取消
            </button>
            <button
              class="rounded-lg bg-neutral-900 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-neutral-700"
              @click="startRun"
            >
              开始运行
            </button>
          </div>
        </div>
      </div>
    </Teleport>

    <!-- 设置对话框 -->
    <Teleport to="body">
      <div
        v-if="showConfig"
        class="fixed inset-0 z-50 flex items-center justify-center bg-black/30 backdrop-blur-sm"
        @click.self="showConfig = false"
      >
        <div class="w-full max-w-sm rounded-2xl bg-white p-6 shadow-xl">
          <h3 class="text-lg font-semibold text-neutral-900">KnowLever 设置</h3>

          <div class="mt-5 space-y-4">
            <div class="flex items-center justify-between">
              <label class="text-sm font-medium text-neutral-700">自动编译</label>
              <button
                class="relative h-6 w-11 rounded-full transition-colors"
                :class="configDraft.autoCompile ? 'bg-neutral-900' : 'bg-neutral-200'"
                @click="configDraft.autoCompile = !configDraft.autoCompile"
              >
                <span
                  class="absolute left-0.5 top-0.5 h-5 w-5 rounded-full bg-white shadow transition-transform"
                  :class="configDraft.autoCompile ? 'translate-x-5' : ''"
                />
              </button>
            </div>

            <div>
              <label class="text-sm font-medium text-neutral-700">冷却时间 (分钟)</label>
              <p class="text-xs text-neutral-400">检测到 Raw 变更后，等待多久无新变更再自动编译</p>
              <input
                v-model.number="configDraft.cooldownMinutes"
                type="number"
                min="1"
                max="240"
                class="mt-1.5 w-full rounded-lg border border-neutral-200 px-3 py-2 text-sm focus:border-neutral-900 focus:outline-none focus:ring-1 focus:ring-neutral-900"
              />
            </div>
          </div>

          <div class="mt-6 flex justify-end gap-2">
            <button
              class="rounded-lg border border-neutral-200 px-4 py-2 text-sm font-medium text-neutral-700 transition-colors hover:bg-neutral-50"
              @click="showConfig = false"
            >
              取消
            </button>
            <button
              class="rounded-lg bg-neutral-900 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-neutral-700"
              @click="saveConfig"
            >
              保存
            </button>
          </div>
        </div>
      </div>
    </Teleport>
  </div>
</template>
