export interface IRepoStatus {
  name: string
  path: string
  branch: string
  syncStatus: 'synced' | 'ahead' | 'behind' | 'diverged' | 'no_remote'
  ahead: number
  behind: number
  dirty: number
  remote: string
  lastChecked: string
}

export interface IPortEntry {
  port: number
  service: string
  project: string
  protocol: 'http' | 'ws' | 'tcp'
  description: string
}

export interface IProjectInfo {
  name: string
  description: string
  techStack: string[]
  hasWebUI: boolean
  port?: number
  repo: string
  category: string
}

export interface IScanResult {
  repos: IRepoStatus[]
  ports: IPortEntry[]
  scannedAt: string
}

// ─── 服务进程管理 ──────────────────────────────────────

export type ServiceStatus = 'stopped' | 'starting' | 'running' | 'error'

export interface IProcessStatus {
  id: string
  name: string
  status: ServiceStatus
  pid: number | null
  port: number | null
  device_id: string
  auto_start: boolean
  restart_count: number
  max_restarts: number
  started_at: string | null
  last_health_check: string | null
  is_local: boolean
  remote_device?: string
  last_exit_code?: number | null
  last_error?: string | null
  pid_verified?: boolean
}

export interface IDeviceInfo {
  device_id: string
  display_name: string
  tailscale_ip: string | null
  role: string
  is_local: number
  capabilities: string | null
  last_seen: string | null
}

// ─── Tailscale Funnel ────────────────────────────────────

export interface IFunnelHandler {
  path: string
  proxy: string
}

export interface IFunnelDomain {
  domain: string
  port: number
  isFunnel: boolean
  handlers: IFunnelHandler[]
}

export interface IFunnelStatus {
  domains: IFunnelDomain[]
  raw: Record<string, unknown>
}

// ─── KnowLever 流水线 ────────────────────────────────

export type KnowLeverPipelineStep =
  | 'idle'
  | 'ingest'
  | 'compile'
  | 'build'
  | 'autooffice:pptx'
  | 'autooffice:pdf'
  | 'site:enhanced'
  | 'done'
  | 'error'

export type KnowLeverOutputFormat = 'html' | 'pptx' | 'pdf' | 'enhanced'

