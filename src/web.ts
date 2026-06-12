/**
 * web.ts — SOTAgent Web 控制台 HTTP API
 *
 * 提供 Hono HTTP API 供 Vue 前端调用，整合两类数据源：
 * 1. 实时 Git 扫描（web-scanner）— 用户按需刷新
 * 2. SOTAgent SQLite 数据库 — 端口注册、资源快照、任务队列等
 */

import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { cors } from 'hono/cors';

import { SOTAgentDB } from './db.js';
// ProcessManager removed — fully migrated to PolarProcess
import { ResourceScheduler } from './scheduler.js';
import { ResourceProfiler } from './profiler.js';
import { PeerSync } from './peer-sync.js';
import { scanAll, pullRepo, pullAllClean, type IScanResult } from './web-scanner.js';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import {
  startAgent, stopAgent, getAgentState,
  analyzeRepos, executeAction, executeAll, chat,
  createSession, getSession, listSessions, closeSession,
  type IAgentAction,
} from './web-agent.js';

const execP = promisify(exec);

/** Unified error envelope helpers (see _Polarisor/error-envelope-spec.md) */
function envError(code: string, message: string) {
  return { ok: false as const, error: { code, message } };
}
function envSuccess<T>(data: T) {
  return { ok: true as const, data };
}
import { validateTopicName, validatePath, shellEscape, normalizeCommand } from './command-guard.js';
import { writeInboxFlag } from './inbox-flag.js';
import { syncProjects, syncPorts } from './auto-discover.js';
import { scanAssets } from './asset-scanner.js';
import { SyncEngine } from './sync-engine.js';
import { getResolutionLog, resolveConflict } from './conflict-resolver.js';
import { crystallize, matchCrystals, listCrystals, crystallize_arrow } from './crystallize.js';
import { Gateway, type IGatewayConfig } from './gateway.js';
import { getCached, updateCache, startCacheRefresh, stopAllCacheRefresh, getOrFetch, flushAllToDisk } from './api-cache.js';
import type { ISOTAgentConfig } from './types.js';
import {
  bridgeCall, BRIDGE_TARGETS,
  bridgeListPorts, bridgeAllocatePort, bridgeReleasePort, bridgePortHeartbeat,
  bridgeReservePort, bridgeReleaseReserve, bridgeListReserved,
  bridgeListServices, bridgeGetService, bridgeStartService, bridgeStopService,
  bridgeRestartService, bridgeRegisterService, bridgeRegisterAndStart,
  bridgePortConflicts, bridgeServiceEvents, bridgeServiceAlerts,
  bridgeAdoptProcess, bridgeDeleteProcess, bridgeListProcesses,
  bridgeCreateTask, bridgeForwardTask, bridgeListTasks,
  bridgeSchedulerReservations, bridgeSchedulerCheckAdmission,
  bridgePeerHeartbeat, bridgePeerNotify, bridgePeerNotifyPush,
  bridgePeerStatus, bridgePeerResolve,
  bridgeLobsterPost, bridgeLobsterGet,
  bridgeCheckupEvent,
  bridgeKnowLeverStatus, bridgeKnowLeverTopics, bridgeKnowLeverTopicDetail,
  bridgeKnowLeverRun, bridgeKnowLeverCancel, bridgeKnowLeverProgress,
  bridgeKnowLeverConfigGet, bridgeKnowLeverConfigPost, bridgeKnowLeverUsers,
  bridgeDigistStatus, bridgeDigistListInterests, bridgeDigistCreateInterest,
  bridgeDigistUpdateInterest, bridgeDigistDeleteInterest,
  bridgeDigistListSources, bridgeDigistAddSource, bridgeDigistRemoveSource,
  bridgeDigistCrawlTrigger, bridgeDigistCrawlHistory, bridgeDigistSyncToKnowLever,
  runSunsetCheck,
} from './facade/index.js';

const app = new Hono();
const db = new SOTAgentDB();

const SOTAGENT_DIR = path.join(import.meta.dirname, '..');
const POLARISOR_ROOT = path.join(process.env.HOME || os.homedir(), 'Polarisor');

/**
 * Scan all project directories under ~/Polarisor for capabilities.json,
 * and register their contents into capability_registry (idempotent).
 */
function syncCapabilitiesFromDisk(db: SOTAgentDB): void {
  try {
    const entries = fs.readdirSync(POLARISOR_ROOT, { withFileTypes: true });
    let total = 0;
    const projects: string[] = [];

    for (const entry of entries) {
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
      const capPath = path.join(POLARISOR_ROOT, entry.name, 'capabilities.json');
      try {
        if (!fs.existsSync(capPath)) continue;
        const data = JSON.parse(fs.readFileSync(capPath, 'utf-8'));
        const caps = data.capabilities;
        if (!Array.isArray(caps)) continue;

        const project = data.project || entry.name;
        for (const cap of caps) {
          db.registerCapability({
            id: cap.id,
            project,
            service_name: cap.service_name || entry.name,
            version: cap.version || data.version,
            transport: cap.transport,
            endpoint: cap.endpoint,
            method: cap.method,
            description: cap.description,
            input_schema: cap.input_schema ? JSON.stringify(cap.input_schema) : undefined,
            output_schema: cap.output_schema ? JSON.stringify(cap.output_schema) : undefined,
            error_types: cap.error_types ? JSON.stringify(cap.error_types) : undefined,
            idempotent: cap.idempotent,
            side_effects: cap.side_effects,
            timeout_ms: cap.timeout_ms,
          });
          total++;
        }
        projects.push(project);
      } catch {
        // skip unreadable files
      }
    }

    if (total > 0) {
      console.log(`[capabilities] 磁盘扫描: 从 ${projects.length} 个项目注册了 ${total} 个能力`);
    }
  } catch (e) {
    console.error('[capabilities] 磁盘扫描失败:', e);
  }
}
let config: ISOTAgentConfig;
try {
  const configRaw = fs.readFileSync(path.join(SOTAGENT_DIR, 'config.json'), 'utf-8');
  config = JSON.parse(configRaw) as ISOTAgentConfig;
} catch (e) {
  console.error('[SOTAgent] config.json 读取/解析失败:', e);
  console.error('[SOTAgent] 使用默认配置启动');
  config = { devices: {}, ports: { sotagent_api: 4800, sotagent_console: 4880 } } as unknown as ISOTAgentConfig;
}
// PM lifecycle now owned by PolarProcess — no local instantiation

function getStableDeviceId(): string {
  if (process.env['SOTAGENT_DEVICE_ID']) return process.env['SOTAGENT_DEVICE_ID'];
  const hostnameRaw = os.hostname().split('.')[0] ?? os.hostname();
  const devices = config.devices ?? {};
  if (devices[hostnameRaw]) return hostnameRaw;
  for (const [id] of Object.entries(devices)) {
    if (id.toLowerCase() === hostnameRaw.toLowerCase()) return id;
  }
  for (const [id] of Object.entries(devices)) {
    const a = hostnameRaw.toLowerCase().replace(/-/g, '');
    const b = id.toLowerCase().replace(/-/g, '');
    if (a.includes(b) || b.includes(a)) return id;
  }
  for (const [id, d] of Object.entries(devices)) {
    if (d.role === 'dev' || d.role === 'both') return id;
  }
  return hostnameRaw;
}

const syncEngine = new SyncEngine(db);
const peerSync = new PeerSync({ config, deviceId: getStableDeviceId() });

// ─── CORS — restrict to console origin ───────────────
const CONSOLE_PORT = (config as any).ports?.sotagent_console ?? 4880;
const API_PORT_FOR_CORS = (config as any).ports?.sotagent_api ?? 4800;
const ALLOWED_ORIGINS = [
  `http://127.0.0.1:${CONSOLE_PORT}`,
  `http://localhost:${CONSOLE_PORT}`,
  `http://127.0.0.1:${API_PORT_FOR_CORS}`,
  `http://localhost:${API_PORT_FOR_CORS}`,
];
app.use('*', cors({
  origin: (origin) => ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0],
  allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowHeaders: ['Content-Type', 'Authorization'],
}));


// ─── Auth middleware ─────────────────────────────────
const AUTH_TOKEN = process.env[config.security?.auth_token_env ?? 'SOTAGENT_AUTH_TOKEN'] ?? '';
const PUBLIC_ROUTES = new Set(config.security?.public_routes ?? ['/api/health', '/api/status', '/api/peer/heartbeat', '/api/peer/notify', '/api/ports/config', '/api/ports/heartbeat', '/api/ports/allocate', '/api/ports/release', '/api/ports', '/api/capabilities', '/api/capabilities/register', '/api/capabilities/register-batch', '/api/capabilities/search', '/api/capabilities/stats/summary', '/api/capabilities/resync', '/api/verify', '/api/checkup-events']);

if (AUTH_TOKEN) {
  app.use('*', async (c, next) => {
    const pathname = new URL(c.req.url).pathname;
    const isGatewayPath = gateway.enabled && pathname.startsWith(gateway.basePath + '/');
    if (PUBLIC_ROUTES.has(pathname) || c.req.method === 'OPTIONS' || isGatewayPath) {
      return next();
    }
    const header = c.req.header('Authorization');
    if (header === `Bearer ${AUTH_TOKEN}`) {
      return next();
    }
    return c.json({ ok: false, message: 'Unauthorized' }, 401);
  });
  console.log('[web] Auth middleware enabled');
} else {
  console.warn('[web] ⚠️  SOTAGENT_AUTH_TOKEN not set — API is unauthenticated');
}

// ─── Gateway (reverse proxy) ─────────────────────────
const gatewayConfig = (config as any).gateway as IGatewayConfig | undefined;
const gateway = new Gateway(gatewayConfig, db);

if (gateway.enabled) {
  app.use('*', gateway.middleware());
  console.log(`[web] Gateway 已启用: ${gateway.basePath}/* → 后端服务`);
}

app.get('/api/gateway/routes', (c) => c.json({
  enabled: gateway.enabled,
  base_path: gateway.basePath,
  routes: gateway.listRoutes(),
}));

let cachedResult: IScanResult = { repos: [], ports: [], scannedAt: '' };
let isScanning = false;

const deviceId = getStableDeviceId();
const profiler = new ResourceProfiler(db);
const scheduler = new ResourceScheduler(db, config, deviceId, profiler);

let _autoSyncRunning = false;

// 资源采样 + 调度定时器（在 serve 回调中赋值，shutdown 时清理）
let _snapshotTimer: ReturnType<typeof setInterval> | null = null;
let _profileTimer: ReturnType<typeof setInterval> | null = null;
let _scheduleTimer: ReturnType<typeof setInterval> | null = null;
let _pruneTimer: ReturnType<typeof setInterval> | null = null;

async function backgroundScan() {
  if (isScanning) return;
  isScanning = true;
  try {
    cachedResult = await scanAll(db);
    syncProjects(db, cachedResult);
    await syncPorts(db, cachedResult, deviceId);
    await scanAssets(db, syncEngine);

    // Refresh interface snapshots for change detection
    const ifaces = scanInterfaces();
    for (const iface of ifaces) {
      db.upsertInterfaceSnapshot({
        project: iface.project,
        interface_name: iface.interfaceName,
        endpoints_json: JSON.stringify(iface.endpoints),
        status: iface.status,
      });
    }

    console.log(`[web] 扫描完成: ${cachedResult.repos.length} 个仓库, ${cachedResult.ports.length} 个端口, ${ifaces.length} 个接口快照, ${new Date().toLocaleString('zh-CN')}`);

    // 检测同步问题，自动唤醒 Agent 处理
    const needsSync = cachedResult.repos.filter(r =>
      r.syncStatus === 'behind' || r.syncStatus === 'diverged'
    );
    if (needsSync.length > 0 && !_autoSyncRunning) {
      void autoSyncWithAgent(needsSync);
    }
    // 自动结晶化：检查有 package.json 但无结晶的项目
    void autoCrystallize(cachedResult.repos);
  } catch (e) {
    console.error('[web] 扫描失败:', e);
  } finally {
    isScanning = false;
  }
}

