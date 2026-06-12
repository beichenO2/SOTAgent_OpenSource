import { createRouter, createWebHashHistory } from 'vue-router'

const router = createRouter({
  history: createWebHashHistory(),
  routes: [
    {
      path: '/',
      redirect: '/ports',
    },
    {
      path: '/repos',
      component: () => import('@/views/ReposView.vue'),
    },
    {
      path: '/ports',
      component: () => import('@/views/PortsView.vue'),
    },
    {
      path: '/services',
      component: () => import('@/views/ServicesView.vue'),
    },
    {
      path: '/sandbox',
      redirect: '/services',
    },
    {
      path: '/funnel',
      component: () => import('@/views/FunnelView.vue'),
    },
    {
      path: '/architecture',
      component: () => import('@/views/ArchitectureView.vue'),
    },
    {
      path: '/costs',
      component: () => import('@/views/CostView.vue'),
    },
    {
      path: '/resources',
      component: () => import('@/views/ResourceView.vue'),
    },
    {
      path: '/assets',
      component: () => import('@/views/AssetsView.vue'),
    },
    // TODO: Agent 页面尚未完成，暂时隐藏路由。完成后取消注释恢复。
    // {
    //   path: '/agent',
    //   component: () => import('@/views/AgentView.vue'),
    // },
    {
      path: '/knowlever',
      component: () => import('@/views/KnowLeverView.vue'),
    },
    {
      path: '/digist',
      component: () => import('@/views/DiGistView.vue'),
    },
    {
      path: '/rate-limits',
      component: () => import('@/views/RateLimitView.vue'),
    },
  ],
})

export default router
