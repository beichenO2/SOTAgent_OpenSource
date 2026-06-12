<script setup lang="ts">
import { onMounted, onUnmounted, ref, computed, watch, nextTick } from 'vue'
import * as d3 from 'd3'
import PageHeader from '@/components/PageHeader.vue'

interface IArchService {
  id: string
  name: string
  status: string
  port: number | null
}

interface IArchFeature {
  name: string
  status: string
}

interface IArchRequirement {
  id: string
  need: string
  features: IArchFeature[]
  blockers: string[]
}

interface IArchInterface {
  name: string
  endpoints?: string[]
  status?: string
}

interface IArchNode {
  id: string
  name: string
  tier: string
  status: string
  description: string
  version: string
  requirements: IArchRequirement[]
  interfaces: IArchInterface[]
  depends_on: string[]
  depended_by: string[]
  services: IArchService[]
}

interface IArchEdge {
  source: string
  target: string
}

interface IInterfaceChange {
  project: string
  interfaceName: string
  changeType: 'added' | 'removed' | 'modified'
  detail: string
  detectedAt: string
}

interface ISimNode extends d3.SimulationNodeDatum {
  id: string
  data: IArchNode
  tierY: number
}

interface ISimLink extends d3.SimulationLinkDatum<ISimNode> {
  source: ISimNode | string
  target: ISimNode | string
}

const nodes = ref<IArchNode[]>([])
const edges = ref<IArchEdge[]>([])
const interfaceChanges = ref<IInterfaceChange[]>([])
const isLoading = ref(false)
const selectedNode = ref<IArchNode | null>(null)
const svgContainer = ref<HTMLDivElement | null>(null)

const TIER_ORDER: Record<string, number> = { infra: 0, knowledge: 1, domain: 2, app: 3 }
const TIER_LABELS: Record<string, string> = { infra: '基础设施', knowledge: '知识层', domain: '领域层', app: '应用层' }
const TIER_COLORS: Record<string, string> = {
  infra: '#6366f1',
  knowledge: '#0ea5e9',
  domain: '#f59e0b',
  app: '#10b981',
}

const totalServices = computed(() => nodes.value.reduce((s, n) => s + n.services.length, 0))
const runningServices = computed(() => nodes.value.reduce((s, n) => s + n.services.filter(sv => sv.status === 'running').length, 0))

async function fetchData() {
  isLoading.value = true
  try {
    const [archRes, changesRes] = await Promise.all([
      fetch(import.meta.env.BASE_URL + 'api/architecture'),
      fetch(import.meta.env.BASE_URL + 'api/interface-changes'),
    ])
    if (archRes.ok) {
      const data = await archRes.json()
      nodes.value = data.nodes ?? []
      edges.value = data.edges ?? []
    }
    if (changesRes.ok) {
      const data = await changesRes.json()
      interfaceChanges.value = data.changes ?? []
    }
  } catch (e) {
    console.error('获取架构数据失败:', e)
  } finally {
    isLoading.value = false
  }
}

function getNodeColor(node: IArchNode): string {
  const hasError = node.services.some(s => s.status === 'error')
  if (hasError) return '#ef4444'
  const hasRunning = node.services.some(s => s.status === 'running')
  if (hasRunning) return TIER_COLORS[node.tier] ?? '#94a3b8'
  return '#cbd5e1'
}

function getStatusDot(status: string): string {
  switch (status) {
    case 'running': return '#22c55e'
    case 'starting': return '#3b82f6'
    case 'error': return '#ef4444'
    case 'stopped': return '#9ca3af'
    default: return '#9ca3af'
  }
}

let simulation: d3.Simulation<ISimNode, ISimLink> | null = null