let _lastCrystallizeRun = 0;

async function autoCrystallize(repos: typeof cachedResult.repos) {
  const now = Date.now();
  if (now - _lastCrystallizeRun < 60 * 60 * 1000) return; // max once per hour
  _lastCrystallizeRun = now;

  try {
    const existingCrystals = listCrystals(SOTAGENT_DIR);
    const crystallizedProjects = new Set(existingCrystals.map(c => c.sourceProject));

    const candidates = repos.filter(r => {
      if (crystallizedProjects.has(r.name)) return false;
      try {
        return fs.existsSync(path.join(r.path, 'package.json'));
      } catch { return false; }
    });

    if (candidates.length === 0) return;

    // Crystallize up to 3 new projects per cycle
    const batch = candidates.slice(0, 3);
    for (const repo of batch) {
      try {
        const result = await crystallize(db, repo.path, {
          name: repo.name,
          useLLM: true,
          sotAgentRoot: SOTAGENT_DIR,
        });
        console.log(`[auto-crystallize] ${repo.name} → ${result.crystalId}`);
      } catch (e) {
        console.error(`[auto-crystallize] ${repo.name} 失败:`, e);
      }
    }
    if (batch.length > 0) {
      console.log(`[auto-crystallize] 本轮结晶 ${batch.length} 个项目，剩余 ${candidates.length - batch.length} 个待处理`);
    }
  } catch (e) {
    console.error('[auto-crystallize] 失败:', e);
  }
}

/**
 * 自动同步：先用规则引擎处理简单情况，复杂情况才唤醒 LLM Agent。
 * - behind + clean → 直接 pull（无需 LLM）
 * - behind + dirty → stash→pull→pop（无需 LLM）
 * - diverged → 尝试 LLM Agent，LLM 不可用时 skip
 */
async function autoSyncWithAgent(repos: typeof cachedResult.repos) {
  if (_autoSyncRunning) return;
  _autoSyncRunning = true;

  try {
    console.log(`[auto-sync] 检测到 ${repos.length} 个仓库需要同步...`);

    let handled = 0;
    const needsLlm: typeof repos = [];

    const POLARISOR = path.join(process.env.HOME || '~', 'Polarisor');

    for (const repo of repos) {
      const cwd = path.join(POLARISOR, repo.name);
      if (repo.syncStatus === 'behind' && repo.dirty === 0) {
        console.log(`[auto-sync] 📥 ${repo.name}: pull（落后 ${repo.behind}）`);
        try {
          const { stdout: beforeHash } = await execP('git rev-parse --short HEAD', { cwd, timeout: 3_000 });
          await execP('git pull --ff-only --quiet', { cwd, timeout: 30_000 });
          handled++;
          if (repo.name === 'SOTAgent' && beforeHash.trim()) {
            try {
              const { stdout: diffFiles } = await execP(
                `git diff ${beforeHash.trim()}..HEAD --name-only`, { cwd, timeout: 5_000 }
              );
              if (diffFiles.split('\n').some((f: string) => f.startsWith('you/'))) {
                writeInboxFlag('you_changed', {
                  changedFiles: diffFiles.split('\n').filter((f: string) => f.startsWith('you/')),
                });
                console.log('[auto-sync] 📬 SOTAgent you/ 有变更，已写入收件箱标记');
              }
            } catch { /* diff 失败不影响主流程 */ }
          }
        } catch (e: any) {
          console.error(`[auto-sync] ${repo.name} pull 失败:`, e.stderr || e.message);
        }
      } else if (repo.syncStatus === 'behind' && repo.dirty > 0) {
        console.log(`[auto-sync] 📦 ${repo.name}: stash→pull→pop（落后 ${repo.behind}，${repo.dirty} 个改动）`);
        try {
          await execP(`git stash push -m "auto-${Date.now()}"`, { cwd, timeout: 10_000 });
          await execP('git pull --ff-only --quiet', { cwd, timeout: 30_000 });
          await execP('git stash pop', { cwd, timeout: 10_000 });
          handled++;
        } catch (e: any) {
          console.error(`[auto-sync] ${repo.name} stash→pull→pop 失败:`, e.stderr || e.message);
          await execP('git stash pop', { cwd, timeout: 5_000 }).catch(() => {});
        }
      } else if (repo.syncStatus === 'diverged' && repo.dirty === 0) {
        console.log(`[auto-sync] 🔀 ${repo.name}: diverged (本端 ${repo.ahead} 领先, 远端 ${repo.behind} 领先), 尝试自动合并...`);
        try {
          const resolution = await resolveConflict({
            project: repo.name,
            type: 'diverged',
            localState: {
              project: repo.name,
              path: cwd,
              branch: 'main',
              headHash: '',
              hasUncommitted: false,
              uncommittedFiles: [],
              unpushedCount: repo.ahead ?? 0,
              remoteAhead: repo.behind ?? 0,
              lastActivityTs: new Date().toISOString(),
            },
            peerState: {
              project: repo.name,
              path: '',
              branch: 'main',
              headHash: '',
              hasUncommitted: false,
              uncommittedFiles: [],
              unpushedCount: 0,
              remoteAhead: 0,
              lastActivityTs: new Date().toISOString(),
            },
            detectedAt: new Date().toISOString(),
          });
          if (resolution.action === 'auto_resolved') {
            handled++;
            console.log(`[auto-sync] ✅ ${repo.name}: ${resolution.detail}`);
          } else {
            console.warn(`[auto-sync] ⚠️ ${repo.name}: ${resolution.detail}`);
            needsLlm.push(repo);
          }
        } catch (e: any) {
          console.error(`[auto-sync] ${repo.name} diverged 合并失败:`, e.message);
          needsLlm.push(repo);
        }
      } else if (repo.syncStatus === 'diverged' && repo.dirty > 0) {
        console.log(`[auto-sync] 🔀 ${repo.name}: diverged+dirty (本端 ${repo.ahead} 领先, 远端 ${repo.behind} 领先, ${repo.dirty} 改动), stash→合并→pop...`);
        try {
          const resolution = await resolveConflict({
            project: repo.name,
            type: 'diverged_with_changes',
            localState: {
              project: repo.name,
              path: cwd,
              branch: 'main',
              headHash: '',
              hasUncommitted: true,
              uncommittedFiles: [],
              unpushedCount: repo.ahead ?? 0,
              remoteAhead: repo.behind ?? 0,
              lastActivityTs: new Date().toISOString(),
            },
            peerState: {
              project: repo.name,
              path: '',
              branch: 'main',
              headHash: '',
              hasUncommitted: false,
              uncommittedFiles: [],
              unpushedCount: 0,
              remoteAhead: 0,
              lastActivityTs: new Date().toISOString(),
            },
            detectedAt: new Date().toISOString(),
          });
          if (resolution.action === 'auto_resolved') {
            handled++;
            console.log(`[auto-sync] ✅ ${repo.name}: ${resolution.detail}`);
          } else {
            console.warn(`[auto-sync] ⚠️ ${repo.name}: ${resolution.detail}`);
            needsLlm.push(repo);
          }
        } catch (e: any) {
          console.error(`[auto-sync] ${repo.name} diverged+dirty 合并失败:`, e.message);
          needsLlm.push(repo);
        }
      } else {
        needsLlm.push(repo);
      }
    }

    // 仍无法处理的复杂情况交给 LLM Agent
    if (needsLlm.length > 0) {
      try {
        const agentWasRunning = getAgentState().isRunning;
        if (!agentWasRunning) startAgent();

        const actions = await analyzeRepos(db);
        for (const action of actions) {
          if (action.action === 'report' || action.action === 'skip') continue;
          const result = await executeAction(action);
          if (!result.startsWith('ERROR')) handled++;
        }

        if (!agentWasRunning) stopAgent();
      } catch {
        console.log(`[auto-sync] LLM 不可用，跳过 ${needsLlm.length} 个复杂同步`);
      }
    }

    console.log(`[auto-sync] 完成: ${handled} 个仓库已自动同步`);
  } catch (e) {
    console.error('[auto-sync] 自动同步失败:', e);
  } finally {
    _autoSyncRunning = false;
  }
}

// 每 5 分钟定时扫描
setInterval(backgroundScan, 5 * 60 * 1000);

// 每 5 分钟清理死亡 Agent（30min 无心跳）
setInterval(() => {
  const pruned = db.pruneDeadAgents();
  if (pruned > 0) {
    console.log(`[agent] 清理 ${pruned} 个死亡 Agent`);
    if (db.countActiveAgents() === 0) {
      peerSync.pauseHeartbeat();
    }
  }
}, 5 * 60 * 1000);

// ─── 扫描 API ─────────────────────────────────────

app.get('/api/scan', (c) => c.json(cachedResult));

/** Coalesced scan — reuses backgroundScan's isScanning guard to prevent parallel git storms */
let _pendingScanResolvers: Array<(result: IScanResult) => void> = [];

async function coalescedScan(): Promise<IScanResult> {
  if (isScanning) {
    return new Promise<IScanResult>((resolve) => { _pendingScanResolvers.push(resolve); });
  }
  isScanning = true;
  try {
    cachedResult = await scanAll(db);
    for (const resolve of _pendingScanResolvers) resolve(cachedResult);
    _pendingScanResolvers = [];
    return cachedResult;
  } finally {
    isScanning = false;
  }
}

app.post('/api/scan/refresh', async (c) => {
  const result = await coalescedScan();
  return c.json(result);
});

app.post('/api/pull/:name', async (c) => {
  const name = c.req.param('name');
  try {
    const result = await pullRepo(name);
    await coalescedScan();
    return c.json({ ok: true, message: result });
  } catch (e) {
    return c.json({ ok: false, message: String(e) }, 500);
  }
});

app.post('/api/pull-all', async (c) => {
  const pulled = await pullAllClean(db);
  await coalescedScan();
  return c.json({ ok: true, pulled });
});

// ─── Ports API (facade → PolarPort) ──────────────────
startCacheRefresh('ports', async () => {
  try {
    const res = await fetch('http://127.0.0.1:11050/api/list?all=true', { signal: AbortSignal.timeout(5000) });
    if (res.ok) return await res.json();
  } catch { /* fallback */ }
  return null;
});

app.get('/api/ports', async (c) => {
  const cached = getCached('ports');
  if (cached) {
    bridgeListPorts(c, db).catch(() => {});
    return c.json(cached);
  }
  try {
    return await bridgeListPorts(c, db);
  } catch {
    return c.json([]);
  }
});
app.post('/api/ports/allocate', (c) => bridgeAllocatePort(c, db, deviceId));
app.post('/api/ports/release', (c) => bridgeReleasePort(c, db));
app.post('/api/ports/heartbeat', (c) => bridgePortHeartbeat(c, db, deviceId));

// ─── Preferred Port Reservations (facade → PolarPort) ───
app.post('/api/ports/reserve', (c) => bridgeReservePort(c, db));
app.delete('/api/ports/reserve/:service_name/:project', (c) => bridgeReleaseReserve(c, db));
app.get('/api/ports/reserved', (c) => bridgeListReserved(c, db));

// ─── Capability Registry API ─────────────────────────

