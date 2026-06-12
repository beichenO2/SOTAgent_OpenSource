import { z } from 'zod';

// ─── 通用 ───────────────────────────────────────────────

export type DeviceId = string;
export type ProjectId = string;
export type AssetId = string;

// ─── 技术资产类型 ───────────────────────────────────────

export const assetTypes = ['skill', 'architecture', 'workflow', 'config', 'methodology', 'framework', 'pattern'] as const;
export type AssetType = (typeof assetTypes)[number];

export const syncLevels = ['auto', 'suggest', 'manual'] as const;
export type SyncLevel = (typeof syncLevels)[number];

export const syncActions = ['synced', 'suggested', 'rejected', 'self-evolved', 'pending'] as const;
export type SyncAction = (typeof syncActions)[number];

// ─── 资源调度类型 ────────────────────────────────────────

export const taskStatuses = ['queued', 'running', 'paused', 'done', 'failed'] as const;
export type TaskStatus = (typeof taskStatuses)[number];

export const confidenceLevels = ['low', 'medium', 'high'] as const;
export type ConfidenceLevel = (typeof confidenceLevels)[number];

// ─── inbox 消息 schema ──────────────────────────────────

export const inboxMessageTypes = ['sync_request', 'resource_request', 'status_query', 'sync_response', 'port_request', 'port_release', 'service_forward', 'lesson_register'] as const;
export type InboxMessageType = (typeof inboxMessageTypes)[number];

export const syncRequestPayloadSchema = z.object({
  asset_type: z.enum(assetTypes),
  asset_id: z.string().optional(),
  asset_path: z.string(),
  change_summary: z.string(),
});

export const resourceRequestPayloadSchema = z.object({
  task_type: z.string(),
  command: z.string(),
  estimated_duration: z.string().optional(),
  priority: z.enum(['low', 'normal', 'high']).default('low'),
  checkpoint_support: z.boolean().default(false),
  checkpoint_path: z.string().optional(),
});

export const statusQueryPayloadSchema = z.object({
  query_type: z.enum(['task_status', 'resource_usage', 'sync_status', 'all']),
  task_id: z.string().optional(),
});

export const syncResponsePayloadSchema = z.object({
  asset_id: z.string(),
  action: z.enum(['self-evolved', 'needs-user-intervention']),
  details: z.string().optional(),
});

export const portRequestPayloadSchema = z.object({
  service_name: z.string(),
  preferred_port: z.number().optional(),
  port_range_start: z.number().default(3000),
  port_range_end: z.number().default(9999),
});

export const portReleasePayloadSchema = z.object({
  port: z.number(),
});

export const serviceForwardPayloadSchema = z.object({
  service_id: z.string(),
  action: z.enum(['start', 'stop', 'restart', 'status']),
  params: z.record(z.unknown()).optional(),
});

export const lessonRegisterPayloadSchema = z.object({
  title: z.string(),
  file_path: z.string(),
  tags: z.array(z.string()),
  applicable_when: z.string(),
});

export const inboxMessageSchema = z.object({
  id: z.string().optional(),
  type: z.enum(inboxMessageTypes),
  from: z.string(),
  to: z.string().optional(),
  device: z.string(),
  project: z.string(),
  timestamp: z.string(),
  correlation_id: z.string().optional(),
  ttl: z.number().optional(),
  payload: z.union([
    syncRequestPayloadSchema,
    resourceRequestPayloadSchema,
    statusQueryPayloadSchema,
    syncResponsePayloadSchema,
    portRequestPayloadSchema,
    portReleasePayloadSchema,
    serviceForwardPayloadSchema,
    lessonRegisterPayloadSchema,
  ]),
});

export type IInboxMessage = z.infer<typeof inboxMessageSchema>;
export type ISyncRequestPayload = z.infer<typeof syncRequestPayloadSchema>;
export type IResourceRequestPayload = z.infer<typeof resourceRequestPayloadSchema>;
export type IStatusQueryPayload = z.infer<typeof statusQueryPayloadSchema>;
export type ISyncResponsePayload = z.infer<typeof syncResponsePayloadSchema>;
export type IPortRequestPayload = z.infer<typeof portRequestPayloadSchema>;
export type IPortReleasePayload = z.infer<typeof portReleasePayloadSchema>;
export type IServiceForwardPayload = z.infer<typeof serviceForwardPayloadSchema>;
export type ILessonRegisterPayload = z.infer<typeof lessonRegisterPayloadSchema>;