function renderGraph() {
  if (!svgContainer.value || nodes.value.length === 0) return

  const container = svgContainer.value
  const width = container.clientWidth
  const height = Math.max(600, container.clientHeight)

  d3.select(container).select('svg').remove()

  const svg = d3.select(container)
    .append('svg')
    .attr('width', width)
    .attr('height', height)
    .attr('viewBox', [0, 0, width, height])

  const defs = svg.append('defs')
  defs.append('marker')
    .attr('id', 'arrowhead')
    .attr('viewBox', '0 -5 10 10')
    .attr('refX', 35)
    .attr('refY', 0)
    .attr('markerWidth', 8)
    .attr('markerHeight', 8)
    .attr('orient', 'auto')
    .append('path')
    .attr('d', 'M0,-5L10,0L0,5')
    .attr('fill', '#94a3b8')

  const g = svg.append('g')

  const zoom = d3.zoom<SVGSVGElement, unknown>()
    .scaleExtent([0.3, 3])
    .on('zoom', (event) => g.attr('transform', event.transform))
  svg.call(zoom)

  const tiers = [...new Set(nodes.value.map(n => n.tier))]
    .sort((a, b) => (TIER_ORDER[a] ?? 99) - (TIER_ORDER[b] ?? 99))

  const tierBandHeight = height / (tiers.length || 1)
  const tierY = (tier: string) => {
    const idx = tiers.indexOf(tier)
    return height - (idx + 0.5) * tierBandHeight
  }

  tiers.forEach((tier, i) => {
    const y = height - (i + 1) * tierBandHeight
    g.append('rect')
      .attr('x', 0).attr('y', y)
      .attr('width', width).attr('height', tierBandHeight)
      .attr('fill', i % 2 === 0 ? '#f8fafc' : '#f1f5f9')
      .attr('opacity', 0.5)

    g.append('text')
      .attr('x', 16).attr('y', y + 24)
      .attr('fill', TIER_COLORS[tier] ?? '#94a3b8')
      .attr('font-size', '13px')
      .attr('font-weight', '600')
      .attr('opacity', 0.7)
      .text(TIER_LABELS[tier] ?? tier)
  })

  const simNodes: ISimNode[] = nodes.value.map(n => ({
    id: n.id,
    data: n,
    tierY: tierY(n.tier),
    x: width / 2 + (Math.random() - 0.5) * width * 0.6,
    y: tierY(n.tier) + (Math.random() - 0.5) * tierBandHeight * 0.4,
  }))

  const nodeMap = new Map(simNodes.map(n => [n.id, n]))
  const simLinks: ISimLink[] = edges.value
    .filter(e => nodeMap.has(e.source) && nodeMap.has(e.target))
    .map(e => ({ source: e.source, target: e.target }))

  simulation = d3.forceSimulation(simNodes)
    .force('link', d3.forceLink<ISimNode, ISimLink>(simLinks).id(d => d.id).distance(160).strength(0.3))
    .force('charge', d3.forceManyBody().strength(-400))
    .force('x', d3.forceX(width / 2).strength(0.05))
    .force('y', d3.forceY<ISimNode>(d => d.tierY).strength(0.6))
    .force('collision', d3.forceCollide(50))

  const link = g.append('g')
    .selectAll('line')
    .data(simLinks)
    .join('line')
    .attr('stroke', '#cbd5e1')
    .attr('stroke-width', 1.5)
    .attr('stroke-dasharray', '6,3')
    .attr('marker-end', 'url(#arrowhead)')

  const node = g.append('g')
    .selectAll<SVGGElement, ISimNode>('g')
    .data(simNodes)
    .join('g')
    .attr('cursor', 'pointer')
    .call(d3.drag<SVGGElement, ISimNode>()
      .on('start', (event, d) => {
        if (!event.active) simulation?.alphaTarget(0.3).restart()
        d.fx = d.x; d.fy = d.y
      })
      .on('drag', (event, d) => { d.fx = event.x; d.fy = event.y })
      .on('end', (event, d) => {
        if (!event.active) simulation?.alphaTarget(0)
        d.fx = null; d.fy = null
      }))

  node.append('circle')
    .attr('r', 28)
    .attr('fill', d => getNodeColor(d.data))
    .attr('stroke', '#fff')
    .attr('stroke-width', 2.5)
    .attr('filter', 'drop-shadow(0 2px 4px rgba(0,0,0,0.1))')

  node.append('text')
    .attr('dy', 1)
    .attr('text-anchor', 'middle')
    .attr('font-size', '10px')
    .attr('font-weight', '600')
    .attr('fill', '#fff')
    .text(d => {
      const name = d.data.name
      return name.length > 8 ? name.slice(0, 7) + '…' : name
    })

  node.append('text')
    .attr('dy', 46)
    .attr('text-anchor', 'middle')
    .attr('font-size', '11px')
    .attr('font-weight', '500')
    .attr('fill', '#334155')
    .text(d => d.data.name)

  node.filter(d => d.data.services.length > 0)
    .append('circle')
    .attr('cx', 20).attr('cy', -20)
    .attr('r', 9)
    .attr('fill', d => d.data.services.some(s => s.status === 'error') ? '#ef4444' : '#22c55e')
    .attr('stroke', '#fff')
    .attr('stroke-width', 1.5)

  node.filter(d => d.data.services.length > 0)
    .append('text')
    .attr('x', 20).attr('y', -16)
    .attr('text-anchor', 'middle')
    .attr('font-size', '9px')
    .attr('font-weight', '700')
    .attr('fill', '#fff')
    .text(d => String(d.data.services.filter(s => s.status === 'running').length))

  node.on('click', (_event, d) => {
    selectedNode.value = d.data
  })

  simulation.on('tick', () => {
    link
      .attr('x1', d => (d.source as ISimNode).x!)
      .attr('y1', d => (d.source as ISimNode).y!)
      .attr('x2', d => (d.target as ISimNode).x!)
      .attr('y2', d => (d.target as ISimNode).y!)

    node.attr('transform', d => `translate(${d.x},${d.y})`)
  })
}