app.post('/api/capabilities/register', async (c) => {
  try {
    const body = await c.req.json<{
      id: string; project: string; service_name: string;
      version?: string; transport?: string; endpoint?: string; method?: string;
      description?: string; input_schema?: object; output_schema?: object;
      error_types?: object; idempotent?: boolean; side_effects?: boolean; timeout_ms?: number;
    }>();
    if (!body.id || !body.project || !body.service_name) {
      return c.json({ ok: false, message: 'id, project, service_name required' }, 400);
    }
    db.registerCapability({
      ...body,
      input_schema: body.input_schema ? JSON.stringify(body.input_schema) : undefined,
      output_schema: body.output_schema ? JSON.stringify(body.output_schema) : undefined,
      error_types: body.error_types ? JSON.stringify(body.error_types) : undefined,
    });
    return c.json({ ok: true, id: body.id });
  } catch (e) {
    return c.json({ ok: false, message: String(e) }, 500);
  }
});

app.post('/api/capabilities/register-batch', async (c) => {
  try {
    const body = await c.req.json<{ capabilities: any[]; project: string; service_name: string }>();
    if (!Array.isArray(body.capabilities)) return c.json({ ok: false, message: 'capabilities array required' }, 400);
    let count = 0;
    for (const cap of body.capabilities) {
      db.registerCapability({
        id: cap.id,
        project: body.project ?? cap.project,
        service_name: body.service_name ?? cap.service_name,
        version: cap.version,
        transport: cap.transport,
        endpoint: cap.endpoint,
        method: cap.method,
        description: cap.description,
        input_schema: cap.input_schema ? JSON.stringify(cap.input_schema) : undefined,
        output_schema: cap.output_schema ? JSON.stringify(cap.output_schema) : undefined,
        error_types: cap.error_types ? JSON.stringify(cap.error_types) : undefined,
        idempotent: cap.idempotent,
        side_effects: cap.side_effects,
        timeout_ms: cap.timeout_ms,
      });
      count++;
    }
    return c.json({ ok: true, registered: count });
  } catch (e) {
    return c.json({ ok: false, message: String(e) }, 500);
  }
});

const _parseCapRow = (r: any) => ({
  ...r,
  input_schema: r.input_schema ? JSON.parse(r.input_schema) : null,
  output_schema: r.output_schema ? JSON.parse(r.output_schema) : null,
  error_types: r.error_types ? JSON.parse(r.error_types) : null,
  idempotent: !!r.idempotent,
  side_effects: !!r.side_effects,
});

app.get('/api/capabilities', (c) => {
  try {
    return c.json(db.listCapabilities().map(_parseCapRow));
  } catch (e) {
    return c.json({ ok: false, message: String(e) }, 500);
  }
});

app.get('/api/capabilities/search', (c) => {
  try {
    const q = (c.req.query('q') ?? '').toLowerCase();
    if (!q) return c.json([]);
    return c.json(db.searchCapabilities(q).map(_parseCapRow));
  } catch (e) {
    return c.json({ ok: false, message: String(e) }, 500);
  }
});

app.get('/api/capabilities/:id', (c) => {
  try {
    const id = c.req.param('id');
    const row = db.getCapability(id);
    if (!row) return c.json({ ok: false, message: 'Capability not found' }, 404);
    return c.json(_parseCapRow(row));
  } catch (e) {
    return c.json({ ok: false, message: String(e) }, 500);
  }
});

app.delete('/api/capabilities/:id', (c) => {
  try {
    const id = c.req.param('id');
    db.deleteCapability(id);
    return c.json({ ok: true, deleted: id });
  } catch (e) {
    return c.json({ ok: false, message: String(e) }, 500);
  }
});

app.get('/api/capabilities/stats/summary', (c) => {
  try {
    const all = db.listCapabilities();
    const byProject: Record<string, number> = {};
    const byTransport: Record<string, number> = {};
    for (const cap of all) {
      byProject[cap.project] = (byProject[cap.project] || 0) + 1;
      byTransport[cap.transport] = (byTransport[cap.transport] || 0) + 1;
    }
    return c.json({ total: all.length, by_project: byProject, by_transport: byTransport });
  } catch (e) {
    return c.json({ ok: false, message: String(e) }, 500);
  }
});

app.post('/api/capabilities/resync', (c) => {
  try {
    syncCapabilitiesFromDisk(db);
    const all = db.listCapabilities();
    return c.json({ ok: true, total: all.length });
  } catch (e) {
    return c.json({ ok: false, message: String(e) }, 500);
  }
});

// ─── Health Check ────────────────────────────────────

app.get('/api/health', (c) => {
  return c.json({ status: 'ok', service: 'sotagent', uptime: process.uptime() });
});

// ─── SOTAgent 状态 API ──────────────────────────────

app.get('/api/status', (c) => {
  const snapshots = db.recentSnapshots(deviceId, 1);
  const allTasks = db.listTasks();
  const projects = db.listProjects();
  const assets = db.listAssets();

  return c.json({
    device: {
      id: deviceId,
      hostname: os.hostname(),
      platform: `${os.platform()} ${os.arch()}`,
      totalMemGB: Math.round(os.totalmem() / 1073741824),
    },
    resource: snapshots[0] ?? null,
    tasks: {
      queued: allTasks.filter(t => t.status === 'queued').length,
      running: allTasks.filter(t => t.status === 'running').length,
      done: allTasks.filter(t => t.status === 'done').length,
      failed: allTasks.filter(t => t.status === 'failed').length,
    },
    projectCount: projects.length,
    assetCount: assets.length,
  });
});

app.get('/api/resources', (c) => {
  return c.json({
    snapshots: db.recentSnapshots(deviceId, 30),
    profiles: db.listProfiles(),
  });
});

app.get('/api/tasks', (c) => bridgeListTasks(c, db));

app.get('/api/tasks/:id', (c) => {
  const task = db.getTask(c.req.param('id'));
  if (!task) return c.json({ ok: false, message: '任务不存在' }, 404);
  return c.json(task);
});

app.get('/api/projects', (c) => c.json(db.listProjects()));

app.get('/api/assets', (c) => c.json(db.listAssets()));

app.get('/api/assets/stats', (c) => {
  try {
    const assets = db.listAssets();
    const syncCount = db.countSyncLog();
    const subs = db.allSubscriptions();
    const uniqueProjects = new Set(subs.map((s: any) => s.project_id)).size;
    return c.json({
      totalAssets: assets.length,
      totalSyncs: syncCount,
      totalSubscriptions: subs.length,
      uniqueProjects,
    });
  } catch (e) {
    return c.json({ totalAssets: 0, totalSyncs: 0, totalSubscriptions: 0, uniqueProjects: 0 });
  }
});

app.get('/api/assets/:type', (c) => {
  const type = c.req.param('type');
  return c.json(db.listAssets(type as any));
});

app.get('/api/sync-log', (c) => {
  const assetId = c.req.query('asset_id');
  const limit = parseInt(c.req.query('limit') || '50', 10);
  return c.json(db.getSyncHistory(assetId || undefined, limit));
});

app.get('/api/sync-events', (c) => c.json(db.recentSyncEvents(undefined, 50)));

app.get('/api/subscriptions', (c) => {
  const projectId = c.req.query('project_id');
  const assetId = c.req.query('asset_id');
  if (assetId) return c.json(db.getSubscribers(assetId));
  if (projectId) return c.json(db.getProjectSubscriptions(projectId));
  return c.json(db.allSubscriptions());
});

// ─── Architecture Topology API ───────────────────────

interface IArchNode {
  id: string;
  name: string;
  tier: string;
  status: string;
  description: string;
  version: string;
  requirements: Array<{ id: string; need: string; features: Array<{ name: string; status: string }>; blockers: string[] }>;
  interfaces: Array<{ name: string; endpoints?: string[]; status?: string }>;
  depends_on: string[];
  depended_by: string[];
  services: Array<{ id: string; name: string; status: string; port: number | null }>;
}

interface IArchEdge {
  source: string;
  target: string;
}

function scanArchitecture(): { nodes: IArchNode[]; edges: IArchEdge[] } {
  const nodes: IArchNode[] = [];
  const edges: IArchEdge[] = [];
  const services = db.listServices();

  const SERVICE_PROJECT_MAP: Record<string, string> = {
    'polarclock': 'Clock', 'privportal': 'PolarPrivate', 'polarcop': 'PolarCopilot',
    'digist': 'digist', 'polarclaw': 'PolarClaw', 'tqsdk': 'tqsdk',
    'autooffice': 'AutoOffice', 'sotagent': 'SOTAgent', 'ai-daily-digest': 'SOTAgent',
    'claude-code-vis': 'SOTAgent', 'eternal': 'tqsdk', 'knowlever': 'KnowLever',
    'tailscale': 'SOTAgent', 'ollama': 'SOTAgent', 'llama': 'SOTAgent',
  };

  function getServiceProject(serviceId: string): string | null {
    for (const [prefix, proj] of Object.entries(SERVICE_PROJECT_MAP)) {
      if (serviceId === prefix || serviceId.startsWith(prefix + '-') || serviceId.startsWith(prefix)) return proj;
    }
    return null;
  }

  const projectServices = new Map<string, typeof services>();
  for (const svc of services) {
    const proj = getServiceProject(svc.id);
    if (proj) {
      if (!projectServices.has(proj)) projectServices.set(proj, []);
      projectServices.get(proj)!.push(svc);
    }
  }

  try {
    const entries = fs.readdirSync(POLARISOR_ROOT, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
      const polarisPath = path.join(POLARISOR_ROOT, entry.name, 'polaris.json');
      try {
        if (!fs.existsSync(polarisPath)) continue;
        const data = JSON.parse(fs.readFileSync(polarisPath, 'utf-8'));

        const reqs = (data.requirements ?? []).map((r: any) => ({
          id: r.id,
          need: r.need,
          features: (r.features ?? []).map((f: any) => ({ name: f.name, status: f.status ?? 'unknown' })),
          blockers: r.blockers ?? [],
        }));

        const interfaces: IArchNode['interfaces'] = [];
        for (const req of data.requirements ?? []) {
          for (const feat of req.features ?? []) {
            if (feat.interfaces && Array.isArray(feat.interfaces)) {
              interfaces.push({ name: feat.name, endpoints: feat.interfaces, status: feat.status });
            }
          }
        }

        const svcList = (projectServices.get(data.name ?? entry.name) ?? []).map(s => ({
          id: s.id, name: s.name, status: s.status, port: s.port,
        }));

        nodes.push({
          id: data.name ?? entry.name,
          name: data.name ?? entry.name,
          tier: data.tier ?? 'unknown',
          status: data.status ?? 'unknown',
          description: data.description ?? '',
          version: data.version ?? '0.0.0',
          requirements: reqs,
          interfaces,
          depends_on: data.depends_on ?? [],
          depended_by: data.depended_by ?? [],
          services: svcList,
        });

        for (const dep of data.depends_on ?? []) {
          edges.push({ source: data.name ?? entry.name, target: dep });
        }
      } catch { /* skip unreadable */ }
    }
  } catch (e) {
    console.error('[architecture] scan failed:', e);
  }

  return { nodes, edges };
}

startCacheRefresh('architecture', async () => scanArchitecture());
app.get('/api/architecture', (c) => {
  const cached = getCached('architecture');
  if (cached) {
    return c.json(cached);
  }
  const data = scanArchitecture();
  updateCache('architecture', data);
  return c.json(data);
});

// ─── Interface Change Detection API ─────────────────

