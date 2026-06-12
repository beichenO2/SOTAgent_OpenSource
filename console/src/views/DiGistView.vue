<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { useDigistStore, type IDigistInterest } from '@/stores/digist'
import { useKnowLeverStore } from '@/stores/knowlever'
import PageHeader from '@/components/PageHeader.vue'
import StatCard from '@/components/StatCard.vue'

const store = useDigistStore()
const knowLever = useKnowLeverStore()

const SCHEDULE_PRESETS: { label: string; cron: string }[] = [
  { label: '每3小时 (8–23 点)', cron: '0 8,11,14,17,20,23 * * *' },
  { label: '每6小时', cron: '0 */6 * * *' },
  { label: '每天 8:00', cron: '0 8 * * *' },
]

const icons = {
  items: 'M4 6h16M4 10h16M4 14h16M4 18h16',
  sources: 'M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10',
  openCli: 'M8 9l3 3-3 3m5 0h3M5 20h14a2 2 0 002-2V6a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z',
  chrome: 'M21 12a9 9 0 01-9 9m9-9a9 9 0 00-9-9m9 9H3m9 9a9 9 0 01-9-9m9 9c1.657 0 3-4.03 3-9s-1.343-9-3-9m0 18c-1.657 0-3-4.03-3-9s1.343-9 3-9m-9 9a9 9 0 019-9',
}

function formatTime(iso: string | null) {
  if (!iso) return '-'
  return new Date(iso).toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })
}

function interestItemSum(interest: IDigistInterest): number {
  const set = new Set(interest.sources)
  return store.sources.filter(s => set.has(s.id)).reduce((n, s) => n + s.itemCount, 0)
}

function configPreview(c: Record<string, unknown>, max = 48) {
  try {
    const s = JSON.stringify(c)
    return s.length <= max ? s : `${s.slice(0, max)}…`
  } catch {
    return '—'
  }
}

const showInterestModal = ref(false)
const interestDraft = ref({
  user: 'admin',
  name: '',
  sourceIds: [] as string[],
  schedule: SCHEDULE_PRESETS[0].cron,
  linkedTopic: '' as string,
})

const showSourceModal = ref(false)
const sourceDraft = ref({
  platform: 'twitter',
  configJson: '{"username":""}',
})

const showSyncModal = ref(false)
const syncInterest = ref<IDigistInterest | null>(null)
const syncTopicName = ref('')

const crawlBusyId = ref<string | null>(null)
const syncBusy = ref(false)
const actionMessage = ref<string | null>(null)

function openInterestModal() {
  interestDraft.value = {
    user: 'admin',
    name: '',
    sourceIds: [],
    schedule: SCHEDULE_PRESETS[0].cron,
    linkedTopic: '',
  }
  showInterestModal.value = true
}

function openSourceModal() {
  sourceDraft.value = { platform: 'twitter', configJson: '{"username":""}' }
  showSourceModal.value = true
}

function toggleSourceForInterest(id: string) {
  const arr = interestDraft.value.sourceIds
  const i = arr.indexOf(id)
  if (i >= 0) arr.splice(i, 1)
  else arr.push(id)
}

async function submitInterest() {
  actionMessage.value = null
  const name = interestDraft.value.name.trim()
  if (!name) {
    actionMessage.value = '请填写兴趣名称'
    return
  }
  const body = {
    user: interestDraft.value.user.trim() || 'admin',
    name,
    sources: interestDraft.value.sourceIds,
    schedule: interestDraft.value.schedule,
    linkedTopic: interestDraft.value.linkedTopic.trim() || null,
  }
  const res = await store.createInterest(body) as { ok?: boolean; message?: string }
  if (res && typeof res === 'object' && 'ok' in res && res.ok === false) {
    actionMessage.value = res.message ?? '创建失败'
    return
  }
  showInterestModal.value = false
  void store.fetchAll()
}

async function submitSource() {
  actionMessage.value = null
  let config: Record<string, unknown>
  try {
    config = JSON.parse(sourceDraft.value.configJson) as Record<string, unknown>
  } catch {
    actionMessage.value = '配置 JSON 无效'
    return
  }
  const res = await store.addSource({
    platform: sourceDraft.value.platform.trim() || 'custom',
    config,
  }) as { ok?: boolean; message?: string }
  if (res && typeof res === 'object' && 'ok' in res && res.ok === false) {
    actionMessage.value = res.message ?? '添加信源失败'
    return
  }
  showSourceModal.value = false
  void store.fetchAll()
}