// ─── 设备角色 ─────────────────────────────────────────────

export type DeviceRole = 'dev' | 'compute' | 'both';

export interface IDeviceConfig {
  device_id: string;
  display_name: string;
  tailscale_ip: string | null;
  role: DeviceRole;
  is_local: boolean;
  capabilities: string[];
  last_seen: string | null;
}

// ─── outbox 回复 ────────────────────────────────────────

export interface IOutboxResponse {
  id: string;
  in_reply_to?: string;
  correlation_id?: string;
  type: 'sync_notification' | 'resource_update' | 'status_report' | 'evolution_request' | 'port_assignment' | 'port_released';
  from?: string;
  to_project: string;
  to_agent?: string;
  timestamp: string;
  payload: Record<string, unknown>;
}

// ─── 设备描述 ────────────────────────────────────────────

export interface IDeviceProfile {
  device_id: string;
  hostname: string;
  chip: string;
  total_mem_gb: number;
  os_version: string;
  last_seen: string;
}

// ─── 配置 ────────────────────────────────────────────────

export interface IDeviceConfigEntry {
  display_name: string;
  role: DeviceRole;
  capabilities: string[];
  /** SSH 登录用户名（默认与本机 os.userInfo().username 相同） */
  ssh_user?: string;
}

export interface ISOTAgentConfig {
  version: number;
  sentinel: {
    poll_interval_sec: number;
    use_fswatch: boolean;
  };
  resource_monitor: {
    interval_sec: number;
    cpu_idle_threshold: number;
    mem_idle_threshold_percent: number;
  };
  sync: {
    auto_sync_types: AssetType[];
    suggest_sync_types: AssetType[];
  };
  scheduler: {
    max_concurrent_heavy_tasks: number;
    pause_on_cpu_above: number;
    pause_on_mem_above_percent: number;
  };
  devices?: Record<string, IDeviceConfigEntry>;
  polar_private?: {
    base_url: string;
    auto_sync?: {
      enabled: boolean;
      interval_minutes: number;
    };
  };
  process_manager?: {
    health_check_interval_sec: number;
    auto_start_delay_sec: number;
    max_restart_attempts: number;
    restart_cooldown_sec: number;
    /** Minutes between restart_count decay ticks (default 30) */
    restart_decay_min?: number;
    /** Seconds to wait after start before checking port binding (default 30) */
    startup_grace_sec?: number;
  };
  /** Seconds to wait after last code change before triggering auto-restart (default 7200 = 2h) */
  silent_restart_window_sec?: number;
  peer_sync?: IPeerSyncConfig;
  security?: {
    bind_host?: string;
    auth_token_env?: string;
    public_routes?: string[];
  };
  built_in_services?: IBuiltInServiceDef[];
}

export interface IBuiltInServiceDef {
  id: string;
  name: string;
  command: string;
  work_dir?: string;
  port?: number;
  health_check_url?: string;
  auto_start?: boolean;
  restart_on_failure?: boolean;
  max_restarts?: number;
  cron_schedule?: string | null;
  /** Path to the Start/ script directory (enables script orchestration mode) */
  script_dir?: string;
  /** Custom start script filename within script_dir (default: start.sh) */
  start_script_name?: string;
}

// ─── 资源快照 ────────────────────────────────────────────

export interface IResourceSnapshot {
  timestamp: string;
  device_id: string;
  cpu_percent: number;
  mem_used_mb: number;
  mem_total_mb: number;
  mem_percent: number;
  gpu_mem_used_mb?: number;
  /** macOS kern.memorystatus_vm_pressure_level: 1=NORMAL, 2=WARN, 4=CRITICAL */
  mem_pressure_level?: 1 | 2 | 4;
  /** macOS kern.memorystatus_level: 0-100, higher = more available */
  mem_availability?: number;
  /** loadavg[0] / cpuCount — <1.0 spare capacity, >2.0 contention */
  cpu_load_ratio?: number;
}

/** System pressure summary for scheduler decisions */
export interface IPressureState {
  mem_pressure: 'normal' | 'warn' | 'critical';
  mem_availability: number;
  cpu_load_ratio: number;
  under_pressure: boolean;
  idle: boolean;
}

// ─── 跨设备感知 (PeerSync) ───────────────────────────────

export interface IProjectGitState {
  project: string;
  path: string;
  branch: string;
  headHash: string;
  hasUncommitted: boolean;
  /** 未提交文件列表（相对路径），用于文件级冲突检测 */
  uncommittedFiles: string[];
  unpushedCount: number;
  remoteAhead: number;
  lastActivityTs: string;
}