function scanInterfaces(): Array<{ project: string; interfaceName: string; endpoints: string[]; status: string }> {
  const result: Array<{ project: string; interfaceName: string; endpoints: string[]; status: string }> = [];
  try {
    const entries = fs.readdirSync(POLARISOR_ROOT, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
      const polarisPath = path.join(POLARISOR_ROOT, entry.name, 'polaris.json');
      try {
        if (!fs.existsSync(polarisPath)) continue;
        const data = JSON.parse(fs.readFileSync(polarisPath, 'utf-8'));
        const projectName = data.name ?? entry.name;
        for (const req of data.requirements ?? []) {
          for (const feat of req.features ?? []) {
            if (feat.interfaces && Array.isArray(feat.interfaces)) {
              result.push({
                project: projectName,
                interfaceName: feat.name,
                endpoints: feat.interfaces,
                status: feat.status ?? 'unknown',
              });
            }
          }
        }
      } catch { /* skip */ }
    }
  } catch { /* skip */ }
  return result;
}

app.get('/api/interface-changes', (c) => {
  const snapshots = db.listInterfaceSnapshots();
  const current = scanInterfaces();
  const changes: Array<{
    project: string;
    interfaceName: string;
    changeType: 'added' | 'removed' | 'modified';
    detail: string;
    detectedAt: string;
  }> = [];

  const snapshotMap = new Map<string, typeof snapshots[0]>();
  for (const s of snapshots) snapshotMap.set(`${s.project}::${s.interface_name}`, s);

  const currentKeys = new Set<string>();
  for (const cur of current) {
    const key = `${cur.project}::${cur.interfaceName}`;
    currentKeys.add(key);
    const prev = snapshotMap.get(key);
    if (!prev) {
      changes.push({ project: cur.project, interfaceName: cur.interfaceName, changeType: 'added', detail: `新增接口: ${cur.endpoints.join(', ')}`, detectedAt: new Date().toISOString() });
    } else {
      const prevEndpoints = JSON.parse(prev.endpoints_json);
      const curSorted = [...cur.endpoints].sort().join('|');
      const prevSorted = [...prevEndpoints].sort().join('|');
      if (curSorted !== prevSorted) {
        changes.push({ project: cur.project, interfaceName: cur.interfaceName, changeType: 'modified', detail: `端点变更: ${prevEndpoints.join(', ')} → ${cur.endpoints.join(', ')}`, detectedAt: new Date().toISOString() });
      }
    }
  }
  for (const s of snapshots) {
    const key = `${s.project}::${s.interface_name}`;
    if (!currentKeys.has(key)) {
      changes.push({ project: s.project, interfaceName: s.interface_name, changeType: 'removed', detail: `接口已移除`, detectedAt: new Date().toISOString() });
    }
  }

  return c.json({ changes, total: changes.length });
});

app.get('/api/interface-changes/:project', (c) => {
  const project = c.req.param('project');
  const snapshots = db.listInterfaceSnapshots(project);
  const current = scanInterfaces().filter(i => i.project === project);
  const changes: Array<{ interfaceName: string; changeType: string; detail: string; detectedAt: string }> = [];

  const snapshotMap = new Map<string, typeof snapshots[0]>();
  for (const s of snapshots) snapshotMap.set(s.interface_name, s);

  const currentKeys = new Set<string>();
  for (const cur of current) {
    currentKeys.add(cur.interfaceName);
    const prev = snapshotMap.get(cur.interfaceName);
    if (!prev) {
      changes.push({ interfaceName: cur.interfaceName, changeType: 'added', detail: `新增: ${cur.endpoints.join(', ')}`, detectedAt: new Date().toISOString() });
    } else {
      const prevEndpoints = JSON.parse(prev.endpoints_json);
      if ([...cur.endpoints].sort().join('|') !== [...prevEndpoints].sort().join('|')) {
        changes.push({ interfaceName: cur.interfaceName, changeType: 'modified', detail: `端点变更`, detectedAt: new Date().toISOString() });
      }
    }
  }
  for (const s of snapshots) {
    if (!currentKeys.has(s.interface_name)) {
      changes.push({ interfaceName: s.interface_name, changeType: 'removed', detail: '已移除', detectedAt: new Date().toISOString() });
    }
  }

  return c.json({ project, changes, total: changes.length });
});

app.post('/api/interface-snapshots/refresh', (c) => {
  const current = scanInterfaces();
  let upserted = 0;
  for (const iface of current) {
    db.upsertInterfaceSnapshot({
      project: iface.project,
      interface_name: iface.interfaceName,
      endpoints_json: JSON.stringify(iface.endpoints),
      status: iface.status,
    });
    upserted++;
  }
  return c.json({ ok: true, upserted });
});

// ─── Crystallize 结晶化 ─────────────────────────────

app.get('/api/crystals', (c) => c.json(listCrystals(SOTAGENT_DIR)));

app.post('/api/crystallize', async (c) => {
  try {
    const body = await c.req.json<{
      project_path: string;
      name?: string;
      description?: string;
      use_llm?: boolean;
      force?: boolean;
    }>();
    if (!body.project_path) return c.json({ error: 'project_path is required' }, 400);
    if (!fs.existsSync(body.project_path)) return c.json({ error: `Path not found: ${body.project_path}` }, 400);

    const result = await crystallize(db, body.project_path, {
      name: body.name,
      description: body.description,
      useLLM: body.use_llm ?? true,
      force: body.force ?? false,
      sotAgentRoot: SOTAGENT_DIR,
    });
    return c.json(result);
  } catch (e) {
    return c.json({ error: String(e) }, 500);
  }
});

app.post('/api/crystals/recrystallize-all', async (c) => {
  try {
    const existing = listCrystals(SOTAGENT_DIR);
    const results: Array<{ project: string; status: string; crystalId?: string }> = [];

    for (const crystal of existing) {
      const project = cachedResult.repos.find(r => r.name === crystal.sourceProject);
      if (!project) {
        results.push({ project: crystal.sourceProject, status: 'skipped — project not found' });
        continue;
      }
      try {
        const r = await crystallize(db, project.path, {
          name: project.name,
          useLLM: true,
          force: true,
          sotAgentRoot: SOTAGENT_DIR,
        });
        results.push({ project: project.name, status: 'ok', crystalId: r.crystalId });
      } catch (e) {
        results.push({ project: project.name, status: `error: ${String(e)}` });
      }
    }
    return c.json({ recrystallized: results.filter(r => r.status === 'ok').length, total: existing.length, results });
  } catch (e) {
    return c.json({ error: String(e) }, 500);
  }
});

app.post('/api/crystals/match', async (c) => {
  try {
    const body = await c.req.json<{
      keywords?: string[];
      project_type?: string[];
      tags?: string[];
    }>();
    const results = matchCrystals(
      SOTAGENT_DIR,
      body.keywords ?? [],
      body.project_type ?? [],
      body.tags ?? [],
    );
    return c.json(results);
  } catch (e) {
    return c.json({ error: String(e) }, 500);
  }
});

app.get('/api/agents', (c) => c.json(db.listAgents()));

// ─── Agent Session 生命周期 ─────────────────────────
// Agent 挂号（启动时调用）
app.post('/api/agent/register', async (c) => {
  try {
    const body = await c.req.json();
    const result = db.registerAgent({
      project_path: body.projectPath || '~/Polarisor',
      agent_type: body.agentType || 'solo',
      device_id: deviceId,
      session_id: body.sessionId,
      metadata: body.taskDescription,
    });

    // 有 Agent 活跃 → 确保 PeerSync 心跳运行
    if (db.countActiveAgents() > 0 && peerSync.isEnabled()) {
      peerSync.ensureHeartbeatRunning();
    }

    return c.json({ ok: true, ...result });
  } catch (e) {
    return c.json({ ok: false, message: String(e) }, 400);
  }
});

// Agent 心跳（每次任务开始时调用，证明自己活着）
app.post('/api/agent/heartbeat', async (c) => {
  try {
    const { sessionId } = await c.req.json();
    db.agentHeartbeat(sessionId);
    return c.json({ ok: true });
  } catch (e) {
    return c.json({ ok: false, message: String(e) }, 400);
  }
});

// Agent 销号（结束时调用）
app.post('/api/agent/deregister', async (c) => {
  try {
    const { sessionId } = await c.req.json();
    db.deregisterAgent(sessionId);

    // 所有 Agent 销号后 → 停止 PeerSync 心跳
    if (db.countActiveAgents() === 0) {
      peerSync.pauseHeartbeat();
    }

    return c.json({ ok: true });
  } catch (e) {
    return c.json({ ok: false, message: String(e) }, 400);
  }
});

// ─── Agent (LLM) API ────────────────────────────────

app.get('/api/agent/status', (c) => c.json(getAgentState()));

app.post('/api/agent/start', (c) => c.json(startAgent()));

app.post('/api/agent/stop', (c) => c.json(stopAgent()));

app.post('/api/agent/analyze', async (c) => {
  try {
    const actions = await analyzeRepos(db);
    return c.json({ ok: true, actions });
  } catch (e) {
    return c.json({ ok: false, message: String(e) }, 500);
  }
});

app.post('/api/agent/execute', async (c) => {
  try {
    const action = await c.req.json();
    const result = await executeAction(action);
    return c.json({ ok: true, result });
  } catch (e) {
    return c.json({ ok: false, message: String(e) }, 500);
  }
});

app.post('/api/agent/execute-all', async (c) => {
  try {
    const results = await executeAll();
    return c.json({ ok: true, results });
  } catch (e) {
    return c.json({ ok: false, message: String(e) }, 500);
  }
});

app.post('/api/agent/chat', async (c) => {
  try {
    const { message } = await c.req.json();
    const response = await chat(message, db);
    return c.json({ ok: true, response });
  } catch (e) {
    return c.json({ ok: false, message: String(e) }, 500);
  }
});

app.get('/api/agent/logs', (c) => {
  const s = getAgentState();
  return c.json(s.logs);
});

// ─── Agent Session（并发）API ────────────────────────────

app.get('/api/agent/sessions', (c) => c.json(listSessions()));

app.post('/api/agent/sessions', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const session = createSession(body.purpose || 'api-request');
  return c.json({ ok: true, session: session.getInfo() });
});

app.delete('/api/agent/sessions/:id', (c) => {
  const closed = closeSession(c.req.param('id'));
  return c.json({ ok: closed });
});

app.post('/api/agent/sessions/:id/analyze', async (c) => {
  const session = getSession(c.req.param('id'));
  if (!session?.isActive) return c.json({ ok: false, message: 'Session 不存在或已关闭' }, 404);
  try {
    const actions = await session.analyzeRepos(db);
    return c.json({ ok: true, actions });
  } catch (e) {
    return c.json({ ok: false, message: String(e) }, 500);
  }
});

app.post('/api/agent/sessions/:id/execute', async (c) => {
  const session = getSession(c.req.param('id'));
  if (!session?.isActive) return c.json({ ok: false, message: 'Session 不存在或已关闭' }, 404);
  try {
    const action = await c.req.json();
    const result = await session.executeAction(action);
    return c.json({ ok: true, result });
  } catch (e) {
    return c.json({ ok: false, message: String(e) }, 500);
  }
});

app.post('/api/agent/sessions/:id/chat', async (c) => {
  const session = getSession(c.req.param('id'));
  if (!session?.isActive) return c.json({ ok: false, message: 'Session 不存在或已关闭' }, 404);
  try {
    const { message } = await c.req.json();
    const response = await session.chat(message, db);
    return c.json({ ok: true, response });
  } catch (e) {
    return c.json({ ok: false, message: String(e) }, 500);
  }
});

app.post('/api/agent/sessions/:id/schedule-analyze', async (c) => {
  const session = getSession(c.req.param('id'));
  if (!session?.isActive) return c.json({ ok: false, message: 'Session 不存在或已关闭' }, 404);
  try {
    const { context } = await c.req.json();
    const actions = await session.analyzeForScheduling(context);
    return c.json({ ok: true, actions });
  } catch (e) {
    return c.json({ ok: false, message: String(e) }, 500);
  }
});