async function crawlInterest(id: string) {
  actionMessage.value = null
  crawlBusyId.value = id
  try {
    const data = await store.triggerCrawl({ interestId: id }) as { ok?: boolean; message?: string }
    if (data && typeof data === 'object' && 'ok' in data && data.ok === false) {
      actionMessage.value = data.message ?? '触发爬取失败'
    }
  } catch (e) {
    actionMessage.value = e instanceof Error ? e.message : '触发爬取失败'
  } finally {
    crawlBusyId.value = null
  }
}

async function crawlAll() {
  actionMessage.value = null
  crawlBusyId.value = '__all__'
  try {
    const data = await store.triggerCrawl({}) as { ok?: boolean; message?: string }
    if (data && typeof data === 'object' && 'ok' in data && data.ok === false) {
      actionMessage.value = data.message ?? '触发爬取失败'
    }
  } catch (e) {
    actionMessage.value = e instanceof Error ? e.message : '触发爬取失败'
  } finally {
    crawlBusyId.value = null
  }
}

function openSyncModal(interest: IDigistInterest) {
  syncInterest.value = interest
  syncTopicName.value = interest.linkedTopic ?? interest.name
  actionMessage.value = null
  showSyncModal.value = true
}

async function submitSync() {
  const interest = syncInterest.value
  if (!interest) return
  const topicName = syncTopicName.value.trim()
  if (!topicName) {
    actionMessage.value = '请填写 KnowLever Topic 名称'
    return
  }
  syncBusy.value = true
  actionMessage.value = null
  try {
    const data = await store.syncToKnowLever({ interestId: interest.id, topicName }) as {
      ok?: boolean
      message?: string
      error?: string
    }
    if (data && typeof data === 'object') {
      if ('ok' in data && data.ok === false) {
        actionMessage.value = data.message ?? data.error ?? '同步失败'
        return
      }
    }
    showSyncModal.value = false
    void knowLever.fetchAll()
  } catch (e) {
    actionMessage.value = e instanceof Error ? e.message : '同步失败'
  } finally {
    syncBusy.value = false
  }
}

async function removeSourceRow(id: string) {
  if (!confirm('确定删除该信源？')) return
  actionMessage.value = null
  await store.removeSource(id)
}

const digistUnavailable = computed(() => store.status && !store.status.available)

onMounted(() => {
  void knowLever.fetchAll()
  store.startPolling()
})

onUnmounted(() => {
  store.stopPolling()
})
</script>