export interface IPeerHeartbeat {
  deviceId: string;
  timestamp: string;
  projects: IProjectGitState[];
  activeProject?: string;
}

export type PeerNotifyType = 'push_completed' | 'conflict_warning' | 'work_started' | 'port_conflict' | 'circuit_breaker_tripped';

export interface IPeerNotification {
  type: PeerNotifyType;
  deviceId: string;
  project: string;
  timestamp: string;
  detail?: string;
}

export interface IPeerSyncConfig {
  enabled: boolean;
  heartbeat_interval_sec: number;
  auto_pull_on_clean: boolean;
  scan_root: string;
  alert_on_conflict: boolean;
  auto_commit_and_push?: boolean;
  peer_secret_env?: string;
  /**
   * 全局忽略模式列表，作用于所有项目。
   * 语法同 .gitignore（支持 * ** ? 通配符，# 注释，目录前缀匹配）。
   * 每个项目也可在根目录放 .peersyncignore 文件做项目级忽略。
   */
  global_ignore?: string[];
  /**
   * 项目白名单（目录名列表）。
   * 非空时采用白名单模式：只有列表内的项目参与 PeerSync 同步，其余全部忽略。
   * 为空或不设置时，扫描 scan_root 下所有项目（黑名单模式）。
   */
  project_whitelist?: string[];
  /**
   * 大文件 rsync 同步配置。
   * git 只同步可追踪文件，超过 GitHub 限制的大文件通过 rsync over SSH 自动同步。
   * 每次 git push 后触发（推送方 rsync TO 对端），每次 git pull 后触发（拉取方 rsync FROM 对端）。
   */
  rsync_large_files?: {
    enabled: boolean;
    /** SSH 端口，默认 22 */
    ssh_port?: number;
    /** rsync 额外排除模式（在 .git/ node_modules/ 之外） */
    exclude_patterns?: string[];
    /** 带宽限制 KB/s，0 表示不限制 */
    bandwidth_limit_kbps?: number;
  };
}


// ─── 龙虾事件总线 ─────────────────────────────────────────

export const lobsterEventTypes = ['bug', 'digest_report', 'contract_red', 'git_push_main', 'scheduled_health_scan'] as const;
export type LobsterEventType = (typeof lobsterEventTypes)[number];

export const lobsterSeverities = ['info', 'warn', 'error', 'critical'] as const;
export type LobsterSeverity = (typeof lobsterSeverities)[number];

export const lobsterEventSchema = z.object({
  ts: z.string().optional(),
  type: z.enum(lobsterEventTypes),
  source_project: z.string().min(1),
  target_project: z.string().optional(),
  severity: z.enum(lobsterSeverities).default('info'),
  payload: z.record(z.unknown()).default({}),
  dedup_key: z.string().optional(),
});

export type ILobsterEvent = z.infer<typeof lobsterEventSchema>;

export interface ILobsterEventStored extends ILobsterEvent {
  ts: string;
  id: string;
}

// ─── 熔断器类型 ────────────────────────────────────────────

export type CircuitBreakerState = 'closed' | 'open' | 'half_open';

export interface ICircuitBreakerStatus {
  serviceId: string;
  serviceName: string;
  state: CircuitBreakerState;
  consecutiveFailures: number;
  lastFailureAt: string | null;
  lastFailureReason: string | null;
  trippedAt: string | null;
  /** half_open 后下次自动重试的时间 */
  nextRetryAt: string | null;
}

export interface ICircuitBreakerEvent {
  serviceId: string;
  serviceName: string;
  eventType: 'port_conflict' | 'start_failed' | 'breaker_tripped' | 'breaker_reset' | 'breaker_half_open';
  detail: string;
  occupantPid?: number;
  occupantCommand?: string;
  port?: number;
  timestamp: string;
}

export interface IConflictAlert {
  project: string;
  type: 'both_uncommitted' | 'local_behind_with_changes' | 'diverged' | 'diverged_with_changes';
  localState: IProjectGitState;
  peerState: IProjectGitState;
  detectedAt: string;
  /** 文件级冲突分析：两端修改文件是否有重叠 */
  fileOverlap?: {
    hasOverlap: boolean;
    overlappingFiles: string[];
    localOnlyFiles: string[];
    peerOnlyFiles: string[];
  };
}