/** 一站式：创建 session + 分析 + 返回结果（调度器用，无需手动管理 session 生命周期） */
app.post('/api/agent/quick-analyze', async (c) => {
  const session = createSession('quick-analyze');
  try {
    const actions = await session.analyzeRepos(db);
    session.close();
    return c.json({ ok: true, session_id: session.id, actions });
  } catch (e) {
    session.close();
    return c.json({ ok: false, message: String(e) }, 500);
  }
});

app.post('/api/agent/quick-chat', async (c) => {
  const session = createSession('quick-chat');
  try {
    const { message } = await c.req.json();
    const response = await session.chat(message, db);
    const actions = session.getPendingActions();
    session.close();
    return c.json({ ok: true, session_id: session.id, response, actions });
  } catch (e) {
    session.close();
    return c.json({ ok: false, message: String(e) }, 500);
  }
});

// ─── 任务提交 API (facade → PolarProcess) ────────────

app.post('/api/tasks', (c) => bridgeCreateTask(c, db, deviceId));

app.patch('/api/tasks/:id', async (c) => {
  const id = c.req.param('id');
  try {
    const body = await c.req.json<{ status?: string; progress_percent?: number }>();
    const validStatuses = ['running', 'paused', 'done', 'failed'] as const;
    const status = body.status ?? 'done';
    if (!validStatuses.includes(status as any)) {
      return c.json({ ok: false, message: `无效状态: ${status}` }, 400);
    }
    db.updateTaskStatus(id, status as any, {
      progress_percent: body.progress_percent,
    });
    const labels: Record<string, string> = { done: '已完成', failed: '已失败', running: '运行中', paused: '已暂停' };
    return c.json({ ok: true, message: `任务 ${id} ${labels[status] ?? status}` });
  } catch (e) {
    return c.json({ ok: false, message: String(e) }, 400);
  }
});

app.delete('/api/tasks/:id', (c) => {
  const id = c.req.param('id');
  try {
    db.updateTaskStatus(id, 'failed');
    return c.json({ ok: true, message: `任务 ${id} 已取消` });
  } catch (e) {
    return c.json({ ok: false, message: String(e) }, 400);
  }
});

// ─── 资源画像 API ────────────────────────────────────

app.get('/api/profiler/snapshot', (c) => {
  try {
    const snap = profiler.sampleSystem(deviceId);
    return c.json(snap);
  } catch (e) {
    return c.json({ ok: false, message: String(e) }, 500);
  }
});

app.get('/api/profiler/idle', (c) => {
  return c.json(profiler.detectIdleWindow(deviceId));
});

app.get('/api/profiler/summary', (c) => {
  return c.json(profiler.getProfileSummary());
});

app.get('/api/profiler/trend', (c) => {
  const windowSize = parseInt(c.req.query('window') || '10', 10);
  return c.json(profiler.analyzeTrend(deviceId, windowSize));
});

app.get('/api/pressure', (c) => {
  return c.json(profiler.samplePressure(deviceId));
});

// ─── 外部进程托管 API (facade → PolarProcess) ────────

app.post('/api/processes/adopt', (c) => bridgeAdoptProcess(c, db, scheduler));
app.delete('/api/processes/:pid', (c) => bridgeDeleteProcess(c, db, scheduler));
app.get('/api/processes', (c) => bridgeListProcesses(c, db, scheduler));

// ─── 调度引擎 API (facade → PolarProcess) ───────────

app.get('/api/scheduler/reservations', (c) => bridgeSchedulerReservations(c, db, scheduler));
app.post('/api/scheduler/check-admission', (c) => bridgeSchedulerCheckAdmission(c, db, scheduler));

// ─── 任务转发接收 API (facade → PolarProcess) ──────

app.post('/api/tasks/forward', (c) => bridgeForwardTask(c, db));

// ─── 服务（进程）管理 API ──────────────────────────────

// ─── 服务（进程）管理 API (facade → PolarProcess) ────

startCacheRefresh('services-list', async () => {
  const result = await bridgeCall(
    BRIDGE_TARGETS.polarprocess!, 'GET', '/api/services', db
  );
  if (result.proxied && result.ok) return result.body;
  return [];
});

app.get('/api/services', async (c) => {
  const allDevices = c.req.query('all_devices') === 'true';
  const cacheKey = allDevices ? 'services-list-all' : 'services-list';
  const cached = getCached(cacheKey);
  if (cached) {
    (async () => {
      try {
        const result = await bridgeCall(
          BRIDGE_TARGETS.polarprocess!, 'GET',
          `/api/services${allDevices ? '?all_devices=true' : ''}`, db
        );
        if (result.proxied && result.ok) {
          updateCache(cacheKey, result.body);
        }
      } catch {}
    })();
    return c.json(cached);
  }
  // Cold start: fetch and cache
  const result = await bridgeCall(
    BRIDGE_TARGETS.polarprocess!, 'GET',
    `/api/services${allDevices ? '?all_devices=true' : ''}`, db
  );
  if (result.proxied && result.ok) {
    updateCache(cacheKey, result.body);
    return c.json(result.body);
  }
  return c.json([]);
});

app.get('/api/services/port-conflicts', (c) => bridgePortConflicts(c, db));

app.get('/api/services/events', (c) => bridgeServiceEvents(c, db));

app.get('/api/services/alerts', (c) => bridgeServiceAlerts(c, db));

app.get('/api/services/pending-restarts', (c) => {
  const pending = db.listPendingRestarts();
  const windowSec = config.silent_restart_window_sec ?? 7200;
  return c.json(pending.map(svc => {
    let remainingSec: number | null = null;
    if (svc.last_change_at) {
      const elapsed = (Date.now() - new Date(svc.last_change_at + 'Z').getTime()) / 1000;
      remainingSec = Math.max(0, Math.round(windowSec - elapsed));
    }
    return {
      id: svc.id,
      name: svc.name,
      last_change_at: svc.last_change_at,
      remaining_sec: remainingSec,
    };
  }));
});

app.get('/api/services/:id', (c) => bridgeGetService(c, db));

app.post('/api/services', (c) => bridgeRegisterService(c, db));

app.post('/api/services/register-and-start', (c) => bridgeRegisterAndStart(c, db));

app.post('/api/services/:id/start', (c) => bridgeStartService(c, db));

app.post('/api/services/:id/stop', (c) => bridgeStopService(c, db));

app.post('/api/services/:id/restart', (c) => bridgeRestartService(c, db));

app.post('/api/services/:id/reset-restart-count', (c) => {
  const id = c.req.param('id');
  const svc = db.getService(id);
  if (!svc) return c.json({ ok: false, message: `服务 ${id} 不存在` }, 404);
  db.updateServiceRestartCount(id, 0);
  db.updateServiceStatus(id, 'stopped');
  return c.json({ ok: true, message: `服务 ${svc.name} 重启计数已重置` });
});

app.post('/api/services/:id/notify-update', async (c) => {
  const id = c.req.param('id');
  const body = await c.req.json().catch(() => ({}));
  const strategy = body.strategy || 'restart';

  const svc = db.getService(id);
  if (!svc) return c.json({ ok: false, message: `服务 ${id} 不存在` }, 404);

  if (strategy === 'pending') {
    db.markPendingRestart(id);
    return c.json({
      ok: true,
      message: `${svc.name} 已标记待重启，静默窗口开始`,
      strategy: 'pending',
      pending_restart: true,
    });
  } else if (strategy === 'restart') {
    const result = await bridgeCall(
      BRIDGE_TARGETS.polarprocess!, 'POST', `/api/services/${id}/restart`, db
    );
    if (result.proxied && result.ok) return c.json({ ...(result.body as Record<string, unknown>), strategy: 'restart' });
    return c.json({ ok: false, message: 'PolarProcess 不可达' }, 502);
  } else if (strategy === 'signal') {
    if (svc.pid) {
      try {
        process.kill(svc.pid, 0);
        process.kill(svc.pid, 'SIGUSR2');
        return c.json({ ok: true, message: `已发送 SIGUSR2 到 ${svc.name} (pid=${svc.pid})`, strategy: 'signal' });
      } catch {
        return c.json({ ok: false, message: '信号发送失败' }, 500);
      }
    }
    return c.json({ ok: false, message: '服务未运行' }, 400);
  }

  return c.json({ ok: false, message: `未知策略: ${strategy}` }, 400);
});

app.get('/api/services/:id/restart-window', (c) => {
  const id = c.req.param('id');
  const svc = db.getService(id);
  if (!svc) return c.json({ ok: false, message: `服务 ${id} 不存在` }, 404);

  const windowSec = config.silent_restart_window_sec ?? 7200;
  const pending = svc.pending_restart === 1;
  let remainingSec: number | null = null;

  if (pending && svc.last_change_at) {
    const lastChange = new Date(svc.last_change_at + 'Z').getTime();
    const elapsed = (Date.now() - lastChange) / 1000;
    remainingSec = Math.max(0, Math.round(windowSec - elapsed));
  }

  return c.json({
    pending_restart: pending,
    last_change_at: svc.last_change_at,
    window_sec: windowSec,
    remaining_sec: remainingSec,
  });
});

// ─── PolarProcess 代理 API（带缓存）────────
const POLARPROCESS_URL = 'http://127.0.0.1:11055';

async function fetchPP(path: string): Promise<unknown> {
  const res = await fetch(`${POLARPROCESS_URL}${path}`, { signal: AbortSignal.timeout(5000) });
  if (!res.ok) return null;
  return res.json();
}

startCacheRefresh('pp-tasks', () => fetchPP('/api/tasks'));
startCacheRefresh('pp-watchdog', () => fetchPP('/api/watchdog/status'));
startCacheRefresh('pp-scheduler', () => fetchPP('/api/scheduler/status'));
startCacheRefresh('pp-health', () => fetchPP('/api/health'));

app.get('/api/polarprocess/tasks', async (c) => {
  const data = await getOrFetch('pp-tasks');
  return c.json(data ?? []);
});

app.get('/api/polarprocess/watchdog', async (c) => {
  const data = await getOrFetch('pp-watchdog');
  return c.json(data ?? []);
});

app.get('/api/polarprocess/scheduler', async (c) => {
  const data = await getOrFetch('pp-scheduler');
  return c.json(data ?? {});
});

app.get('/api/polarprocess/health', async (c) => {
  const data = await getOrFetch('pp-health');
  return c.json(data ?? { ok: false, reason: 'PolarProcess unreachable' });
});

// ─── 龙虾事件总线 API (facade → Hub) ────────────────

app.post('/api/lobster/events', (c) => bridgeLobsterPost(c, db, SOTAGENT_DIR));
app.get('/api/lobster/events', (c) => bridgeLobsterGet(c, db, SOTAGENT_DIR));

app.post('/api/lobster/arrow', async (c) => {
  try {
    const body = await c.req.json<{
      source_project: string;
      discovery_type: string;
      title: string;
      detail: string;
      severity?: 'info' | 'warn' | 'critical';
      evidence?: string[];
    }>();
    if (!body.source_project || !body.title || !body.detail) {
      return c.json({ ok: false, message: '缺少 source_project/title/detail' }, 400);
    }
    const result = crystallize_arrow(SOTAGENT_DIR, body);
    return c.json({ ok: true, ...result }, 201);
  } catch (e) {
    return c.json({ ok: false, message: String(e) }, 500);
  }
});

// ─── 成本透明 API ─────────────────────────────────────