function closePanel() {
  selectedNode.value = null
}

onMounted(async () => {
  await fetchData()
  await nextTick()
  renderGraph()
})

watch([nodes, edges], async () => {
  await nextTick()
  renderGraph()
})

onUnmounted(() => {
  simulation?.stop()
})
</script>

<template>
  <div>
    <PageHeader
      title="架构总览"
      :description="`${nodes.length} 个项目 · ${totalServices} 个服务（${runningServices} 运行中）· ${interfaceChanges.length} 项接口变更`"
    >
      <template #actions>
        <button
          class="rounded-lg border border-neutral-200 bg-white px-4 py-2 text-sm font-medium text-neutral-700 transition-colors hover:bg-neutral-50"
          :disabled="isLoading"
          @click="fetchData()"
        >{{ isLoading ? '刷新中...' : '刷新' }}</button>
      </template>
    </PageHeader>

    <div v-if="isLoading && nodes.length === 0" class="mt-8 text-center text-sm text-neutral-400">
      加载中...
    </div>

    <!-- Topology Graph -->
    <div class="relative mt-6">
      <div
        ref="svgContainer"
        class="w-full rounded-xl border border-neutral-200 bg-white shadow-sm"
        :style="{ height: '600px' }"
      />

      <!-- Legend -->
      <div class="absolute bottom-4 left-4 flex flex-wrap gap-3 rounded-lg border border-neutral-200 bg-white/90 px-4 py-2.5 text-xs backdrop-blur">
        <div v-for="(color, tier) in TIER_COLORS" :key="tier" class="flex items-center gap-1.5">
          <span class="inline-block h-3 w-3 rounded-full" :style="{ backgroundColor: color }" />
          <span class="text-neutral-600">{{ TIER_LABELS[tier] ?? tier }}</span>
        </div>
        <div class="flex items-center gap-1.5">
          <span class="inline-block h-3 w-3 rounded-full bg-neutral-300" />
          <span class="text-neutral-600">无服务</span>
        </div>
        <div class="flex items-center gap-1.5">
          <span class="inline-block h-3 w-3 rounded-full bg-red-500" />
          <span class="text-neutral-600">异常</span>
        </div>
      </div>
    </div>

    <!-- Interface Changes Alert -->
    <section v-if="interfaceChanges.length > 0" class="mt-6">
      <div class="rounded-xl border border-amber-200 bg-amber-50 p-4">
        <h3 class="flex items-center gap-2 text-sm font-semibold text-amber-800">
          <svg class="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
          </svg>
          接口变更预警（{{ interfaceChanges.length }} 项）
        </h3>
        <div class="mt-3 space-y-1.5">
          <div
            v-for="(change, i) in interfaceChanges.slice(0, 10)"
            :key="i"
            class="flex items-center gap-2 text-xs"
          >
            <span
              class="inline-flex shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-medium leading-none"
              :class="{
                'bg-green-100 text-green-700': change.changeType === 'added',
                'bg-red-100 text-red-700': change.changeType === 'removed',
                'bg-amber-100 text-amber-700': change.changeType === 'modified',
              }"
            >{{ change.changeType === 'added' ? '新增' : change.changeType === 'removed' ? '移除' : '变更' }}</span>
            <span class="font-medium text-neutral-700">{{ change.project }}</span>
            <span class="text-neutral-400">·</span>
            <span class="text-neutral-600">{{ change.interfaceName }}</span>
            <span class="ml-auto truncate text-neutral-400">{{ change.detail }}</span>
          </div>
        </div>
      </div>
    </section>

    <!-- Detail Panel (Slide-over) -->
    <Transition name="slide">
      <div
        v-if="selectedNode"
        class="fixed inset-y-0 right-0 z-50 flex w-96 flex-col border-l border-neutral-200 bg-white shadow-xl"
      >
        <div class="flex items-center justify-between border-b border-neutral-100 px-5 py-4">
          <div>
            <h2 class="text-lg font-semibold text-neutral-900">{{ selectedNode.name }}</h2>
            <div class="mt-0.5 flex items-center gap-2 text-xs text-neutral-500">
              <span
                class="rounded-full px-2 py-0.5 text-[10px] font-medium"
                :style="{ backgroundColor: TIER_COLORS[selectedNode.tier] + '20', color: TIER_COLORS[selectedNode.tier] }"
              >{{ TIER_LABELS[selectedNode.tier] ?? selectedNode.tier }}</span>
              <span>v{{ selectedNode.version }}</span>
            </div>
          </div>
          <button class="rounded-lg p-1.5 text-neutral-400 hover:bg-neutral-100 hover:text-neutral-600" @click="closePanel">
            <svg class="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div class="flex-1 overflow-y-auto px-5 py-4">
          <p class="text-xs leading-relaxed text-neutral-500">{{ selectedNode.description }}</p>

          <!-- Services -->
          <div v-if="selectedNode.services.length > 0" class="mt-5">
            <h3 class="text-xs font-semibold uppercase tracking-wider text-neutral-400">服务</h3>
            <div class="mt-2 space-y-1.5">
              <div
                v-for="svc in selectedNode.services"
                :key="svc.id"
                class="flex items-center gap-2 rounded-lg bg-neutral-50 px-3 py-2 text-xs"
              >
                <span class="inline-flex h-2 w-2 shrink-0 rounded-full" :style="{ backgroundColor: getStatusDot(svc.status) }" />
                <span class="font-medium text-neutral-700">{{ svc.name }}</span>
                <span v-if="svc.port" class="ml-auto font-mono text-neutral-400">:{{ svc.port }}</span>
              </div>
            </div>
          </div>

          <!-- Dependencies -->
          <div v-if="selectedNode.depends_on.length > 0" class="mt-5">
            <h3 class="text-xs font-semibold uppercase tracking-wider text-neutral-400">依赖</h3>
            <div class="mt-2 flex flex-wrap gap-1.5">
              <span v-for="dep in selectedNode.depends_on" :key="dep" class="rounded-full bg-indigo-50 px-2.5 py-1 text-xs font-medium text-indigo-600">
                {{ dep }}
              </span>
            </div>
          </div>
          <div v-if="selectedNode.depended_by.length > 0" class="mt-3">
            <h3 class="text-xs font-semibold uppercase tracking-wider text-neutral-400">被依赖</h3>
            <div class="mt-2 flex flex-wrap gap-1.5">
              <span v-for="dep in selectedNode.depended_by" :key="dep" class="rounded-full bg-emerald-50 px-2.5 py-1 text-xs font-medium text-emerald-600">
                {{ dep }}
              </span>
            </div>
          </div>

          <!-- Interfaces -->
          <div v-if="selectedNode.interfaces.length > 0" class="mt-5">
            <h3 class="text-xs font-semibold uppercase tracking-wider text-neutral-400">接口</h3>
            <div class="mt-2 space-y-2">
              <div v-for="iface in selectedNode.interfaces" :key="iface.name" class="rounded-lg border border-neutral-100 bg-neutral-50 p-3">
                <div class="flex items-center justify-between">
                  <span class="text-xs font-medium text-neutral-700">{{ iface.name }}</span>
                  <span
                    v-if="iface.status"
                    class="rounded-full px-1.5 py-0.5 text-[10px] font-medium"
                    :class="iface.status === 'done' ? 'bg-emerald-100 text-emerald-700' : 'bg-amber-100 text-amber-700'"
                  >{{ iface.status }}</span>
                </div>
                <div v-if="iface.endpoints?.length" class="mt-1.5 space-y-0.5">
                  <code v-for="ep in iface.endpoints" :key="ep" class="block text-[10px] text-neutral-500">{{ ep }}</code>
                </div>
              </div>
            </div>
          </div>

          <!-- Requirements -->
          <div v-if="selectedNode.requirements.length > 0" class="mt-5">
            <h3 class="text-xs font-semibold uppercase tracking-wider text-neutral-400">需求</h3>
            <div class="mt-2 space-y-2">
              <div v-for="req in selectedNode.requirements" :key="req.id" class="rounded-lg border border-neutral-100 p-3">
                <div class="text-xs font-medium text-neutral-700">{{ req.id }}: {{ req.need }}</div>
                <div class="mt-1.5 flex flex-wrap gap-1">
                  <span
                    v-for="feat in req.features"
                    :key="feat.name"
                    class="rounded-full px-2 py-0.5 text-[10px] font-medium"
                    :class="feat.status === 'done' ? 'bg-emerald-100 text-emerald-700' : 'bg-amber-100 text-amber-700'"
                  >{{ feat.name }}</span>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </Transition>
    <div v-if="selectedNode" class="fixed inset-0 z-40 bg-black/20" @click="closePanel" />
  </div>
</template>

<style scoped>
.slide-enter-active,
.slide-leave-active {
  transition: transform 0.25s ease;
}
.slide-enter-from,
.slide-leave-to {
  transform: translateX(100%);
}
</style>