<template>
  <div>
    <PageHeader title="DiGist" description="信息聚合 · 兴趣与信源 · 爬取与 KnowLever 同步">
      <template #actions>
        <button
          type="button"
          class="rounded-lg border border-neutral-200 px-3 py-1.5 text-sm font-medium text-neutral-700 transition-colors hover:bg-neutral-50 disabled:opacity-50"
          :disabled="!!crawlBusyId || store.loading"
          @click="crawlAll"
        >
          全部爬取
        </button>
        <button
          type="button"
          class="rounded-lg bg-neutral-900 px-3 py-1.5 text-sm font-medium text-white transition-colors hover:bg-neutral-700 disabled:opacity-50"
          :disabled="store.loading"
          @click="store.fetchAll"
        >
          刷新
        </button>
      </template>
    </PageHeader>

    <div
      v-if="store.loading"
      class="mt-6 flex items-center gap-2 rounded-lg border border-neutral-200 bg-neutral-50 px-4 py-3 text-sm text-neutral-600"
      role="status"
      aria-live="polite"
    >
      <svg class="h-4 w-4 shrink-0 animate-spin text-neutral-500" viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4" />
        <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
      </svg>
      正在加载 DiGist 数据…
    </div>

    <div
      v-if="store.lastError"
      class="mt-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800"
      role="alert"
    >
      <span class="font-medium">加载失败</span>
      <span class="ml-2">{{ store.lastError }}</span>
    </div>

    <div
      v-if="digistUnavailable && store.status?.reason"
      class="mt-4 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900"
      role="status"
    >
      {{ store.status.reason }}
    </div>

    <div v-if="actionMessage" class="mt-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800" role="alert">
      {{ actionMessage }}
    </div>

    <section class="mt-8 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
      <StatCard
        label="总条目"
        :value="store.status?.totalItems ?? '-'"
        :icon="icons.items"
        accent-bg="bg-blue-50"
        accent-text="text-blue-600"
      />
      <StatCard
        label="信源数"
        :value="store.status?.totalSources ?? store.sources.length"
        :icon="icons.sources"
        accent-bg="bg-violet-50"
        accent-text="text-violet-600"
      />
      <StatCard
        label="openCLI"
        :value="store.status ? (store.status.openCliAvailable ? '可用' : '不可用') : '-'"
        :icon="icons.openCli"
        :accent-bg="store.status?.openCliAvailable ? 'bg-emerald-50' : 'bg-red-50'"
        :accent-text="store.status?.openCliAvailable ? 'text-emerald-600' : 'text-red-600'"
      />
      <StatCard
        label="Chrome"
        :value="store.status ? (store.status.chromeRunning ? '运行中' : '未运行') : '-'"
        :icon="icons.chrome"
        :accent-bg="store.status?.chromeRunning ? 'bg-emerald-50' : 'bg-neutral-100'"
        :accent-text="store.status?.chromeRunning ? 'text-emerald-600' : 'text-neutral-500'"
      />
    </section>

    <section class="mt-10">
      <div class="flex flex-wrap items-center justify-between gap-3">
        <h2 class="text-base font-semibold text-neutral-900">兴趣</h2>
        <button
          type="button"
          class="rounded-lg bg-neutral-900 px-3 py-1.5 text-sm font-medium text-white transition-colors hover:bg-neutral-700"
          @click="openInterestModal"
        >
          新建兴趣
        </button>
      </div>
      <div class="mt-3 overflow-hidden rounded-xl border border-neutral-200 bg-white shadow-sm">
        <table class="w-full text-sm" :aria-busy="store.loading">
          <thead class="border-b border-neutral-100 bg-neutral-50">
            <tr>
              <th class="px-5 py-3 text-left font-medium text-neutral-500">名称</th>
              <th class="px-5 py-3 text-left font-medium text-neutral-500">用户</th>
              <th class="px-5 py-3 text-left font-medium text-neutral-500">信源</th>
              <th class="px-5 py-3 text-left font-medium text-neutral-500">调度</th>
              <th class="px-5 py-3 text-center font-medium text-neutral-500">条目</th>
              <th class="px-5 py-3 text-left font-medium text-neutral-500">最近爬取 / 同步</th>
              <th class="px-5 py-3 text-center font-medium text-neutral-500">操作</th>
            </tr>
          </thead>
          <tbody class="divide-y divide-neutral-100">
            <tr v-for="row in store.interests" :key="row.id" class="transition-colors hover:bg-neutral-50">
              <td class="px-5 py-3">
                <div class="font-medium text-neutral-900">{{ row.name }}</div>
                <div v-if="row.linkedTopic" class="text-xs text-neutral-400">Topic: {{ row.linkedTopic }}</div>
              </td>
              <td class="px-5 py-3 font-mono text-xs text-neutral-600">{{ row.user }}</td>
              <td class="px-5 py-3 text-neutral-700">{{ row.sources.length }}</td>
              <td class="px-5 py-3 font-mono text-xs text-neutral-600">{{ row.schedule }}</td>
              <td class="px-5 py-3 text-center font-mono text-neutral-800">{{ interestItemSum(row) }}</td>
              <td class="px-5 py-3 text-neutral-600">{{ formatTime(row.lastSync) }}</td>
              <td class="px-5 py-3">
                <div class="flex flex-wrap items-center justify-center gap-2">
                  <button
                    type="button"
                    class="rounded-md bg-neutral-900 px-2.5 py-1 text-xs font-medium text-white transition-colors hover:bg-neutral-700 disabled:opacity-50"
                    :disabled="crawlBusyId === row.id"
                    @click="crawlInterest(row.id)"
                  >
                    {{ crawlBusyId === row.id ? '…' : '爬取' }}
                  </button>
                  <button
                    type="button"
                    class="rounded-md border border-neutral-200 px-2.5 py-1 text-xs font-medium text-neutral-700 transition-colors hover:bg-neutral-50"
                    @click="openSyncModal(row)"
                  >
                    同步 KnowLever
                  </button>
                </div>
              </td>
            </tr>
            <tr v-if="store.interests.length === 0">
              <td colspan="7" class="px-5 py-8 text-center text-neutral-400">
                {{ store.loading ? '加载中…' : '暂无兴趣，点击「新建兴趣」添加' }}
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>

    <section class="mt-10">
      <div class="flex flex-wrap items-center justify-between gap-3">
        <h2 class="text-base font-semibold text-neutral-900">信源</h2>
        <button
          type="button"
          class="rounded-lg bg-neutral-900 px-3 py-1.5 text-sm font-medium text-white transition-colors hover:bg-neutral-700"
          @click="openSourceModal"
        >
          新加信源
        </button>
      </div>
      <div class="mt-3 overflow-hidden rounded-xl border border-neutral-200 bg-white shadow-sm">
        <table class="w-full text-sm" :aria-busy="store.loading">
          <thead class="border-b border-neutral-100 bg-neutral-50">
            <tr>
              <th class="px-5 py-3 text-left font-medium text-neutral-500">平台</th>
              <th class="px-5 py-3 text-left font-medium text-neutral-500">配置</th>
              <th class="px-5 py-3 text-center font-medium text-neutral-500">状态</th>
              <th class="px-5 py-3 text-center font-medium text-neutral-500">条目</th>
              <th class="px-5 py-3 text-left font-medium text-neutral-500">最近爬取</th>
              <th class="px-5 py-3 text-center font-medium text-neutral-500">操作</th>
            </tr>
          </thead>
          <tbody class="divide-y divide-neutral-100">
            <tr v-for="s in store.sources" :key="s.id" class="transition-colors hover:bg-neutral-50">
              <td class="px-5 py-3 font-medium text-neutral-900">{{ s.platform }}</td>
              <td class="max-w-xs truncate px-5 py-3 font-mono text-xs text-neutral-600" :title="JSON.stringify(s.config)">
                {{ configPreview(s.config, 56) }}
              </td>
              <td class="px-5 py-3 text-center">
                <span
                  class="rounded-full px-2 py-0.5 text-xs font-medium"
                  :class="s.enabled ? 'bg-emerald-100 text-emerald-800' : 'bg-neutral-100 text-neutral-500'"
                >
                  {{ s.enabled ? '启用' : '停用' }}
                </span>
              </td>
              <td class="px-5 py-3 text-center font-mono text-neutral-800">{{ s.itemCount }}</td>
              <td class="px-5 py-3 text-neutral-600">{{ formatTime(s.lastCrawl) }}</td>
              <td class="px-5 py-3 text-center">
                <button
                  type="button"
                  class="rounded-md border border-red-200 px-2.5 py-1 text-xs font-medium text-red-600 transition-colors hover:bg-red-50"
                  @click="removeSourceRow(s.id)"
                >
                  删除
                </button>
              </td>
            </tr>
            <tr v-if="store.sources.length === 0">
              <td colspan="6" class="px-5 py-8 text-center text-neutral-400">
                {{ store.loading ? '加载中…' : '暂无信源，点击「新加信源」添加' }}
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>

    <Teleport to="body">
      <div
        v-if="showInterestModal"
        class="fixed inset-0 z-50 flex items-center justify-center bg-black/30 backdrop-blur-sm"
        @click.self="showInterestModal = false"
      >
        <div class="max-h-[90vh] w-full max-w-md overflow-y-auto rounded-2xl bg-white p-6 shadow-xl">
          <h3 class="text-lg font-semibold text-neutral-900">新建兴趣</h3>
          <div class="mt-4 space-y-4">
            <div>
              <label class="text-sm font-medium text-neutral-700">用户</label>
              <input
                v-model="interestDraft.user"
                type="text"
                class="mt-1 w-full rounded-lg border border-neutral-200 px-3 py-2 text-sm focus:border-neutral-900 focus:outline-none focus:ring-1 focus:ring-neutral-900"
                placeholder="admin / useR"
              >
            </div>
            <div>
              <label class="text-sm font-medium text-neutral-700">名称</label>
              <input
                v-model="interestDraft.name"
                type="text"
                class="mt-1 w-full rounded-lg border border-neutral-200 px-3 py-2 text-sm focus:border-neutral-900 focus:outline-none focus:ring-1 focus:ring-neutral-900"
                placeholder="例如 agent-systems"
              >
            </div>
            <div>
              <label class="text-sm font-medium text-neutral-700">调度</label>
              <select
                v-model="interestDraft.schedule"
                class="mt-1 w-full rounded-lg border border-neutral-200 px-3 py-2 text-sm focus:border-neutral-900 focus:outline-none focus:ring-1 focus:ring-neutral-900"
              >
                <option v-for="p in SCHEDULE_PRESETS" :key="p.cron" :value="p.cron">{{ p.label }}</option>
              </select>
            </div>
            <div>
              <label class="text-sm font-medium text-neutral-700">绑定信源</label>
              <p v-if="store.sources.length === 0" class="mt-1 text-xs text-neutral-400">暂无信源，可先创建信源后再编辑兴趣绑定。</p>
              <ul v-else class="mt-2 max-h-40 space-y-2 overflow-y-auto rounded-lg border border-neutral-100 p-2">
                <li v-for="src in store.sources" :key="src.id" class="flex items-center gap-2">
                  <input
                    :id="`src-${src.id}`"
                    type="checkbox"
                    class="rounded border-neutral-300"
                    :checked="interestDraft.sourceIds.includes(src.id)"
                    @change="toggleSourceForInterest(src.id)"
                  >
                  <label :for="`src-${src.id}`" class="text-sm text-neutral-800">{{ src.platform }} · {{ src.id.slice(0, 8) }}…</label>
                </li>
              </ul>
            </div>
            <div>
              <label class="text-sm font-medium text-neutral-700">关联 KnowLever Topic（可选）</label>
              <select
                v-model="interestDraft.linkedTopic"
                class="mt-1 w-full rounded-lg border border-neutral-200 px-3 py-2 text-sm focus:border-neutral-900 focus:outline-none focus:ring-1 focus:ring-neutral-900"
              >
                <option value="">（不关联）</option>
                <option v-for="t in knowLever.topics" :key="t.name" :value="t.name">{{ t.name }}</option>
              </select>
            </div>
          </div>
          <div class="mt-6 flex justify-end gap-2">
            <button
              type="button"
              class="rounded-lg border border-neutral-200 px-4 py-2 text-sm font-medium text-neutral-700 transition-colors hover:bg-neutral-50"
              @click="showInterestModal = false"
            >
              取消
            </button>
            <button
              type="button"
              class="rounded-lg bg-neutral-900 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-neutral-700"
              @click="submitInterest"
            >
              创建
            </button>
          </div>
        </div>
      </div>
    </Teleport>

    <Teleport to="body">
      <div
        v-if="showSourceModal"
        class="fixed inset-0 z-50 flex items-center justify-center bg-black/30 backdrop-blur-sm"
        @click.self="showSourceModal = false"
      >
        <div class="w-full max-w-md rounded-2xl bg-white p-6 shadow-xl">
          <h3 class="text-lg font-semibold text-neutral-900">新加信源</h3>
          <div class="mt-4 space-y-4">
            <div>
              <label class="text-sm font-medium text-neutral-700">平台</label>
              <input
                v-model="sourceDraft.platform"
                type="text"
                class="mt-1 w-full rounded-lg border border-neutral-200 px-3 py-2 text-sm focus:border-neutral-900 focus:outline-none focus:ring-1 focus:ring-neutral-900"
                placeholder="twitter / arxiv / rss …"
              >
            </div>
            <div>
              <label class="text-sm font-medium text-neutral-700">配置 (JSON)</label>
              <textarea
                v-model="sourceDraft.configJson"
                rows="5"
                class="mt-1 w-full rounded-lg border border-neutral-200 px-3 py-2 font-mono text-xs focus:border-neutral-900 focus:outline-none focus:ring-1 focus:ring-neutral-900"
              />
            </div>
          </div>
          <div class="mt-6 flex justify-end gap-2">
            <button
              type="button"
              class="rounded-lg border border-neutral-200 px-4 py-2 text-sm font-medium text-neutral-700 transition-colors hover:bg-neutral-50"
              @click="showSourceModal = false"
            >
              取消
            </button>
            <button
              type="button"
              class="rounded-lg bg-neutral-900 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-neutral-700"
              @click="submitSource"
            >
              添加
            </button>
          </div>
        </div>
      </div>
    </Teleport>

    <Teleport to="body">
      <div
        v-if="showSyncModal"
        class="fixed inset-0 z-50 flex items-center justify-center bg-black/30 backdrop-blur-sm"
        @click.self="showSyncModal = false"
      >
        <div class="w-full max-w-sm rounded-2xl bg-white p-6 shadow-xl">
          <h3 class="text-lg font-semibold text-neutral-900">同步到 KnowLever</h3>
          <p v-if="syncInterest" class="mt-1 text-sm text-neutral-500">兴趣: {{ syncInterest.name }}</p>
          <div class="mt-4">
            <label class="text-sm font-medium text-neutral-700">目标 Topic 名称</label>
            <input
              v-model="syncTopicName"
              type="text"
              class="mt-1 w-full rounded-lg border border-neutral-200 px-3 py-2 text-sm focus:border-neutral-900 focus:outline-none focus:ring-1 focus:ring-neutral-900"
            >
          </div>
          <div class="mt-6 flex justify-end gap-2">
            <button
              type="button"
              class="rounded-lg border border-neutral-200 px-4 py-2 text-sm font-medium text-neutral-700 transition-colors hover:bg-neutral-50"
              @click="showSyncModal = false"
            >
              取消
            </button>
            <button
              type="button"
              class="rounded-lg bg-neutral-900 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-neutral-700 disabled:opacity-50"
              :disabled="syncBusy"
              @click="submitSync"
            >
              {{ syncBusy ? '同步中…' : '开始同步' }}
            </button>
          </div>
        </div>
      </div>
    </Teleport>
  </div>
</template>