const LLM_USAGE_PATH = path.join(process.env.HOME || os.homedir(), '.polarcop', 'logs', 'llm-usage.jsonl');
let _ppPortCache: { port: number; ts: number } | null = null;
const PP_PORT_TTL_MS = 5 * 60_000;

async function discoverPPPort(): Promise<number> {
  if (_ppPortCache && Date.now() - _ppPortCache.ts < PP_PORT_TTL_MS) return _ppPortCache.port;
  if (process.env.POLARPRIVATE_URL) return 0;
  try {
    const res = await fetch('http://127.0.0.1:11050/api/list?all=true', { signal: AbortSignal.timeout(2000) });
    if (res.ok) {
      const ports = (await res.json()) as { port: number; service_name: string; status: string }[];
      const active = ports.find(p => p.service_name === 'polarprivate' && p.status === 'active');
      if (active) {
        _ppPortCache = { port: active.port, ts: Date.now() };
        return active.port;
      }
    }
  } catch { /* fall through */ }
  const fallback = parseInt(process.env.POLARPRIVATE_PORT || '12790', 10);
  _ppPortCache = { port: fallback, ts: Date.now() };
  return fallback;
}

function getPPBaseUrl(): string {
  if (process.env.POLARPRIVATE_URL) return process.env.POLARPRIVATE_URL;
  const port = _ppPortCache?.port ?? parseInt(process.env.POLARPRIVATE_PORT || '12790', 10);
  return `http://127.0.0.1:${port}`;
}

// ─── Rate-limit dashboard cache (from PolarPrivate) ─────
async function fetchPrivPortal(apiPath: string): Promise<unknown> {
  await discoverPPPort();
  const base = getPPBaseUrl();
  const res = await fetch(`${base}${apiPath}`, { signal: AbortSignal.timeout(5000) });
  if (!res.ok) return null;
  return res.json();
}

startCacheRefresh('rate-limits', () => fetchPrivPortal('/api/rate-limits/dashboard'));

app.get('/api/rate-limits', async (c) => {
  const data = await getOrFetch('rate-limits');
  if (data) return c.json(data);
  return c.json({ ok: false, reason: 'PolarPrivate rate-limits unreachable' });
});

interface ILLMUsageEntry {
  ts: string;
  model?: string;
  input_tokens?: number;
  output_tokens?: number;
  total_tokens?: number;
  cost_usd?: number;
  task?: string;
  user?: string;
  agent_id?: string;
}

function readLLMUsage(): ILLMUsageEntry[] {
  try {
    if (!fs.existsSync(LLM_USAGE_PATH)) return [];
    const content = fs.readFileSync(LLM_USAGE_PATH, 'utf-8').trim();
    if (!content) return [];
    return content.split('\n').map(line => {
      try { return JSON.parse(line); }
      catch { return null; }
    }).filter(Boolean) as ILLMUsageEntry[];
  } catch { return []; }
}

