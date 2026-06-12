/**
 * SOTAgent SQLite 数据层
 *
 * 两个数据库：
 * - registry.sqlite: 技术资产注册表 + 订阅关系 + 同步日志
 * - resources.sqlite: 资源画像 + 重任务队列 + 共享服务 + 资源快照
 *
 * 每个设备维护自己的本地副本（~/.sotagent/data/）。
 * 跨设备同步通过 GitHub 进行，SQLite 文件不参与同步。
 */

import Database from 'better-sqlite3';
import path from 'node:path';
import fs from 'node:fs';
import { execSync as execSyncFn } from 'node:child_process';
import { nanoid } from 'nanoid';
import type {
  AssetType, SyncLevel, SyncAction, TaskStatus,
  ConfidenceLevel, IResourceSnapshot,
} from './types.js';

// ─── 路径 ────────────────────────────────────────────────

const DATA_DIR = path.join(import.meta.dirname, '..', 'data');

function ensureDataDir(): void {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

// ─── Registry DB ─────────────────────────────────────────

const REGISTRY_DDL = `
CREATE TABLE IF NOT EXISTS tech_assets (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL CHECK(type IN ('skill','architecture','workflow','config','methodology','framework','pattern')),
  canonical_path TEXT NOT NULL,
  version INTEGER DEFAULT 1,
  content_hash TEXT,
  updated_at TEXT DEFAULT (datetime('now')),
  updated_by TEXT
);

CREATE TABLE IF NOT EXISTS subscriptions (
  project_id TEXT NOT NULL,
  asset_id TEXT NOT NULL,
  sync_level TEXT DEFAULT 'auto' CHECK(sync_level IN ('auto','suggest','manual')),
  project_path TEXT NOT NULL,
  PRIMARY KEY (project_id, asset_id),
  FOREIGN KEY (asset_id) REFERENCES tech_assets(id)
);

CREATE TABLE IF NOT EXISTS sync_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  asset_id TEXT,
  from_project TEXT,
  to_project TEXT,
  action TEXT CHECK(action IN ('synced','suggested','rejected','self-evolved','pending')),
  diff_summary TEXT,
  timestamp TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_sync_log_asset ON sync_log(asset_id);
CREATE INDEX IF NOT EXISTS idx_sync_log_time ON sync_log(timestamp);
CREATE INDEX IF NOT EXISTS idx_subs_project ON subscriptions(project_id);
CREATE INDEX IF NOT EXISTS idx_subs_asset ON subscriptions(asset_id);

CREATE TABLE IF NOT EXISTS interface_snapshots (
  project TEXT NOT NULL,
  interface_name TEXT NOT NULL,
  endpoints_json TEXT NOT NULL,
  status TEXT DEFAULT 'unknown',
  snapshot_at TEXT DEFAULT (datetime('now')),
  PRIMARY KEY (project, interface_name)
);
`;

// ─── Resources DB ────────────────────────────────────────

const RESOURCES_DDL = `
CREATE TABLE IF NOT EXISTS resource_profiles (
  task_type TEXT PRIMARY KEY,
  avg_cpu_percent REAL DEFAULT 0,
  peak_cpu_percent REAL DEFAULT 0,
  avg_mem_mb REAL DEFAULT 0,
  peak_mem_mb REAL DEFAULT 0,
  gpu_mem_mb REAL DEFAULT 0,
  avg_duration_sec INTEGER DEFAULT 0,
  sample_count INTEGER DEFAULT 0,
  confidence TEXT DEFAULT 'low' CHECK(confidence IN ('low','medium','high')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS heavy_tasks (
  id TEXT PRIMARY KEY,
  requester TEXT NOT NULL,
  task_type TEXT NOT NULL,
  command TEXT NOT NULL,
  priority INTEGER DEFAULT 0,
  status TEXT DEFAULT 'queued' CHECK(status IN ('queued','running','paused','done','failed')),
  progress_percent REAL DEFAULT 0,
  estimated_duration_sec INTEGER,
  actual_start TEXT,
  actual_end TEXT,
  checkpoint_path TEXT,
  pid INTEGER,
  created_at TEXT DEFAULT (datetime('now')),
  notified_eta TEXT,
  callback_url TEXT,
  source_path TEXT,
  output_dir TEXT
);

CREATE TABLE IF NOT EXISTS shared_services (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  command TEXT NOT NULL,
  work_dir TEXT,
  mem_requirement_mb REAL DEFAULT 0,
  gpu_mem_requirement_mb REAL DEFAULT 0,
  status TEXT DEFAULT 'stopped' CHECK(status IN ('stopped','starting','running','error')),
  pid INTEGER,
  port INTEGER,
  device_id TEXT NOT NULL DEFAULT 'any',
  auto_start INTEGER DEFAULT 0,
  restart_on_failure INTEGER DEFAULT 0,
  max_restarts INTEGER DEFAULT 30,
  restart_count INTEGER DEFAULT 0,
  started_at TEXT,
  last_used TEXT,
  last_health_check TEXT,
  health_check_url TEXT,
  cron_schedule TEXT
);

-- Enforce: no two services may claim the same non-null port
CREATE UNIQUE INDEX IF NOT EXISTS idx_shared_services_port_unique
  ON shared_services(port) WHERE port IS NOT NULL;

CREATE TABLE IF NOT EXISTS device_config (
  device_id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  tailscale_ip TEXT,
  role TEXT DEFAULT 'dev' CHECK(role IN ('dev','compute','both')),
  is_local INTEGER DEFAULT 0,
  capabilities TEXT,
  last_seen TEXT
);

CREATE TABLE IF NOT EXISTS service_queue (
  id TEXT PRIMARY KEY,
  service_id TEXT NOT NULL,
  requester TEXT NOT NULL,
  project TEXT NOT NULL,
  request_payload TEXT,
  priority INTEGER DEFAULT 0,
  status TEXT DEFAULT 'queued' CHECK(status IN ('queued','processing','done','failed')),
  position INTEGER DEFAULT 0,
  estimated_wait_sec INTEGER,
  created_at TEXT DEFAULT (datetime('now')),
  completed_at TEXT,
  FOREIGN KEY (service_id) REFERENCES shared_services(id)
);

CREATE TABLE IF NOT EXISTS resource_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  device_id TEXT NOT NULL,
  cpu_percent REAL NOT NULL,
  mem_used_mb REAL NOT NULL,
  mem_total_mb REAL NOT NULL,
  mem_percent REAL NOT NULL,
  gpu_mem_used_mb REAL,
  mem_pressure_level INTEGER,
  mem_availability INTEGER,
  cpu_load_ratio REAL,
  timestamp TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS port_registry (
  port INTEGER PRIMARY KEY,
  service_name TEXT NOT NULL,
  project TEXT NOT NULL,
  device_id TEXT NOT NULL,
  allocated_at TEXT DEFAULT (datetime('now')),
  last_verified TEXT DEFAULT (datetime('now')),
  status TEXT DEFAULT 'active' CHECK(status IN ('active','released','stale'))
);

CREATE TABLE IF NOT EXISTS capability_registry (
  id TEXT PRIMARY KEY,
  project TEXT NOT NULL,
  service_name TEXT NOT NULL,
  version TEXT NOT NULL DEFAULT '0.1.0',
  transport TEXT NOT NULL DEFAULT 'http' CHECK(transport IN ('http','cli','mcp','function')),
  endpoint TEXT,
  method TEXT DEFAULT 'POST',
  description TEXT,
  input_schema TEXT,
  output_schema TEXT,
  error_types TEXT,
  idempotent INTEGER DEFAULT 0,
  side_effects INTEGER DEFAULT 0,
  timeout_ms INTEGER DEFAULT 30000,
  registered_at TEXT DEFAULT (datetime('now')),
  last_verified TEXT
);

CREATE TABLE IF NOT EXISTS project_registry (
  path TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  github_remote TEXT,
  primary_agent_session TEXT,
  auto_sync INTEGER DEFAULT 1,
  last_sync_at TEXT,
  last_sync_result TEXT,
  registered_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS sync_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_path TEXT NOT NULL,
  action TEXT NOT NULL CHECK(action IN ('auto_pull','auto_push','notify_agent','skip_busy','skip_resource')),
  commits_pulled INTEGER DEFAULT 0,
  commits_pushed INTEGER DEFAULT 0,
  files_changed TEXT,
  summary TEXT,
  timestamp TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (project_path) REFERENCES project_registry(path)
);

CREATE TABLE IF NOT EXISTS agent_sessions (
  session_id TEXT PRIMARY KEY,
  project_path TEXT NOT NULL,
  agent_type TEXT NOT NULL CHECK(agent_type IN ('solo','proxy','worker','controller')),
  device_id TEXT NOT NULL,
  is_primary INTEGER DEFAULT 0,
  status TEXT DEFAULT 'active' CHECK(status IN ('active','idle','dead')),
  last_heartbeat TEXT DEFAULT (datetime('now')),
  registered_at TEXT DEFAULT (datetime('now')),
  metadata TEXT
);

CREATE INDEX IF NOT EXISTS idx_agent_sessions_project ON agent_sessions(project_path);
CREATE INDEX IF NOT EXISTS idx_agent_sessions_status ON agent_sessions(status);

CREATE TABLE IF NOT EXISTS circuit_breaker_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  service_id TEXT NOT NULL,
  service_name TEXT NOT NULL,
  event_type TEXT NOT NULL CHECK(event_type IN ('port_conflict','start_failed','breaker_tripped','breaker_reset','breaker_half_open')),
  detail TEXT,
  occupant_pid INTEGER,
  occupant_command TEXT,
  port INTEGER,
  timestamp TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_snapshots_device ON resource_snapshots(device_id);
CREATE INDEX IF NOT EXISTS idx_snapshots_time ON resource_snapshots(timestamp);
CREATE INDEX IF NOT EXISTS idx_heavy_tasks_status ON heavy_tasks(status);
CREATE INDEX IF NOT EXISTS idx_service_queue_svc ON service_queue(service_id, status);
CREATE INDEX IF NOT EXISTS idx_port_registry_project ON port_registry(project);
CREATE INDEX IF NOT EXISTS idx_port_registry_status ON port_registry(status);
CREATE INDEX IF NOT EXISTS idx_project_registry_sync ON project_registry(last_sync_at);
CREATE INDEX IF NOT EXISTS idx_sync_events_project ON sync_events(project_path);
CREATE INDEX IF NOT EXISTS idx_cb_events_service ON circuit_breaker_events(service_id);
CREATE INDEX IF NOT EXISTS idx_cb_events_time ON circuit_breaker_events(timestamp);

CREATE TABLE IF NOT EXISTS service_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  service_id TEXT NOT NULL,
  service_name TEXT NOT NULL,
  event_type TEXT NOT NULL CHECK(event_type IN (
    'watchdog_restart','excessive_restarts','decay_reset','restart_recovery',
    'started','stopped','crashed','health_ok','health_fail',
    'orphan_detected','orphan_killed',
    'port_conflict_resolved','death_diagnosed','transient_retry','clean_exit',
    'pending_restart_set','silent_restart','adopted','script_start','script_stop'
  )),
  detail TEXT,
  restart_count INTEGER,
  timestamp TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_svc_events_service ON service_events(service_id);
CREATE INDEX IF NOT EXISTS idx_svc_events_time ON service_events(timestamp);
`;

// ─── Database class ──────────────────────────────────────

export class SOTAgentDB {
  private registry: Database.Database;
  private resources: Database.Database;

  constructor(dataDir?: string) {
    const dir = dataDir ?? DATA_DIR;
    ensureDataDir();
    if (dataDir && !fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

    this.registry = new Database(path.join(dir, 'registry.sqlite'));
    this.resources = new Database(path.join(dir, 'resources.sqlite'));

    // WAL + full sync for durability
    for (const db of [this.registry, this.resources]) {
      db.pragma('journal_mode = WAL');
      db.pragma('synchronous = FULL');
    }

    this.registry.exec(REGISTRY_DDL);
    this.resources.exec(RESOURCES_DDL);
    this.runMigrations();
  }

  /** 向已有表添加缺失的列（DDL 变更后的增量迁移） */
  private runMigrations(): void {
    const addColumnIfMissing = (db: Database.Database, table: string, column: string, type: string) => {
      const cols = db.pragma(`table_info(${table})`) as Array<{ name: string }>;
      if (!cols.some(c => c.name === column)) {
        db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
        console.log(`[db] migration: ${table}.${column} 列已添加`);
      }
    };

    addColumnIfMissing(this.resources, 'shared_services', 'cron_schedule', 'TEXT');
    addColumnIfMissing(this.resources, 'shared_services', 'last_exit_code', 'INTEGER');
    addColumnIfMissing(this.resources, 'shared_services', 'last_error', 'TEXT');
    addColumnIfMissing(this.resources, 'shared_services', 'restart_count_updated_at', 'TEXT');
    addColumnIfMissing(this.resources, 'shared_services', 'pending_restart', 'INTEGER DEFAULT 0');
    addColumnIfMissing(this.resources, 'shared_services', 'last_change_at', 'TEXT');
    addColumnIfMissing(this.resources, 'shared_services', 'start_script_dir', 'TEXT');
    addColumnIfMissing(this.resources, 'heavy_tasks', 'callback_url', 'TEXT');
    addColumnIfMissing(this.resources, 'heavy_tasks', 'source_path', 'TEXT');
    addColumnIfMissing(this.resources, 'heavy_tasks', 'output_dir', 'TEXT');

    this.migrateCheckConstraint(this.resources, 'service_events', 'event_type',
      ['watchdog_restart','excessive_restarts','decay_reset','restart_recovery',
       'started','stopped','crashed','health_ok','health_fail',
       'orphan_detected','orphan_killed',
       'port_conflict_resolved','death_diagnosed','transient_retry','clean_exit',
       'pending_restart_set','silent_restart','adopted','script_start','script_stop']);
    this.migrateCheckConstraint(this.resources, 'circuit_breaker_events', 'event_type',
      ['port_conflict','start_failed','breaker_tripped','breaker_reset','breaker_half_open']);
  }

  private migrateCheckConstraint(db: Database.Database, table: string, column: string, expectedValues: string[]): void {
    const schema = (db.prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name=?`).get(table) as { sql: string } | undefined)?.sql ?? '';
    const allPresent = expectedValues.every(v => schema.includes(`'${v}'`));
    if (allPresent) return;

    console.log(`[db] migration: ${table}.${column} CHECK 约束需要更新`);
    const checkExpr = expectedValues.map(v => `'${v}'`).join(',');
    db.exec(`
      CREATE TABLE IF NOT EXISTS ${table}_migration_backup AS SELECT * FROM ${table};
      DROP TABLE ${table};
    `);
    db.exec(RESOURCES_DDL.split(';').filter(s => s.includes(`CREATE TABLE IF NOT EXISTS ${table}`)).join(';') + ';');
    try {
      db.exec(`INSERT INTO ${table} SELECT * FROM ${table}_migration_backup;`);
    } catch { /* empty backup or schema mismatch — skip data restore */ }
    db.exec(`DROP TABLE IF EXISTS ${table}_migration_backup;`);
    console.log(`[db] migration: ${table}.${column} CHECK 约束已更新`);
  }

  close(): void {
    this.registry.close();
    this.resources.close();
  }

  /**
   * Backup both databases using SQLite's .backup API.
   * Files are written to <dataDir>/backups/ with timestamp suffix.
   * Keeps at most `keep` most recent backups per database.
   */
  backup(keep = 3): { files: string[] } {
    const backupDir = path.join(DATA_DIR, 'backups');
    if (!fs.existsSync(backupDir)) fs.mkdirSync(backupDir, { recursive: true });

    const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const files: string[] = [];

    for (const [label, db] of [['registry', this.registry], ['resources', this.resources]] as const) {
      const dest = path.join(backupDir, `${label}-${ts}.sqlite`);
      try {
        db.backup(dest).then(() => {
          console.log(`[db] backup ${label} → ${dest}`);
        }).catch((err: Error) => {
          console.error(`[db] backup ${label} failed:`, err.message);
        });
        files.push(dest);
      } catch (err) {
        console.error(`[db] backup ${label} failed:`, err);
      }
    }

    // Prune old backups
    try {
      const entries = fs.readdirSync(backupDir).sort().reverse();
      for (const prefix of ['registry-', 'resources-']) {
        const matching = entries.filter(e => e.startsWith(prefix));
        for (const old of matching.slice(keep)) {
          fs.unlinkSync(path.join(backupDir, old));
        }
      }
    } catch { /* non-critical */ }

    return { files };
  }

  // ─── Tech Assets CRUD ──────────────────────────────────

  registerAsset(params: {
    id: string;
    type: AssetType;
    canonical_path: string;
    content_hash?: string;
    updated_by?: string;
  }): void {
    this.registry.prepare(`
      INSERT INTO tech_assets (id, type, canonical_path, content_hash, updated_by, updated_at)
      VALUES (?, ?, ?, ?, ?, datetime('now'))
      ON CONFLICT(id) DO UPDATE SET
        canonical_path = excluded.canonical_path,
        content_hash = excluded.content_hash,
        updated_by = excluded.updated_by,
        version = version + 1,
        updated_at = datetime('now')
    `).run(params.id, params.type, params.canonical_path, params.content_hash ?? null, params.updated_by ?? null);
  }

  getAsset(id: string): ITechAssetRow | undefined {
    return this.registry.prepare('SELECT * FROM tech_assets WHERE id = ?').get(id) as ITechAssetRow | undefined;
  }

  listAssets(type?: AssetType): ITechAssetRow[] {
    if (type) {
      return this.registry.prepare('SELECT * FROM tech_assets WHERE type = ? ORDER BY updated_at DESC').all(type) as ITechAssetRow[];
    }
    return this.registry.prepare('SELECT * FROM tech_assets ORDER BY updated_at DESC').all() as ITechAssetRow[];
  }

  // ─── Subscriptions CRUD ────────────────────────────────

  subscribe(params: {
    project_id: string;
    asset_id: string;
    sync_level?: SyncLevel;
    project_path: string;
  }): void {
    this.registry.prepare(`
      INSERT INTO subscriptions (project_id, asset_id, sync_level, project_path)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(project_id, asset_id) DO UPDATE SET
        sync_level = excluded.sync_level,
        project_path = excluded.project_path
    `).run(params.project_id, params.asset_id, params.sync_level ?? 'auto', params.project_path);
  }

  getSubscribers(assetId: string): ISubscriptionRow[] {
    return this.registry.prepare(
      'SELECT * FROM subscriptions WHERE asset_id = ?'
    ).all(assetId) as ISubscriptionRow[];
  }

  getProjectSubscriptions(projectId: string): ISubscriptionRow[] {
    return this.registry.prepare(
      'SELECT * FROM subscriptions WHERE project_id = ?'
    ).all(projectId) as ISubscriptionRow[];
  }

  allSubscriptions(): ISubscriptionRow[] {
    return this.registry.prepare('SELECT * FROM subscriptions ORDER BY asset_id, project_id').all() as ISubscriptionRow[];
  }

  unsubscribe(projectId: string, assetId: string): void {
    this.registry.prepare(
      'DELETE FROM subscriptions WHERE project_id = ? AND asset_id = ?'
    ).run(projectId, assetId);
  }

  // ─── Sync Log ──────────────────────────────────────────

  logSync(params: {
    asset_id: string;
    from_project: string;
    to_project: string;
    action: SyncAction;
    diff_summary?: string;
  }): void {
    this.registry.prepare(`
      INSERT INTO sync_log (asset_id, from_project, to_project, action, diff_summary)
      VALUES (?, ?, ?, ?, ?)
    `).run(params.asset_id, params.from_project, params.to_project, params.action, params.diff_summary ?? null);
  }

  getSyncHistory(assetId?: string, limit = 50): ISyncLogRow[] {
    if (assetId) {
      return this.registry.prepare(
        'SELECT * FROM sync_log WHERE asset_id = ? ORDER BY timestamp DESC LIMIT ?'
      ).all(assetId, limit) as ISyncLogRow[];
    }
    return this.registry.prepare(
      'SELECT * FROM sync_log ORDER BY timestamp DESC LIMIT ?'
    ).all(limit) as ISyncLogRow[];
  }

  countSyncLog(): number {
    const row = this.registry.prepare('SELECT COUNT(*) as c FROM sync_log').get() as { c: number };
    return row.c;
  }

  // ─── Resource Profiles ─────────────────────────────────

  upsertProfile(params: {
    task_type: string;
    cpu_percent: number;
    mem_mb: number;
    gpu_mem_mb?: number;
    duration_sec?: number;
  }): void {
    const existing = this.resources.prepare(
      'SELECT * FROM resource_profiles WHERE task_type = ?'
    ).get(params.task_type) as IResourceProfileRow | undefined;

    if (existing) {
      // 增量移动平均
      const n = existing.sample_count + 1;
      const avgCpu = existing.avg_cpu_percent + (params.cpu_percent - existing.avg_cpu_percent) / n;
      const avgMem = existing.avg_mem_mb + (params.mem_mb - existing.avg_mem_mb) / n;
      const peakCpu = Math.max(existing.peak_cpu_percent, params.cpu_percent);
      const peakMem = Math.max(existing.peak_mem_mb, params.mem_mb);
      const gpuMem = params.gpu_mem_mb != null
        ? Math.max(existing.gpu_mem_mb, params.gpu_mem_mb)
        : existing.gpu_mem_mb;
      const avgDur = params.duration_sec != null
        ? Math.round(existing.avg_duration_sec + (params.duration_sec - existing.avg_duration_sec) / n)
        : existing.avg_duration_sec;
      const confidence: ConfidenceLevel = n >= 10 ? 'high' : n >= 3 ? 'medium' : 'low';

      this.resources.prepare(`
        UPDATE resource_profiles SET
          avg_cpu_percent = ?, peak_cpu_percent = ?,
          avg_mem_mb = ?, peak_mem_mb = ?,
          gpu_mem_mb = ?, avg_duration_sec = ?,
          sample_count = ?, confidence = ?,
          updated_at = datetime('now')
        WHERE task_type = ?
      `).run(avgCpu, peakCpu, avgMem, peakMem, gpuMem, avgDur, n, confidence, params.task_type);
    } else {
      const confidence: ConfidenceLevel = 'low';
      this.resources.prepare(`
        INSERT INTO resource_profiles
          (task_type, avg_cpu_percent, peak_cpu_percent, avg_mem_mb, peak_mem_mb,
           gpu_mem_mb, avg_duration_sec, sample_count, confidence)
        VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)
      `).run(
        params.task_type,
        params.cpu_percent, params.cpu_percent,
        params.mem_mb, params.mem_mb,
        params.gpu_mem_mb ?? 0,
        params.duration_sec ?? 0,
        confidence,
      );
    }
  }

  getProfile(taskType: string): IResourceProfileRow | undefined {
    return this.resources.prepare(
      'SELECT * FROM resource_profiles WHERE task_type = ?'
    ).get(taskType) as IResourceProfileRow | undefined;
  }

  listProfiles(): IResourceProfileRow[] {
    return this.resources.prepare(
      'SELECT * FROM resource_profiles ORDER BY sample_count DESC'
    ).all() as IResourceProfileRow[];
  }

  // ─── Heavy Tasks ───────────────────────────────────────

  createHeavyTask(params: {
    requester: string;
    task_type: string;
    command: string;
    priority?: number;
    estimated_duration_sec?: number;
    checkpoint_path?: string;
    callback_url?: string;
    source_path?: string;
    output_dir?: string;
  }): string {
    const id = `ht-${nanoid(10)}`;
    this.resources.prepare(`
      INSERT INTO heavy_tasks (id, requester, task_type, command, priority, estimated_duration_sec, checkpoint_path, callback_url, source_path, output_dir)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id, params.requester, params.task_type, params.command,
      params.priority ?? 0, params.estimated_duration_sec ?? null,
      params.checkpoint_path ?? null, params.callback_url ?? null,
      params.source_path ?? null, params.output_dir ?? null,
    );
    return id;
  }

  updateTaskStatus(id: string, status: TaskStatus, extra?: {
    pid?: number;
    progress_percent?: number;
    notified_eta?: string;
  }): void {
    const sets: string[] = ['status = ?'];
    const vals: unknown[] = [status];

    if (status === 'running') {
      sets.push("actual_start = COALESCE(actual_start, datetime('now'))");
    }
    if (status === 'done' || status === 'failed') {
      sets.push("actual_end = datetime('now')");
    }
    if (extra?.pid != null) { sets.push('pid = ?'); vals.push(extra.pid); }
    if (extra?.progress_percent != null) { sets.push('progress_percent = ?'); vals.push(extra.progress_percent); }
    if (extra?.notified_eta != null) { sets.push('notified_eta = ?'); vals.push(extra.notified_eta); }

    vals.push(id);
    this.resources.prepare(`UPDATE heavy_tasks SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
  }

  getTask(id: string): IHeavyTaskRow | undefined {
    return this.resources.prepare('SELECT * FROM heavy_tasks WHERE id = ?').get(id) as IHeavyTaskRow | undefined;
  }

  listTasks(status?: TaskStatus): IHeavyTaskRow[] {
    if (status) {
      return this.resources.prepare(
        'SELECT * FROM heavy_tasks WHERE status = ? ORDER BY priority DESC, created_at ASC'
      ).all(status) as IHeavyTaskRow[];
    }
    return this.resources.prepare(
      'SELECT * FROM heavy_tasks ORDER BY priority DESC, created_at ASC'
    ).all() as IHeavyTaskRow[];
  }

  /** 获取下一个可执行的排队任务 */
  nextQueuedTask(): IHeavyTaskRow | undefined {
    return this.resources.prepare(
      "SELECT * FROM heavy_tasks WHERE status = 'queued' ORDER BY priority DESC, created_at ASC LIMIT 1"
    ).get() as IHeavyTaskRow | undefined;
  }

  runningTaskCount(): number {
    const row = this.resources.prepare(
      "SELECT COUNT(*) as cnt FROM heavy_tasks WHERE status = 'running'"
    ).get() as { cnt: number };
    return row.cnt;
  }

  // ─── Shared Services ───────────────────────────────────

  registerService(params: {
    id: string;
    name: string;
    command: string;
    work_dir?: string;
    mem_requirement_mb?: number;
    gpu_mem_requirement_mb?: number;
    device_id?: string;
    auto_start?: boolean;
    restart_on_failure?: boolean;
    max_restarts?: number;
    port?: number;
    health_check_url?: string;
    cron_schedule?: string | null;
    start_script_dir?: string | null;
  }): void {
    this.resources.prepare(`
      INSERT INTO shared_services (id, name, command, work_dir, mem_requirement_mb, gpu_mem_requirement_mb, device_id, auto_start, restart_on_failure, max_restarts, port, health_check_url, cron_schedule, start_script_dir)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name,
        command = excluded.command,
        work_dir = excluded.work_dir,
        mem_requirement_mb = excluded.mem_requirement_mb,
        gpu_mem_requirement_mb = excluded.gpu_mem_requirement_mb,
        device_id = excluded.device_id,
        auto_start = excluded.auto_start,
        restart_on_failure = excluded.restart_on_failure,
        max_restarts = excluded.max_restarts,
        port = COALESCE(excluded.port, port),
        health_check_url = excluded.health_check_url,
        cron_schedule = excluded.cron_schedule,
        start_script_dir = excluded.start_script_dir
    `).run(
      params.id, params.name, params.command,
      params.work_dir ?? null,
      params.mem_requirement_mb ?? 0, params.gpu_mem_requirement_mb ?? 0,
      params.device_id ?? 'any',
      params.auto_start ? 1 : 0,
      params.restart_on_failure ? 1 : 0,
      params.max_restarts ?? 3,
      params.port ?? null,
      params.health_check_url ?? null,
      params.cron_schedule ?? null,
      params.start_script_dir ?? null,
    );
  }

  deleteService(id: string): boolean {
    const result = this.resources.prepare('DELETE FROM shared_services WHERE id = ?').run(id);
    return result.changes > 0;
  }

  updateServiceStatus(id: string, status: string, extra?: {
    pid?: number;
    port?: number;
    restart_count?: number;
    last_exit_code?: number | null;
    last_error?: string | null;
  }): void {
    const sets = ['status = ?'];
    const vals: unknown[] = [status];
    if (status === 'running') sets.push("started_at = datetime('now')");
    if (status === 'starting' && extra?.pid == null) sets.push('pid = NULL');
    if (status === 'stopped') { sets.push('pid = NULL'); sets.push('restart_count = 0'); sets.push("restart_count_updated_at = datetime('now')"); }
    if (extra?.pid != null) { sets.push('pid = ?'); vals.push(extra.pid); }
    if (extra?.port != null) { sets.push('port = ?'); vals.push(extra.port); }
    if (extra?.restart_count != null) { sets.push('restart_count = ?'); vals.push(extra.restart_count); sets.push("restart_count_updated_at = datetime('now')"); }
    if (extra?.last_exit_code !== undefined) { sets.push('last_exit_code = ?'); vals.push(extra.last_exit_code); }
    if (extra?.last_error !== undefined) { sets.push('last_error = ?'); vals.push(extra.last_error); }
    vals.push(id);
    this.resources.prepare(`UPDATE shared_services SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
  }

  updateServiceCommand(id: string, command: string, workDir?: string): void {
    if (workDir) {
      this.resources.prepare(
        'UPDATE shared_services SET command = ?, work_dir = ? WHERE id = ?'
      ).run(command, workDir, id);
    } else {
      this.resources.prepare(
        'UPDATE shared_services SET command = ? WHERE id = ?'
      ).run(command, id);
    }
  }

  updateServiceHealthCheck(id: string): void {
    this.resources.prepare(
      "UPDATE shared_services SET last_health_check = datetime('now') WHERE id = ?"
    ).run(id);
  }

  getService(id: string): ISharedServiceRow | undefined {
    return this.resources.prepare('SELECT * FROM shared_services WHERE id = ?').get(id) as ISharedServiceRow | undefined;
  }

  listServices(deviceId?: string): ISharedServiceRow[] {
    if (deviceId) {
      return this.resources.prepare(
        "SELECT * FROM shared_services WHERE device_id = ? OR device_id = 'any' ORDER BY name"
      ).all(deviceId) as ISharedServiceRow[];
    }
    return this.resources.prepare('SELECT * FROM shared_services ORDER BY name').all() as ISharedServiceRow[];
  }

  /** 获取需要自启动的服务 */
  listAutoStartServices(deviceId: string): ISharedServiceRow[] {
    return this.resources.prepare(
      "SELECT * FROM shared_services WHERE auto_start = 1 AND (device_id = ? OR device_id = 'any') ORDER BY name"
    ).all(deviceId) as ISharedServiceRow[];
  }

  listCronServices(deviceId: string): ISharedServiceRow[] {
    return this.resources.prepare(
      "SELECT * FROM shared_services WHERE cron_schedule IS NOT NULL AND (device_id = ? OR device_id = 'any') ORDER BY name"
    ).all(deviceId) as ISharedServiceRow[];
  }

  // ─── Device Config ────────────────────────────────────────

  upsertDevice(params: {
    device_id: string;
    display_name: string;
    tailscale_ip?: string;
    role?: string;
    is_local?: boolean;
    capabilities?: string[];
  }): void {
    this.resources.prepare(`
      INSERT INTO device_config (device_id, display_name, tailscale_ip, role, is_local, capabilities, last_seen)
      VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
      ON CONFLICT(device_id) DO UPDATE SET
        display_name = excluded.display_name,
        tailscale_ip = COALESCE(excluded.tailscale_ip, tailscale_ip),
        role = excluded.role,
        is_local = excluded.is_local,
        capabilities = excluded.capabilities,
        last_seen = datetime('now')
    `).run(
      params.device_id, params.display_name,
      params.tailscale_ip ?? null,
      params.role ?? 'dev',
      params.is_local ? 1 : 0,
      params.capabilities ? JSON.stringify(params.capabilities) : null,
    );
  }

  getDevice(deviceId: string): IDeviceConfigRow | undefined {
    return this.resources.prepare(
      'SELECT * FROM device_config WHERE device_id = ?'
    ).get(deviceId) as IDeviceConfigRow | undefined;
  }

  listDevices(): IDeviceConfigRow[] {
    return this.resources.prepare(
      'SELECT * FROM device_config ORDER BY display_name'
    ).all() as IDeviceConfigRow[];
  }

  /** 获取有特定能力的计算设备 */
  getComputeDevice(capability: string): IDeviceConfigRow | undefined {
    return this.resources.prepare(
      "SELECT * FROM device_config WHERE role IN ('compute','both') AND capabilities LIKE ? ORDER BY last_seen DESC LIMIT 1"
    ).get(`%${capability}%`) as IDeviceConfigRow | undefined;
  }

  // ─── Service Queue ─────────────────────────────────────

  enqueueServiceRequest(params: {
    service_id: string;
    requester: string;
    project: string;
    request_payload?: Record<string, unknown>;
    priority?: number;
  }): string {
    const id = `sq-${nanoid(10)}`;
    // 计算当前排队位置
    const pos = this.resources.prepare(
      "SELECT COUNT(*) as cnt FROM service_queue WHERE service_id = ? AND status IN ('queued','processing')"
    ).get(params.service_id) as { cnt: number };

    this.resources.prepare(`
      INSERT INTO service_queue (id, service_id, requester, project, request_payload, priority, position)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      id, params.service_id, params.requester, params.project,
      params.request_payload ? JSON.stringify(params.request_payload) : null,
      params.priority ?? 0, pos.cnt + 1,
    );
    return id;
  }

  getQueuePosition(id: string): { position: number; estimated_wait_sec: number | null } | undefined {
    const row = this.resources.prepare(
      'SELECT position, estimated_wait_sec FROM service_queue WHERE id = ?'
    ).get(id) as { position: number; estimated_wait_sec: number | null } | undefined;
    return row;
  }

  // ─── Resource Snapshots ────────────────────────────────

  recordSnapshot(snapshot: IResourceSnapshot): void {
    this.resources.prepare(`
      INSERT INTO resource_snapshots (device_id, cpu_percent, mem_used_mb, mem_total_mb, mem_percent, gpu_mem_used_mb, mem_pressure_level, mem_availability, cpu_load_ratio, timestamp)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      snapshot.device_id, snapshot.cpu_percent,
      snapshot.mem_used_mb, snapshot.mem_total_mb, snapshot.mem_percent,
      snapshot.gpu_mem_used_mb ?? null,
      snapshot.mem_pressure_level ?? null,
      snapshot.mem_availability ?? null,
      snapshot.cpu_load_ratio ?? null,
      snapshot.timestamp,
    );
  }

  /** 最近 N 条快照，用于判断系统是否空闲 */
  recentSnapshots(deviceId: string, limit = 5): IResourceSnapshotRow[] {
    return this.resources.prepare(
      'SELECT * FROM resource_snapshots WHERE device_id = ? ORDER BY timestamp DESC LIMIT ?'
    ).all(deviceId, limit) as IResourceSnapshotRow[];
  }

  /** 清理超过 N 天的快照 */
  pruneSnapshots(days = 7): void {
    this.resources.prepare(
      "DELETE FROM resource_snapshots WHERE timestamp < datetime('now', ? || ' days')"
    ).run(-days);
  }

  /** 清理超过 N 天的日志表记录（sync_log, service_events, sync_events） */
  pruneLogs(days = 30): void {
    const cutoff = -days;
    this.registry.prepare(
      "DELETE FROM sync_log WHERE timestamp < datetime('now', ? || ' days')"
    ).run(cutoff);
    try {
      this.resources.prepare(
        "DELETE FROM service_events WHERE timestamp < datetime('now', ? || ' days')"
      ).run(cutoff);
      this.resources.prepare(
        "DELETE FROM circuit_breaker_events WHERE timestamp < datetime('now', ? || ' days')"
      ).run(cutoff);
    } catch { /* tables may not exist yet */ }
    try {
      this.registry.prepare(
        "DELETE FROM sync_events WHERE timestamp < datetime('now', ? || ' days')"
      ).run(cutoff);
    } catch { /* table may not exist */ }
  }

  // ─── Port Registry ──────────────────────────────────────

  /** 端口号是否符合治理规则（必须以 0 或 5 结尾） */
  static isPortCompliant(port: number): boolean {
    const lastDigit = port % 10;
    return lastDigit === 0 || lastDigit === 5;
  }

  /** 分配端口：只分配以 0 或 5 结尾的端口。优先 preferred，否则在范围内搜索。
   *  同名 service 重启时复用已有端口（如果该端口未被其他进程占用）。 */
  allocatePort(params: {
    service_name: string;
    project: string;
    device_id: string;
    preferred_port?: number;
    range_start?: number;
    range_end?: number;
  }): number | null {
    const rangeStart = params.range_start ?? 3000;
    const rangeEnd = params.range_end ?? 9999;

    // Phase 0: 同名 service 复用 — 如果同一 service_name 已有 active 记录且端口未被占用，直接复用
    const sameServiceRow = this.resources.prepare(
      "SELECT port FROM port_registry WHERE service_name = ? AND status = 'active' ORDER BY last_verified DESC LIMIT 1"
    ).get(params.service_name) as { port: number } | undefined;

    if (sameServiceRow && sameServiceRow.port > 0 && SOTAgentDB.isPortCompliant(sameServiceRow.port) && !this.isPortInUse(sameServiceRow.port)) {
      // 旧进程已退出但记录仍 active → 直接复用端口，刷新记录
      this.resources.prepare(`
        UPDATE port_registry SET
          project = ?, device_id = ?, status = 'active',
          allocated_at = datetime('now'), last_verified = datetime('now')
        WHERE port = ?
      `).run(params.project, params.device_id, sameServiceRow.port);
      // 释放同名 service 的其他 active 记录（防止端口泄漏）
      this.resources.prepare(
        "UPDATE port_registry SET status = 'released' WHERE service_name = ? AND status = 'active' AND port != ?"
      ).run(params.service_name, sameServiceRow.port);
      return sameServiceRow.port;
    }

    // Phase 1: 尝试 preferred 端口
    if (params.preferred_port != null) {
      if (!SOTAgentDB.isPortCompliant(params.preferred_port)) {
        console.warn(`[port] 拒绝分配端口 ${params.preferred_port}：不以 0 或 5 结尾`);
        return null;
      }

      const existing = this.resources.prepare(
        "SELECT port, service_name FROM port_registry WHERE port = ? AND status = 'active'"
      ).get(params.preferred_port) as { port: number; service_name: string } | undefined;

      if (!existing && !this.isPortInUse(params.preferred_port)) {
        this.resources.prepare(`
          INSERT INTO port_registry (port, service_name, project, device_id)
          VALUES (?, ?, ?, ?)
          ON CONFLICT(port) DO UPDATE SET
            service_name = excluded.service_name,
            project = excluded.project,
            device_id = excluded.device_id,
            status = 'active',
            allocated_at = datetime('now'),
            last_verified = datetime('now')
        `).run(params.preferred_port, params.service_name, params.project, params.device_id);
        return params.preferred_port;
      }

      // preferred 被同名 service 占用（旧记录）→ 如果端口未被进程占用，直接接管
      if (existing && existing.service_name === params.service_name && !this.isPortInUse(params.preferred_port)) {
        this.resources.prepare(`
          UPDATE port_registry SET
            project = ?, device_id = ?, status = 'active',
            allocated_at = datetime('now'), last_verified = datetime('now')
          WHERE port = ?
        `).run(params.project, params.device_id, params.preferred_port);
        return params.preferred_port;
      }

      // preferred 端口为 released/stale，且同 service/project + 端口正在被监听 → 复活
      if (!existing) {
        const staleRow = this.resources.prepare(
          "SELECT * FROM port_registry WHERE port = ? AND status IN ('released', 'stale')"
        ).get(params.preferred_port) as IPortRegistryRow | undefined;

        if (staleRow &&
            staleRow.service_name === params.service_name &&
            staleRow.project === params.project &&
            this.isPortInUse(params.preferred_port)) {
          this.resources.prepare(`
            UPDATE port_registry SET
              status = 'active', device_id = ?,
              allocated_at = datetime('now'), last_verified = datetime('now')
            WHERE port = ?
          `).run(params.device_id, params.preferred_port);
          console.log(`[port] allocatePort: 复活 released/stale 端口 ${params.preferred_port} (${params.service_name}/${params.project})`);
          return params.preferred_port;
        }
      }
    }

    // Phase 2: 搜索可用端口
    const allocatedPorts = new Set(
      (this.resources.prepare(
        "SELECT port FROM port_registry WHERE status = 'active'"
      ).all() as { port: number }[]).map(r => r.port)
    );

    const firstCompliant = rangeStart % 5 === 0 ? rangeStart : rangeStart + (5 - rangeStart % 5);
    for (let port = firstCompliant; port <= rangeEnd; port += 5) {
      if (!allocatedPorts.has(port) && !this.isPortInUse(port)) {
        this.resources.prepare(`
          INSERT INTO port_registry (port, service_name, project, device_id)
          VALUES (?, ?, ?, ?)
          ON CONFLICT(port) DO UPDATE SET
            service_name = excluded.service_name,
            project = excluded.project,
            device_id = excluded.device_id,
            status = 'active',
            allocated_at = datetime('now'),
            last_verified = datetime('now')
        `).run(port, params.service_name, params.project, params.device_id);
        return port;
      }
    }

    return null;
  }

  /** 检查系统端口是否正在被使用（lsof） */
  private isPortInUse(port: number): boolean {
    try {
      const result = execSyncFn(`lsof -iTCP:${port} -sTCP:LISTEN -t 2>/dev/null`, { encoding: 'utf-8' });
      return result.trim().length > 0;
    } catch {
      return false;
    }
  }

  releasePort(port: number): void {
    this.resources.prepare(
      "UPDATE port_registry SET status = 'released' WHERE port = ?"
    ).run(port);
  }

  listActivePortEntries(): Array<{ port: number; service_name: string }> {
    return this.resources.prepare(
      "SELECT port, service_name FROM port_registry WHERE status = 'active'"
    ).all() as Array<{ port: number; service_name: string }>;
  }

  getPortAllocation(port: number): IPortRegistryRow | undefined {
    return this.resources.prepare(
      "SELECT * FROM port_registry WHERE port = ? AND status = 'active'"
    ).get(port) as IPortRegistryRow | undefined;
  }

  getPortRow(port: number): IPortRegistryRow | undefined {
    return this.resources.prepare(
      "SELECT * FROM port_registry WHERE port = ?"
    ).get(port) as IPortRegistryRow | undefined;
  }

  getProjectPorts(project: string): IPortRegistryRow[] {
    return this.resources.prepare(
      "SELECT * FROM port_registry WHERE project = ? AND status = 'active' ORDER BY port"
    ).all(project) as IPortRegistryRow[];
  }

  listActivePorts(): IPortRegistryRow[] {
    return this.resources.prepare(
      "SELECT * FROM port_registry WHERE status = 'active' ORDER BY port"
    ).all() as IPortRegistryRow[];
  }

  /** 返回全部端口记录，包括 released / stale，按端口排序 */
  listAllPorts(): IPortRegistryRow[] {
    return this.resources.prepare(
      'SELECT * FROM port_registry ORDER BY port'
    ).all() as IPortRegistryRow[];
  }

  /** 注册或刷新端口（用于自动发现） */
  upsertPort(port: number, serviceName: string, project: string, deviceId: string): void {
    this.resources.prepare(`
      INSERT INTO port_registry (port, service_name, project, device_id, status, last_verified)
      VALUES (?, ?, ?, ?, 'active', datetime('now'))
      ON CONFLICT(port) DO UPDATE SET
        service_name = excluded.service_name,
        project = excluded.project,
        device_id = excluded.device_id,
        last_verified = datetime('now'),
        status = 'active'
    `).run(port, serviceName, project, deviceId);
  }

  /** 仅刷新端口验证时间（仅限 active 状态，不改变 released/stale） */
  touchPort(port: number): void {
    this.resources.prepare(
      "UPDATE port_registry SET last_verified = datetime('now') WHERE port = ? AND status = 'active'"
    ).run(port);
  }

  /**
   * 复活被误标为 released/stale 的端口。
   * 前提条件：端口记录存在、service_name+project 匹配、端口实际被监听。
   * 返回 true 表示复活成功，false 表示条件不满足。
   */
  reactivatePort(port: number, serviceName: string, project: string, deviceId: string): boolean {
    const row = this.resources.prepare(
      "SELECT * FROM port_registry WHERE port = ?"
    ).get(port) as IPortRegistryRow | undefined;

    if (!row) return false;
    if (row.status === 'active') return false;

    if (row.service_name !== serviceName || row.project !== project) {
      return false;
    }

    if (!this.isPortInUse(port)) {
      return false;
    }

    this.resources.prepare(`
      UPDATE port_registry SET
        status = 'active',
        device_id = ?,
        last_verified = datetime('now')
      WHERE port = ?
    `).run(deviceId, port);

    console.log(`[db] reactivatePort: 端口 ${port} (${serviceName}/${project}) 从 ${row.status} 恢复为 active`);
    return true;
  }

  /** 清理超过 5 分钟未验证的 stale 端口（心跳 30s × 10 倍容错） */
  pruneStalePortAllocations(): void {
    this.resources.prepare(
      "UPDATE port_registry SET status = 'stale' WHERE status = 'active' AND last_verified < datetime('now', '-5 minutes')"
    ).run();
  }

  // ─── 能力注册表 ─────────────────────────────────────────

  registerCapability(cap: {
    id: string; project: string; service_name: string;
    version?: string; transport?: string; endpoint?: string; method?: string;
    description?: string; input_schema?: string; output_schema?: string;
    error_types?: string; idempotent?: boolean; side_effects?: boolean; timeout_ms?: number;
  }): void {
    this.resources.prepare(`
      INSERT OR REPLACE INTO capability_registry
      (id, project, service_name, version, transport, endpoint, method, description,
       input_schema, output_schema, error_types, idempotent, side_effects, timeout_ms, last_verified)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    `).run(
      cap.id, cap.project, cap.service_name,
      cap.version ?? '0.1.0', cap.transport ?? 'http',
      cap.endpoint ?? null, cap.method ?? 'POST', cap.description ?? null,
      cap.input_schema ?? null, cap.output_schema ?? null, cap.error_types ?? null,
      cap.idempotent ? 1 : 0, cap.side_effects ? 1 : 0,
      cap.timeout_ms ?? 30000,
    );
  }

  listCapabilities(): any[] {
    return this.resources.prepare('SELECT * FROM capability_registry ORDER BY project, id').all();
  }

  searchCapabilities(query: string): any[] {
    const q = `%${query.toLowerCase()}%`;
    return this.resources.prepare(
      `SELECT * FROM capability_registry
       WHERE LOWER(id) LIKE ? OR LOWER(description) LIKE ? OR LOWER(project) LIKE ?
       ORDER BY project, id`
    ).all(q, q, q);
  }

  getCapability(id: string): any | undefined {
    return this.resources.prepare('SELECT * FROM capability_registry WHERE id = ?').get(id);
  }

  getCapabilityByRoute(serviceName: string, endpoint: string): any | undefined {
    return this.resources.prepare(
      "SELECT * FROM capability_registry WHERE service_name = ? AND endpoint = ? LIMIT 1"
    ).get(serviceName, endpoint) as any | undefined;
  }

  getCapabilitiesByService(serviceName: string): any[] {
    return this.resources.prepare(
      "SELECT * FROM capability_registry WHERE service_name = ? ORDER BY id"
    ).all(serviceName) as any[];
  }

  deleteCapability(id: string): void {
    this.resources.prepare('DELETE FROM capability_registry WHERE id = ?').run(id);
  }

  // ─── 项目注册表 ─────────────────────────────────────────

  registerProject(opts: {
    path: string;
    name: string;
    github_remote?: string;
    auto_sync?: boolean;
  }): void {
    this.resources.prepare(`
      INSERT OR REPLACE INTO project_registry (path, name, github_remote, auto_sync)
      VALUES (?, ?, ?, ?)
    `).run(opts.path, opts.name, opts.github_remote ?? null, opts.auto_sync !== false ? 1 : 0);
  }

  listProjects(): IProjectRegistryRow[] {
    return this.resources.prepare(
      "SELECT * FROM project_registry ORDER BY name"
    ).all() as IProjectRegistryRow[];
  }

  /** 删除目录已不存在的 stale 项目（保留有 primary_agent_session 的活跃项目） */
  removeStaleProjects(validPaths: string[]): number {
    if (validPaths.length === 0) return 0;
    const placeholders = validPaths.map(() => '?').join(', ');
    const result = this.resources.prepare(
      `DELETE FROM project_registry WHERE path NOT IN (${placeholders}) AND (primary_agent_session IS NULL)`
    ).run(...validPaths);
    return result.changes;
  }

  getProject(projectPath: string): IProjectRegistryRow | undefined {
    return this.resources.prepare(
      "SELECT * FROM project_registry WHERE path = ?"
    ).get(projectPath) as IProjectRegistryRow | undefined;
  }

  updateProjectSync(projectPath: string, result: string): void {
    this.resources.prepare(
      "UPDATE project_registry SET last_sync_at = datetime('now'), last_sync_result = ? WHERE path = ?"
    ).run(result, projectPath);
  }

  setProjectAgent(projectPath: string, sessionId: string | null): void {
    this.resources.prepare(
      "UPDATE project_registry SET primary_agent_session = ? WHERE path = ?"
    ).run(sessionId, projectPath);
  }

  recordSyncEvent(opts: {
    project_path: string;
    action: 'auto_pull' | 'auto_push' | 'notify_agent' | 'skip_busy' | 'skip_resource';
    commits_pulled?: number;
    commits_pushed?: number;
    files_changed?: string;
    summary?: string;
  }): void {
    this.resources.prepare(`
      INSERT INTO sync_events (project_path, action, commits_pulled, commits_pushed, files_changed, summary)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      opts.project_path, opts.action,
      opts.commits_pulled ?? 0, opts.commits_pushed ?? 0,
      opts.files_changed ?? null, opts.summary ?? null,
    );
  }

  recentSyncEvents(projectPath?: string, limit = 10): ISyncEventRow[] {
    if (projectPath) {
      return this.resources.prepare(
        "SELECT * FROM sync_events WHERE project_path = ? ORDER BY timestamp DESC LIMIT ?"
      ).all(projectPath, limit) as ISyncEventRow[];
    }
    return this.resources.prepare(
      "SELECT * FROM sync_events ORDER BY timestamp DESC LIMIT ?"
    ).all(limit) as ISyncEventRow[];
  }

  // ─── Agent Session 管理 ─────────────────────────────────

  /**
   * 注册 Agent 并自动处理第一责任人逻辑：
   * - 如果该项目没有 primary agent，自动设为 primary
   * - session 绑项目不绑 Agent 实例
   * - 返回分配的 session_id（可能是继承的旧 session）
   */
  registerAgent(opts: {
    project_path: string;
    agent_type: 'solo' | 'proxy' | 'worker' | 'controller';
    device_id: string;
    session_id?: string;
    metadata?: string;
  }): { session_id: string; is_primary: boolean; inherited: boolean } {
    const project = this.getProject(opts.project_path);

    // 如果项目已有 primary session 且 agent 是 solo/proxy，继承该 session
    const existingSession = project?.primary_agent_session;
    const canBePrimary = opts.agent_type === 'solo' || opts.agent_type === 'proxy';

    let sessionId = opts.session_id || `sess-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    let inherited = false;

    if (existingSession && canBePrimary) {
      // 检查旧 session 是否还活着
      const oldAgent = this.resources.prepare(
        "SELECT * FROM agent_sessions WHERE session_id = ? AND status = 'active'"
      ).get(existingSession) as IAgentSessionRow | undefined;

      if (!oldAgent) {
        sessionId = existingSession;
        inherited = true;
      }
    }

    // 标记旧的同项目 active session 为 idle（如果是同类型）
    this.resources.prepare(
      "UPDATE agent_sessions SET status = 'idle' WHERE project_path = ? AND agent_type = ? AND status = 'active'"
    ).run(opts.project_path, opts.agent_type);

    const isPrimary = canBePrimary && !this.getActivePrimary(opts.project_path);

    this.resources.prepare(`
      INSERT OR REPLACE INTO agent_sessions (session_id, project_path, agent_type, device_id, is_primary, status, metadata, last_heartbeat)
      VALUES (?, ?, ?, ?, ?, 'active', ?, datetime('now'))
    `).run(sessionId, opts.project_path, opts.agent_type, opts.device_id, isPrimary ? 1 : 0, opts.metadata ?? null);

    // 更新 project_registry 的 primary_agent_session
    if (isPrimary) {
      this.setProjectAgent(opts.project_path, sessionId);
    }

    return { session_id: sessionId, is_primary: isPrimary || inherited, inherited };
  }

  getActivePrimary(projectPath: string): IAgentSessionRow | undefined {
    return this.resources.prepare(
      "SELECT * FROM agent_sessions WHERE project_path = ? AND is_primary = 1 AND status = 'active'"
    ).get(projectPath) as IAgentSessionRow | undefined;
  }

  agentHeartbeat(sessionId: string): void {
    this.resources.prepare(
      "UPDATE agent_sessions SET last_heartbeat = datetime('now') WHERE session_id = ?"
    ).run(sessionId);
  }

  listAgents(projectPath?: string): IAgentSessionRow[] {
    if (projectPath) {
      return this.resources.prepare(
        "SELECT * FROM agent_sessions WHERE project_path = ? ORDER BY is_primary DESC, registered_at DESC"
      ).all(projectPath) as IAgentSessionRow[];
    }
    return this.resources.prepare(
      "SELECT * FROM agent_sessions ORDER BY project_path, is_primary DESC, registered_at DESC"
    ).all() as IAgentSessionRow[];
  }

  /** 标记超过 30 分钟无心跳的 Agent 为 dead */
  pruneDeadAgents(): number {
    const result = this.resources.prepare(
      "UPDATE agent_sessions SET status = 'dead' WHERE status = 'active' AND last_heartbeat < datetime('now', '-30 minutes')"
    ).run();

    // 对于 dead 的 primary agent，清除 project_registry 中的引用
    const deadPrimaries = this.resources.prepare(
      "SELECT project_path FROM agent_sessions WHERE status = 'dead' AND is_primary = 1"
    ).all() as { project_path: string }[];

    for (const dp of deadPrimaries) {
      this.setProjectAgent(dp.project_path, null);
    }

    return result.changes;
  }

  countActiveAgents(): number {
    return (this.resources.prepare(
      "SELECT COUNT(*) as c FROM agent_sessions WHERE status = 'active'"
    ).get() as { c: number }).c;
  }

  deregisterAgent(sessionId: string): void {
    const agent = this.resources.prepare(
      "SELECT * FROM agent_sessions WHERE session_id = ?"
    ).get(sessionId) as IAgentSessionRow | undefined;

    this.resources.prepare(
      "UPDATE agent_sessions SET status = 'idle' WHERE session_id = ?"
    ).run(sessionId);

    if (agent?.is_primary) {
      this.setProjectAgent(agent.project_path, null);
    }
  }

  // ─── 熔断器事件 ─────────────────────────────────────────

  recordCircuitBreakerEvent(params: {
    service_id: string;
    service_name: string;
    event_type: 'port_conflict' | 'start_failed' | 'breaker_tripped' | 'breaker_reset' | 'breaker_half_open';
    detail?: string;
    occupant_pid?: number;
    occupant_command?: string;
    port?: number;
  }): void {
    this.resources.prepare(`
      INSERT INTO circuit_breaker_events (service_id, service_name, event_type, detail, occupant_pid, occupant_command, port)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      params.service_id, params.service_name, params.event_type,
      params.detail ?? null, params.occupant_pid ?? null,
      params.occupant_command ?? null, params.port ?? null,
    );
  }

  listCircuitBreakerEvents(serviceId?: string, limit = 50): ICircuitBreakerEventRow[] {
    if (serviceId) {
      return this.resources.prepare(
        'SELECT * FROM circuit_breaker_events WHERE service_id = ? ORDER BY timestamp DESC LIMIT ?'
      ).all(serviceId, limit) as ICircuitBreakerEventRow[];
    }
    return this.resources.prepare(
      'SELECT * FROM circuit_breaker_events ORDER BY timestamp DESC LIMIT ?'
    ).all(limit) as ICircuitBreakerEventRow[];
  }
  // ─── Service Events ──────────────────────────────────────

  logServiceEvent(params: {
    service_id: string;
    service_name: string;
    event_type: string;
    detail?: string;
    restart_count?: number;
  }): void {
    this.resources.prepare(`
      INSERT INTO service_events (service_id, service_name, event_type, detail, restart_count)
      VALUES (?, ?, ?, ?, ?)
    `).run(
      params.service_id, params.service_name, params.event_type,
      params.detail ?? null, params.restart_count ?? null,
    );
  }

  listServiceEvents(serviceId?: string, limit = 100): IServiceEventRow[] {
    if (serviceId) {
      return this.resources.prepare(
        'SELECT * FROM service_events WHERE service_id = ? ORDER BY timestamp DESC LIMIT ?'
      ).all(serviceId, limit) as IServiceEventRow[];
    }
    return this.resources.prepare(
      'SELECT * FROM service_events ORDER BY timestamp DESC LIMIT ?'
    ).all(limit) as IServiceEventRow[];
  }

  listUnresolvedAlerts(limit = 50): IServiceEventRow[] {
    return this.resources.prepare(
      "SELECT * FROM service_events WHERE event_type = 'excessive_restarts' AND timestamp > datetime('now', '-24 hours') ORDER BY timestamp DESC LIMIT ?"
    ).all(limit) as IServiceEventRow[];
  }

  updateServiceRestartCount(id: string, restartCount: number): void {
    this.resources.prepare(
      "UPDATE shared_services SET restart_count = ?, restart_count_updated_at = datetime('now') WHERE id = ?"
    ).run(restartCount, id);
  }

  // ─── Silent Restart Window ─────────────────────────────

  markPendingRestart(id: string): void {
    this.resources.prepare(
      "UPDATE shared_services SET pending_restart = 1, last_change_at = datetime('now') WHERE id = ?"
    ).run(id);
  }

  clearPendingRestart(id: string): void {
    this.resources.prepare(
      "UPDATE shared_services SET pending_restart = 0 WHERE id = ?"
    ).run(id);
  }

  listPendingRestarts(): ISharedServiceRow[] {
    return this.resources.prepare(
      "SELECT * FROM shared_services WHERE pending_restart = 1"
    ).all() as ISharedServiceRow[];
  }

  updateServiceScriptDir(id: string, scriptDir: string | null): void {
    this.resources.prepare(
      'UPDATE shared_services SET start_script_dir = ? WHERE id = ?'
    ).run(scriptDir, id);
  }

  // ─── Interface Snapshots ──────────────────────────────

  upsertInterfaceSnapshot(params: {
    project: string;
    interface_name: string;
    endpoints_json: string;
    status: string;
  }): void {
    this.registry.prepare(`
      INSERT INTO interface_snapshots (project, interface_name, endpoints_json, status, snapshot_at)
      VALUES (?, ?, ?, ?, datetime('now'))
      ON CONFLICT(project, interface_name) DO UPDATE SET
        endpoints_json = excluded.endpoints_json,
        status = excluded.status,
        snapshot_at = datetime('now')
    `).run(params.project, params.interface_name, params.endpoints_json, params.status);
  }

  listInterfaceSnapshots(project?: string): IInterfaceSnapshotRow[] {
    if (project) {
      return this.registry.prepare(
        'SELECT * FROM interface_snapshots WHERE project = ? ORDER BY interface_name'
      ).all(project) as IInterfaceSnapshotRow[];
    }
    return this.registry.prepare(
      'SELECT * FROM interface_snapshots ORDER BY project, interface_name'
    ).all() as IInterfaceSnapshotRow[];
  }

  deleteInterfaceSnapshot(project: string, interfaceName: string): void {
    this.registry.prepare(
      'DELETE FROM interface_snapshots WHERE project = ? AND interface_name = ?'
    ).run(project, interfaceName);
  }
}

// ─── Row 类型 ─────────────────────────────────────────────

export interface ITechAssetRow {
  id: string;
  type: AssetType;
  canonical_path: string;
  version: number;
  content_hash: string | null;
  updated_at: string;
  updated_by: string | null;
}

export interface ISubscriptionRow {
  project_id: string;
  asset_id: string;
  sync_level: SyncLevel;
  project_path: string;
}

export interface ISyncLogRow {
  id: number;
  asset_id: string;
  from_project: string;
  to_project: string;
  action: SyncAction;
  diff_summary: string | null;
  timestamp: string;
}

export interface IResourceProfileRow {
  task_type: string;
  avg_cpu_percent: number;
  peak_cpu_percent: number;
  avg_mem_mb: number;
  peak_mem_mb: number;
  gpu_mem_mb: number;
  avg_duration_sec: number;
  sample_count: number;
  confidence: ConfidenceLevel;
  updated_at: string;
}

export interface IHeavyTaskRow {
  id: string;
  requester: string;
  task_type: string;
  command: string;
  priority: number;
  status: TaskStatus;
  progress_percent: number;
  estimated_duration_sec: number | null;
  actual_start: string | null;
  actual_end: string | null;
  checkpoint_path: string | null;
  pid: number | null;
  created_at: string;
  notified_eta: string | null;
  callback_url: string | null;
  source_path: string | null;
  output_dir: string | null;
}

export interface ISharedServiceRow {
  id: string;
  name: string;
  command: string;
  work_dir: string | null;
  mem_requirement_mb: number;
  gpu_mem_requirement_mb: number;
  status: string;
  pid: number | null;
  port: number | null;
  device_id: string;
  auto_start: number;
  restart_on_failure: number;
  max_restarts: number;
  restart_count: number;
  started_at: string | null;
  last_used: string | null;
  last_health_check: string | null;
  health_check_url: string | null;
  cron_schedule: string | null;
  last_exit_code: number | null;
  last_error: string | null;
  restart_count_updated_at: string | null;
  pending_restart: number;
  last_change_at: string | null;
  start_script_dir: string | null;
}

export interface IDeviceConfigRow {
  device_id: string;
  display_name: string;
  tailscale_ip: string | null;
  role: string;
  is_local: number;
  capabilities: string | null;
  last_seen: string | null;
}

export interface IPortRegistryRow {
  port: number;
  service_name: string;
  project: string;
  device_id: string;
  allocated_at: string;
  last_verified: string;
  status: 'active' | 'released' | 'stale';
}

export interface IResourceSnapshotRow {
  id: number;
  device_id: string;
  cpu_percent: number;
  mem_used_mb: number;
  mem_total_mb: number;
  mem_percent: number;
  gpu_mem_used_mb: number | null;
  mem_pressure_level: number | null;
  mem_availability: number | null;
  cpu_load_ratio: number | null;
  timestamp: string;
}

export interface IProjectRegistryRow {
  path: string;
  name: string;
  github_remote: string | null;
  primary_agent_session: string | null;
  auto_sync: number;
  last_sync_at: string | null;
  last_sync_result: string | null;
  registered_at: string;
}

export interface ISyncEventRow {
  id: number;
  project_path: string;
  action: string;
  commits_pulled: number;
  commits_pushed: number;
  files_changed: string | null;
  summary: string | null;
  timestamp: string;
}

export interface IAgentSessionRow {
  session_id: string;
  project_path: string;
  agent_type: string;
  device_id: string;
  is_primary: number;
  status: string;
  last_heartbeat: string;
  registered_at: string;
  metadata: string | null;
}

export interface ICircuitBreakerEventRow {
  id: number;
  service_id: string;
  service_name: string;
  event_type: string;
  detail: string | null;
  occupant_pid: number | null;
  occupant_command: string | null;
  port: number | null;
  timestamp: string;
}

export interface IServiceEventRow {
  id: number;
  service_id: string;
  service_name: string;
  event_type: string;
  detail: string | null;
  restart_count: number | null;
  timestamp: string;
}

export interface IInterfaceSnapshotRow {
  project: string;
  interface_name: string;
  endpoints_json: string;
  status: string;
  snapshot_at: string;
}