async function fetchPolarPrivateUsage(): Promise<ILLMUsageEntry[]> {
  try {
    await discoverPPPort();
    const res = await fetch(`${getPPBaseUrl()}/proxy/usage/stats?days=90`, {
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return [];
    const data = await res.json() as {
      by_service?: Record<string, { requests: number; errors: number }>;
      daily?: Record<string, number>;
    };
    const entries: ILLMUsageEntry[] = [];
    if (data.daily) {
      for (const [date, count] of Object.entries(data.daily)) {
        entries.push({
          ts: `${date}T12:00:00Z`,
          total_tokens: count * 1000,
          cost_usd: 0,
          calls: count,
          task: 'proxy',
          model: 'polarprivate-proxy',
        } as any);
      }
    }
    return entries;
  } catch {
    return [];
  }
}

function aggregateCosts(entries: ILLMUsageEntry[], groupBy: 'day' | 'week' | 'month') {
  const buckets = new Map<string, { tokens: number; cost: number; calls: number }>();
  for (const e of entries) {
    if (!e.ts) continue;
    const d = new Date(e.ts);
    let key: string;
    if (groupBy === 'day') {
      key = d.toISOString().slice(0, 10);
    } else if (groupBy === 'week') {
      const jan1 = new Date(d.getFullYear(), 0, 1);
      const weekNum = Math.ceil(((d.getTime() - jan1.getTime()) / 86400000 + jan1.getDay() + 1) / 7);
      key = `${d.getFullYear()}-W${String(weekNum).padStart(2, '0')}`;
    } else {
      key = d.toISOString().slice(0, 7);
    }
    const bucket = buckets.get(key) ?? { tokens: 0, cost: 0, calls: 0 };
    bucket.tokens += e.total_tokens ?? (e.input_tokens ?? 0) + (e.output_tokens ?? 0);
    bucket.cost += e.cost_usd ?? 0;
    bucket.calls += (e as any).calls ?? 1;
    buckets.set(key, bucket);
  }
  return [...buckets.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([period, data]) => ({ period, ...data }));
}

function groupByField(entries: ILLMUsageEntry[], field: 'task' | 'user' | 'model') {
  const groups = new Map<string, { tokens: number; cost: number; calls: number }>();
  for (const e of entries) {
    const key = String(e[field] ?? 'unknown');
    const g = groups.get(key) ?? { tokens: 0, cost: 0, calls: 0 };
    g.tokens += e.total_tokens ?? (e.input_tokens ?? 0) + (e.output_tokens ?? 0);
    g.cost += e.cost_usd ?? 0;
    g.calls += (e as any).calls ?? 1;
    groups.set(key, g);
  }
  return [...groups.entries()]
    .sort((a, b) => b[1].cost - a[1].cost)
    .map(([name, data]) => ({ name, ...data }));
}

async function computeCostData() {
  const localEntries = readLLMUsage();
  const ppEntries = await fetchPolarPrivateUsage();
  const entries = [...localEntries, ...ppEntries];
  const totalTokens = entries.reduce((s, e) => s + (e.total_tokens ?? (e.input_tokens ?? 0) + (e.output_tokens ?? 0)), 0);
  const totalCost = entries.reduce((s, e) => s + (e.cost_usd ?? 0), 0);
  const totalCalls = entries.reduce((s, e) => s + ((e as any).calls ?? 1), 0);
  return {
    total: { tokens: totalTokens, cost_usd: Math.round(totalCost * 10000) / 10000, calls: totalCalls },
    daily: aggregateCosts(entries, 'day'),
    weekly: aggregateCosts(entries, 'week'),
    monthly: aggregateCosts(entries, 'month'),
    by_model: groupByField(entries, 'model'),
    by_task: groupByField(entries, 'task'),
    by_user: groupByField(entries, 'user'),
  };
}
startCacheRefresh('costs', computeCostData);

app.get('/api/costs', async (c) => {
  const data = await getOrFetch('costs');
  return c.json(data ?? { total: { tokens: 0, cost_usd: 0, calls: 0 }, daily: [], weekly: [], monthly: [], by_model: [], by_task: [], by_user: [] });
});

// ─── 设备管理 API ─────────────────────────────────────

app.get('/api/devices', (c) => c.json(db.listDevices()));

app.get('/api/devices/:id', (c) => {
  const device = db.getDevice(c.req.param('id'));
  if (!device) return c.json({ ok: false, message: '设备不存在' }, 404);
  return c.json(device);
});

app.put('/api/devices/:id', async (c) => {
  try {
    const body = await c.req.json();
    db.upsertDevice({ device_id: c.req.param('id'), ...body });
    return c.json({ ok: true });
  } catch (e) {
    return c.json({ ok: false, message: String(e) }, 400);
  }
});

// ─── 跨设备感知 (PeerSync) API ───────────────────────

// ─── 跨设备感知 (PeerSync) API (facade → PolarSync) ──

app.post('/api/peer/heartbeat', (c) => bridgePeerHeartbeat(c, db, peerSync));
app.post('/api/peer/notify', (c) => bridgePeerNotify(c, db, peerSync));
app.post('/api/peer/notify-push', (c) => bridgePeerNotifyPush(c, db, peerSync));
app.get('/api/peer/status', (c) => bridgePeerStatus(c, db, peerSync));
app.post('/api/peer/resolve', (c) => bridgePeerResolve(c, db, peerSync));

// ─── Funnel / Serve 管理 ────────────────────────────────

import {
  queryFunnelStatus,
  addFunnelRoute,
  removeFunnelRoute,
  resetAllFunnels,
} from './tailscale-client.js';
import {
  startMonitor as startKnowLeverMonitor,
  stopMonitor as stopKnowLeverMonitor,
} from './knowlever-monitor.js';
import { startSSoTWatcher, stopSSoTWatcher } from './ssot-watcher.js';
import { startAuditAggregator, stopAuditAggregator } from './ssot-audit-aggregator.js';

startCacheRefresh('funnel-status', async () => queryFunnelStatus());
app.get('/api/funnel/status', async (c) => {
  const data = await getOrFetch('funnel-status');
  return c.json(data ?? { domains: [] });
});

app.post('/api/funnel/health-check', async (c) => {
  try {
    const body = await c.req.json<{ proxies: string[] }>();
    if (!Array.isArray(body.proxies) || body.proxies.length === 0) {
      return c.json({ ok: false, message: 'proxies array required' }, 400);
    }
    const results: Record<string, 'ok' | 'down'> = {};
    await Promise.all(body.proxies.map(async (proxy) => {
      const target = proxy.replace(/^https?:\/\//, '').replace(/\/$/, '');
      const url = proxy.startsWith('http') ? proxy : `http://${proxy}`;
      try {
        const res = await fetch(url, { signal: AbortSignal.timeout(3000) });
        results[target] = res.ok || res.status < 500 ? 'ok' : 'down';
      } catch {
        results[target] = 'down';
      }
    }));
    return c.json({ ok: true, results });
  } catch (e) {
    return c.json({ ok: false, message: String(e) }, 500);
  }
});

app.post('/api/funnel/add', async (c) => {
  try {
    const { mountPath, target, asFunnel } = await c.req.json();
    if (!mountPath || !target) return c.json({ ok: false, message: '缺少 mountPath 或 target' }, 400);
    return c.json(await addFunnelRoute(mountPath, target, asFunnel ?? false));
  } catch (e) {
    return c.json({ ok: false, message: String(e) }, 500);
  }
});

app.post('/api/funnel/remove', async (c) => {
  try {
    const { mountPath } = await c.req.json();
    if (!mountPath) return c.json({ ok: false, message: '缺少 mountPath' }, 400);
    return c.json(await removeFunnelRoute(mountPath));
  } catch (e) {
    return c.json({ ok: false, message: String(e) }, 500);
  }
});

app.post('/api/funnel/reset', async (c) => {
  return c.json(await resetAllFunnels());
});

// ─── KnowLever 流水线 API ───────────────────────────────

// ─── KnowLever 流水线 API (facade → PolarOps) ────────
startCacheRefresh('knowlever-status', async () => {
  const { getOverallStatus } = await import('./knowlever-monitor.js');
  return await getOverallStatus();
});
startCacheRefresh('knowlever-topics', async () => {
  const { listAllTopics } = await import('./knowlever-monitor.js');
  return listAllTopics();
});

app.get('/api/knowlever/status', async (c) => {
  const cached = getCached('knowlever-status');
  if (cached) {
    bridgeKnowLeverStatus(c, db).catch(() => {});
    return c.json(cached);
  }
  try {
    const result = await bridgeKnowLeverStatus(c, db);
    return result;
  } catch {
    return c.json({ connected: false });
  }
});
app.get('/api/knowlever/topics', async (c) => {
  const cached = getCached('knowlever-topics');
  if (cached) {
    return c.json(cached);
  }
  try {
    const result = await bridgeKnowLeverTopics(c, db);
    return result;
  } catch {
    return c.json([]);
  }
});
app.get('/api/knowlever/users', (c) => bridgeKnowLeverUsers(c, db));
app.get('/api/knowlever/topics/:name', (c) => bridgeKnowLeverTopicDetail(c, db));
app.post('/api/knowlever/topics/:name/run', (c) => bridgeKnowLeverRun(c, db));
app.post('/api/knowlever/topics/:name/cancel', (c) => bridgeKnowLeverCancel(c, db));
app.get('/api/knowlever/topics/:name/progress', (c) => bridgeKnowLeverProgress(c, db));
app.get('/api/knowlever/config', (c) => bridgeKnowLeverConfigGet(c, db));
app.post('/api/knowlever/config', (c) => bridgeKnowLeverConfigPost(c, db));

const KNOWLEVER_ROOT_FOR_INGEST = path.join(process.env.HOME || '~', 'Polarisor', 'KnowLever');
const INGEST_STAGING_DIR = path.join(SOTAGENT_DIR, '.ingest-staging');
const INGEST_MAX_BYTES = 50 * 1024 * 1024;

async function runKnowLeverIngestCli(topicName: string, user: string, inputPath: string): Promise<{
  ok: boolean;
  skipped?: boolean;
  message?: string;
  stdout?: string;
  stderr?: string;
  exitCode?: number | null;
}> {
  if (!fs.existsSync(KNOWLEVER_ROOT_FOR_INGEST)) {
    return { ok: true, skipped: true, message: 'KnowLever root not found — ingest skipped', exitCode: null };
  }
  const topicDir = path.join(KNOWLEVER_ROOT_FOR_INGEST, 'data', 'users', user, 'topics', topicName);
  if (!fs.existsSync(topicDir)) {
    return { ok: false, message: `Topic directory not found for user ${user}`, exitCode: null };
  }
  const pathOk = validatePath(inputPath);
  if (!pathOk.ok) {
    return { ok: false, message: pathOk.reason, exitCode: null };
  }
  if (!fs.existsSync(inputPath)) {
    return { ok: false, message: 'Staging input missing', exitCode: null };
  }
  const cmd = `node wiki-engine/ingest.js ${shellEscape(inputPath)} --topic ${shellEscape(topicName)} --user ${shellEscape(user)}`;
  try {
    const { stdout, stderr } = await execP(cmd, {
      cwd: KNOWLEVER_ROOT_FOR_INGEST,
      timeout: 30 * 60_000,
      maxBuffer: 20 * 1024 * 1024,
    });
    return { ok: true, stdout, stderr, exitCode: 0, message: 'ingest completed' };
  } catch (e: any) {
    const stderr = (e.stderr?.toString?.() ?? e.message ?? String(e)).trim();
    const stdout = e.stdout?.toString?.() ?? '';
    const code = typeof e.code === 'number' ? e.code : 1;
    return { ok: false, stdout, stderr, exitCode: code, message: stderr || `ingest failed (exit ${code})` };
  }
}

app.post('/api/knowlever/topics/:name/ingest', async (c) => {
  const name = c.req.param('name');
  const topicCheck = validateTopicName(name);
  if (!topicCheck.ok) {
    return c.json({ ok: false, message: topicCheck.reason ?? 'Invalid topic name' }, 400);
  }
  const user = c.req.query('user') || 'admin';

  if (!fs.existsSync(KNOWLEVER_ROOT_FOR_INGEST)) {
    return c.json({ ok: true, skipped: true, message: 'KnowLever root not found — ingest skipped' });
  }

  let stagingPath: string | null = null;
  try {
    const ct = (c.req.header('content-type') || '').toLowerCase();
    if (ct.includes('multipart/form-data')) {
      const body = await c.req.parseBody();
      const file = body.file;
      if (file instanceof File && file.size > 0) {
        if (file.size > INGEST_MAX_BYTES) {
          return c.json({ ok: false, message: `File too large (max ${INGEST_MAX_BYTES} bytes)` }, 400);
        }
        const orig = path.basename(file.name || 'upload').replace(/[^\w.\-\u4e00-\u9fff]+/g, '_') || 'upload';
        fs.mkdirSync(INGEST_STAGING_DIR, { recursive: true });
        stagingPath = path.join(INGEST_STAGING_DIR, `${Date.now()}-${orig}`);
        const buf = Buffer.from(await file.arrayBuffer());
        fs.writeFileSync(stagingPath, buf);
      }
      if (!stagingPath) {
        const textField = body.text;
        if (typeof textField === 'string' && textField.trim()) {
          fs.mkdirSync(INGEST_STAGING_DIR, { recursive: true });
          stagingPath = path.join(INGEST_STAGING_DIR, `${Date.now()}-pasted.md`);
          fs.writeFileSync(stagingPath, textField, 'utf-8');
        }
      }
    } else {
      const body = await c.req.json().catch(() => ({})) as { text?: string };
      if (typeof body.text === 'string' && body.text.trim()) {
        const bytes = Buffer.byteLength(body.text, 'utf-8');
        if (bytes > INGEST_MAX_BYTES) {
          return c.json({ ok: false, message: `Text too large (max ${INGEST_MAX_BYTES} bytes)` }, 400);
        }
        fs.mkdirSync(INGEST_STAGING_DIR, { recursive: true });
        stagingPath = path.join(INGEST_STAGING_DIR, `${Date.now()}-pasted.md`);
        fs.writeFileSync(stagingPath, body.text, 'utf-8');
      }
    }

    if (!stagingPath) {
      return c.json({ ok: false, message: 'Provide a file (multipart field "file") or JSON/multipart field "text"' }, 400);
    }

    const stagedOk = validatePath(stagingPath);
    if (!stagedOk.ok) {
      return c.json({ ok: false, message: stagedOk.reason }, 400);
    }

    const result = await runKnowLeverIngestCli(name, user, stagingPath);
    const status = result.skipped ? 200 : result.ok ? 200 : 500;
    return c.json(result, status);
  } finally {
    if (stagingPath && fs.existsSync(stagingPath)) {
      try { fs.unlinkSync(stagingPath); } catch { /* ignore */ }
    }
  }
});

// ─── DiGist API (facade → PolarOps) ────────────────
startCacheRefresh('digist-status', async () => {
  const { getDigistStatus } = await import('./digist-monitor.js');
  return await getDigistStatus();
});

app.get('/api/digist/status', async (c) => {
  const cached = getCached('digist-status');
  try {
    return await bridgeDigistStatus(c, db);
  } catch {
    return c.json(cached ?? { connected: false });
  }
});
app.get('/api/digist/interests', (c) => bridgeDigistListInterests(c, db));
app.post('/api/digist/interests', (c) => bridgeDigistCreateInterest(c, db));
app.put('/api/digist/interests/:id', (c) => bridgeDigistUpdateInterest(c, db));
app.delete('/api/digist/interests/:id', (c) => bridgeDigistDeleteInterest(c, db));
app.get('/api/digist/sources', (c) => bridgeDigistListSources(c, db));
app.post('/api/digist/sources', (c) => bridgeDigistAddSource(c, db));
app.delete('/api/digist/sources/:id', (c) => bridgeDigistRemoveSource(c, db));
app.post('/api/digist/crawl/trigger', (c) => bridgeDigistCrawlTrigger(c, db));
app.get('/api/digist/crawl/history', (c) => bridgeDigistCrawlHistory(c, db));
app.post('/api/digist/sync-to-knowlever', (c) => bridgeDigistSyncToKnowLever(c, db));

// ─── SoTADiff Three-Layer Verification API (Phase 24) ────────────────

interface VerifyRequest {
  agent_id: string;
  git_commit?: string;
  intent: string;
  files: Array<{ path: string; op: string; lines_changed: number }>;
  summary: string;
  project_dir?: string;
}

interface VerifyResult {
  layer: 'blinding' | 'rule' | 'diff';
  passed: boolean;
  details: string;
  warnings?: string[];
}

/**
 * POST /api/checkup-events — receive forwarded checkup events from PolarCopilot Hub.
 * Per 任务书/260505_compiled/SOTAgent.md §6 工作项 C, append-only jsonl aggregation.
 * Body must conform to Agent_core/contracts/checkup-event.schema.json (validation
 * already happened upstream at Hub; this endpoint trusts schema-shape but rejects
 * obviously malformed payloads with a minimal duck check).
 */
app.post('/api/checkup-events', (c) => bridgeCheckupEvent(c, db));

app.post('/api/verify', async (c) => {
  try {
    const body = await c.req.json<VerifyRequest>();
    if (!body.agent_id || !body.files || !body.intent) {
      return c.json({ ok: false, error: 'missing_required_fields' }, 400);
    }

    const results: VerifyResult[] = [];

    // Layer 1: Blinding — check process + tech classification
    const blindingResult: VerifyResult = {
      layer: 'blinding',
      passed: true,
      details: 'Process verified',
      warnings: [],
    };
    if (!body.intent || body.intent.length < 5) {
      blindingResult.passed = false;
      blindingResult.details = 'Intent too short — must explain why this change was made';
    }
    if (body.files.some(f => f.lines_changed > 500)) {
      blindingResult.warnings!.push('Large change detected (>500 lines) — consider splitting');
    }
    const capRoutes = db.listCapabilities();
    const touchedServices = new Set<string>();
    for (const f of body.files) {
      const capMatch = capRoutes.find(cap =>
        f.path.includes(cap.service_name) || f.path.includes(cap.project));
      if (capMatch) touchedServices.add(capMatch.service_name);
    }
    if (touchedServices.size > 0) {
      blindingResult.details += ` | Touches ${touchedServices.size} registered service(s): ${[...touchedServices].join(', ')}`;
    }
    results.push(blindingResult);

    // Layer 2: Rule — check for conflicts with existing rules
    const ruleResult: VerifyResult = {
      layer: 'rule',
      passed: true,
      details: 'No rule conflicts detected',
      warnings: [],
    };
    const protectedPaths = ['.env', 'credentials', 'secrets', '.cursor/rules/'];
    for (const f of body.files) {
      if (protectedPaths.some(p => f.path.includes(p))) {
        if (f.path.includes('.cursor/rules/')) {
          ruleResult.warnings!.push(`Rule file modified: ${f.path} — ensure backward compatibility`);
        } else {
          ruleResult.passed = false;
          ruleResult.details = `Protected path modified: ${f.path}`;
        }
      }
    }
    if (body.files.some(f => f.op === 'delete' && f.lines_changed > 100)) {
      ruleResult.warnings!.push('Large deletion detected — verify no functionality loss');
    }
    results.push(ruleResult);

    // Layer 3: Diff — check for rollback of previous changes
    const diffResult: VerifyResult = {
      layer: 'diff',
      passed: true,
      details: 'No rollback detected',
      warnings: [],
    };
    if (body.files.some(f => f.op === 'delete')) {
      const deletedFiles = body.files.filter(f => f.op === 'delete').map(f => f.path);
      diffResult.warnings!.push(`Files deleted: ${deletedFiles.join(', ')} — verify intentional`);
    }
    results.push(diffResult);

    const allPassed = results.every(r => r.passed);
    const allWarnings = results.flatMap(r => r.warnings ?? []);

    return c.json({
      ok: true,
      verdict: allPassed ? (allWarnings.length > 0 ? 'pass_with_warnings' : 'pass') : 'fail',
      results,
      summary: allPassed
        ? `All 3 layers passed${allWarnings.length > 0 ? ` with ${allWarnings.length} warning(s)` : ''}`
        : `Verification failed: ${results.filter(r => !r.passed).map(r => r.layer).join(', ')}`,
    });
  } catch (e) {
    return c.json({ ok: false, error: String(e) }, 500);
  }
});

// 端口配置查询 API — 其他项目和前端可通过此接口获取所有端口
app.get('/api/ports/config', (c) => c.json(ALL_PORTS));

// Console 由 sotagent-console 服务提供（Vite dev server on :4880，支持 HMR）
// API 服务器（:4800）不托管 Console 静态文件

// ─── SSoT Audit API ──────────────────────────────────

const SSOT_AUDIT_OUTBOX = path.join(SOTAGENT_DIR, '.sotagent-outbox', 'ssot-audit');
const SSOT_INBOX_DIR = path.join(process.env.HOME || os.homedir(), '.sotagent', 'inbox');

interface AuditProjectStatus {
  name: string;
  lastAuditAt: string | null;
  severity: 'clean' | 'minor' | 'major' | 'critical' | 'unknown';
  issueCount: number;
  latestReportId: string | null;
}

interface InboxFlag {
  id: string;
  severity: string;
  project: string;
  findings: any[];
  timestamp: string;
  read: boolean;
}

app.get('/api/ssot/audit-status', (c) => {
  const projects: AuditProjectStatus[] = [];

  if (!fs.existsSync(SSOT_AUDIT_OUTBOX)) {
    return c.json({ projects });
  }

  try {
    const auditDirs = fs.readdirSync(SSOT_AUDIT_OUTBOX, { withFileTypes: true });
    for (const dir of auditDirs) {
      if (!dir.isDirectory()) continue;
      const dirPath = path.join(SSOT_AUDIT_OUTBOX, dir.name);
      const auditFiles = fs.readdirSync(dirPath)
        .filter(f => f.endsWith('.json'))
        .sort()
        .reverse();

      const latestFile = auditFiles[0] ?? null;
      if (!latestFile) {
        projects.push({
          name: dir.name,
          lastAuditAt: null,
          severity: 'unknown',
          issueCount: 0,
          latestReportId: null,
        });
        continue;
      }

      try {
        const auditData = JSON.parse(
          fs.readFileSync(path.join(dirPath, latestFile), 'utf-8')
        );
        const severity = auditData?.severity ?? 'unknown';
        const issueCount = auditData?.findings?.length ?? auditData?.issueCount ?? 0;
        const lastAuditAt = auditData?.timestamp ?? null;

        projects.push({
          name: dir.name,
          lastAuditAt: lastAuditAt ? new Date(lastAuditAt).toISOString() : null,
          severity: ['clean', 'minor', 'major', 'critical'].includes(severity)
            ? severity as AuditProjectStatus['severity']
            : 'unknown',
          issueCount: Number(issueCount) || 0,
          latestReportId: latestFile,
        });
      } catch {
        projects.push({
          name: dir.name,
          lastAuditAt: null,
          severity: 'unknown',
          issueCount: 0,
          latestReportId: latestFile,
        });
      }
    }
  } catch (e) {
    return c.json({ ok: false, message: String(e) }, 500);
  }

  return c.json({ projects });
});

app.get('/api/ssot/inbox-flags', (c) => {
  const flags: InboxFlag[] = [];

  if (!fs.existsSync(SSOT_INBOX_DIR)) {
    return c.json({ flags });
  }

  try {
    const flagFiles = fs.readdirSync(SSOT_INBOX_DIR)
      .filter(f => f.startsWith('ssot-') && f.endsWith('.flag'));

    for (const flagFile of flagFiles) {
      try {
        const flagData = JSON.parse(
          fs.readFileSync(path.join(SSOT_INBOX_DIR, flagFile), 'utf-8')
        );
        flags.push({
          id: flagFile.replace('.flag', ''),
          severity: flagData.severity ?? 'unknown',
          project: flagData.project ?? 'unknown',
          findings: flagData.findings ?? [],
          timestamp: flagData.timestamp ?? new Date().toISOString(),
          read: flagData.read ?? false,
        });
      } catch {
        // skip unreadable flags
      }
    }
  } catch (e) {
    return c.json({ ok: false, message: String(e) }, 500);
  }

  return c.json({ flags });
});

app.get('/api/ssot/audit-reports/:reportId', (c) => {
  const reportId = c.req.param('reportId');

  if (!fs.existsSync(SSOT_AUDIT_OUTBOX)) {
    return c.json({ ok: false, message: 'Audit outbox not found' }, 404);
  }

  try {
    // Search all project subdirectories for the report file
    const projectDirs = fs.readdirSync(SSOT_AUDIT_OUTBOX, { withFileTypes: true });
    for (const dir of projectDirs) {
      if (!dir.isDirectory()) continue;
      const reportPath = path.join(SSOT_AUDIT_OUTBOX, dir.name, reportId);
      if (fs.existsSync(reportPath)) {
        const reportData = JSON.parse(fs.readFileSync(reportPath, 'utf-8'));
        return c.json(reportData);
      }
    }
    return c.json({ ok: false, message: 'Report not found' }, 404);
  } catch (e) {
    return c.json({ ok: false, message: String(e) }, 500);
  }
});

// ─── 启动 ──────────────────────────────────────────

import { SOTAGENT_API_PORT, publishPortsFile, ALL_PORTS } from './ports.js';

const PORT = SOTAGENT_API_PORT;

const BIND_HOST = config.security?.bind_host ?? '127.0.0.1';

const httpServer = serve({ fetch: app.fetch, port: PORT, hostname: BIND_HOST }, async (info) => {
  const deviceId = getStableDeviceId();
  const peerLabel = peerSync.isEnabled() ? '已启用' : '未启用';
  const gwLabel = gateway.enabled ? `已启用 (${gateway.basePath}/*)` : '未启用';
  console.log(`
  ╔══════════════════════════════════════╗
  ║  SOTAgent Web Console API            ║
  ║  http://127.0.0.1:${info.port}              ║
  ║  设备: ${deviceId.padEnd(30)}║
  ║  定时扫描: 每 5 分钟                 ║
  ║  进程管理: 已启用                    ║
  ║  跨设备感知: ${peerLabel.padEnd(26)}║
  ║  Gateway: ${gwLabel.padEnd(28)}║
  ║  LLM Agent: 按需启动                ║
  ╚══════════════════════════════════════╝
  `);

  publishPortsFile();

  // 启动时扫描所有项目的 capabilities.json 并注册到 capability_registry
  syncCapabilitiesFromDisk(db);

  // Phase 16: 扫描 .planning/ 并生成 Cursor L3 预取规则
  try {
    const { refreshAllProjectMemory } = await import('./planning-scanner.js');
    const result = refreshAllProjectMemory();
    console.log(`[planning-scanner] Refreshed ${result.projects} projects, ${result.artifacts} artifacts`);
  } catch (e) {
    console.warn('[planning-scanner] Scan failed (non-fatal):', (e as Error).message);
  }

  setTimeout(backgroundScan, 100);

  // 注册内建服务（幂等：从 config.json built_in_services 读取）
  const builtInServices = config.built_in_services ?? [];
  for (const svc of builtInServices) {
    const norm = normalizeCommand(svc.command, svc.work_dir);
    db.registerService({
      id: svc.id,
      name: svc.name,
      command: norm.command,
      work_dir: norm.work_dir ?? svc.work_dir,
      port: svc.port,
      health_check_url: svc.health_check_url,
      auto_start: svc.auto_start ?? true,
      restart_on_failure: svc.restart_on_failure ?? true,
      max_restarts: svc.max_restarts ?? 5,
      cron_schedule: svc.cron_schedule ?? null,
      start_script_dir: svc.script_dir ?? null,
    });
  }
  if (builtInServices.length > 0) {
    console.log(`[web] 注册了 ${builtInServices.length} 个内建服务: ${builtInServices.map(s => s.name).join(', ')}`);
  }

  // PM lifecycle now runs in PolarProcess — not here
  console.log('[web] ProcessManager 已迁移到 PolarProcess，本地不再启动生命周期循环');

  // 启动跨设备感知
  peerSync.start();

  // 启动 KnowLever 监控
  startKnowLeverMonitor();

  // 启动 SSoT 实时文档变更检测
  startSSoTWatcher();

  // 启动 SSoT 定时审计结果聚合器
  startAuditAggregator();

  // ─── Facade Sunset Checker ───────────────────────────
  // 每小时检查一次迁移状态
  setInterval(async () => {
    try {
      const results = await runSunsetCheck(db);
      if (results.length > 0) {
        console.log(`[sunset-checker] 扫描完成: ${results.length} 个迁移中能力已检查`);
      }
    } catch (e) {
      console.error('[sunset-checker] 扫描失败:', e);
    }
  }, 60 * 60 * 1000);

  // 启动时立即执行一次 sunset check
  setTimeout(async () => {
    try {
      const results = await runSunsetCheck(db);
      if (results.length > 0) {
        console.log(`[sunset-checker] 初始扫描: ${results.length} 个迁移中能力`);
      }
    } catch (e) {
      console.error('[sunset-checker] 初始扫描失败:', e);
    }
  }, 30_000);

  // ─── 资源采样 + 调度引擎 ─────────────────────────────
  // Profiler 定时采样已禁用：profiler 使用 execSync (top/ioreg/vm_stat)
  // 会阻塞 event loop 5-10s，导致 API 周期性无响应。
  // 仅保留 on-demand（/api/profiler/snapshot）供手动调用。
  // TODO: 将 profiler 迁移到 worker_threads 后可重新启用。
  _snapshotTimer = null;
  _profileTimer = null;

  // 每 60s 运行调度循环 — 检查空闲窗口 → 启动/暂停/转发任务
  let _isScheduling = false;
  _scheduleTimer = setInterval(async () => {
    if (_isScheduling) return;
    _isScheduling = true;
    try {
      const report = await scheduler.runScheduleCycle();
      if (report.actions.length > 0) {
        console.log(`[scheduler] 调度: ${report.actions.map(a => `${a.action}(${a.task_id})`).join(', ')}`);
      }
    } catch (e) {
      console.error('[scheduler] 调度循环失败:', e);
    } finally {
      _isScheduling = false;
    }
  }, 60_000);

  // 每天清理过期数据 + 备份数据库
  _pruneTimer = setInterval(() => {
    db.pruneSnapshots(7);
    db.pruneLogs(30);
    db.backup(3);
    syncEngine.purgeStaleOutbox(3);
  }, 24 * 60 * 60 * 1000);

  // 启动时立即备份一次
  setTimeout(() => db.backup(3), 10_000);

  // 初始 profiler 采样已禁用（同上：execSync 阻塞）
  // setTimeout(() => { profiler.sampleAndRecord(deviceId); ... }, 120_000);
});

// WebSocket upgrade — gateway 代理
if (gateway.enabled) {
  httpServer.on('upgrade', (req, socket, head) => {
    gateway.handleUpgrade(req, socket as import('node:net').Socket, head);
  });
}

// 优雅退出
async function shutdown() {
  console.log('\n[web] 正在关闭...');
  if (_snapshotTimer) clearInterval(_snapshotTimer);
  if (_profileTimer) clearInterval(_profileTimer);
  if (_scheduleTimer) clearInterval(_scheduleTimer);
  if (_pruneTimer) clearInterval(_pruneTimer);
  stopAllCacheRefresh();
  stopKnowLeverMonitor();
  stopSSoTWatcher();
  stopAuditAggregator();
  peerSync.stop();
  db.close();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

process.on('uncaughtException', (err) => {
  console.error('[FATAL] Uncaught exception (process NOT crashing):', err);
});
process.on('unhandledRejection', (reason) => {
  console.error('[FATAL] Unhandled rejection (process NOT crashing):', reason);
});
