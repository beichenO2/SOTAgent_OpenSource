/**
 * process-bridge.ts — Facade bridge for process/scheduler APIs → PolarProcess
 *
 * Bridges: /api/services/*, /api/processes/*, /api/tasks/*, /api/scheduler/*
 * Falls back to local SOTAgent ProcessManager/Scheduler on failure.
 */

import type { Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { bridgeCall, BRIDGE_TARGETS, type BridgeTarget } from './facade.js';
import type { SOTAgentDB } from '../db.js';
// ProcessManager removed — fully migrated to PolarProcess
import type { ResourceScheduler } from '../scheduler.js';

const TARGET: BridgeTarget = BRIDGE_TARGETS.polarprocess!;

/** Helper to safely use proxy result status with Hono's c.json() */
function jsonWithStatus(c: Context, body: unknown, status: number): Response {
  return c.json(body, status as ContentfulStatusCode);
}

// ─── Services ──────────────────────────────────────

export async function bridgeListServices(c: Context, db: SOTAgentDB): Promise<Response> {
  const allDevices = c.req.query('all_devices') === 'true';
  const result = await bridgeCall(TARGET, 'GET', `/api/services${allDevices ? '?all_devices=true' : ''}`, db);

  if (result.proxied && result.ok) {
    return c.json(result.body);
  }

  return c.json([]);
}

export async function bridgeGetService(c: Context, db: SOTAgentDB): Promise<Response> {
  const id = c.req.param('id')!;
  const result = await bridgeCall(TARGET, 'GET', `/api/services/${encodeURIComponent(id)}`, db);

  if (result.proxied && result.ok) {
    return c.json(result.body);
  }

  // Fallback: local db
  const svc = db.getService(id);
  if (!svc) return c.json({ ok: false, message: '服务不存在' }, 404);
  return c.json(svc);
}

export async function bridgeStartService(c: Context, db: SOTAgentDB): Promise<Response> {
  const id = c.req.param('id')!;
  const result = await bridgeCall(TARGET, 'POST', `/api/services/${encodeURIComponent(id)}/start`, db);

  if (result.proxied) {
    return jsonWithStatus(c, result.body, result.status);
  }

  return c.json({ ok: false, message: 'PolarProcess 不可达' }, 502);
}

export async function bridgeStopService(c: Context, db: SOTAgentDB): Promise<Response> {
  const id = c.req.param('id')!;
  const result = await bridgeCall(TARGET, 'POST', `/api/services/${encodeURIComponent(id)}/stop`, db);

  if (result.proxied) {
    return jsonWithStatus(c, result.body, result.status);
  }

  return c.json({ ok: false, message: 'PolarProcess 不可达' }, 502);
}

export async function bridgeRestartService(c: Context, db: SOTAgentDB): Promise<Response> {
  const id = c.req.param('id')!;
  const result = await bridgeCall(TARGET, 'POST', `/api/services/${encodeURIComponent(id)}/restart`, db);

  if (result.proxied) {
    return jsonWithStatus(c, result.body, result.status);
  }

  return c.json({ ok: false, message: 'PolarProcess 不可达' }, 502);
}

export async function bridgeRegisterService(c: Context, db: SOTAgentDB): Promise<Response> {
  const body = await c.req.json();
  const result = await bridgeCall(TARGET, 'POST', '/api/services', db, body);

  if (result.proxied) {
    return jsonWithStatus(c, result.body, result.status);
  }

  // Fallback: local db register
  try {
    if (body.command) {
      const { normalizeCommand } = await import('../command-guard.js');
      const norm = normalizeCommand(body.command, body.work_dir);
      body.command = norm.command;
      if (norm.work_dir) body.work_dir = norm.work_dir;
    }
    db.registerService(body);
    return c.json({ ok: true, message: `服务 ${body.name} 已注册` });
  } catch (e) {
    return c.json({ ok: false, message: String(e) }, 400);
  }
}

export async function bridgeRegisterAndStart(c: Context, db: SOTAgentDB): Promise<Response> {
  const body = await c.req.json();
  const result = await bridgeCall(TARGET, 'POST', '/api/services/register-and-start', db, body);

  if (result.proxied) {
    return jsonWithStatus(c, result.body, result.status);
  }

  // Fallback: local register only (no start — PM is in PolarProcess)
  try {
    if (!body.id) body.id = body.name?.replace(/[^a-zA-Z0-9_-]/g, '_') || `svc-${Date.now()}`;
    if (!body.name || !body.command) {
      return c.json({ ok: false, message: 'name and command are required' }, 400);
    }
    body.auto_start = body.auto_start ?? true;
    body.restart_on_failure = body.restart_on_failure ?? true;
    body.max_restarts = body.max_restarts ?? 5;

    if (body.command) {
      const { normalizeCommand } = await import('../command-guard.js');
      const norm = normalizeCommand(body.command, body.work_dir);
      body.command = norm.command;
      if (norm.work_dir) body.work_dir = norm.work_dir;
    }
    db.registerService(body);
    return c.json({ ok: true, service_id: body.id, message: `已注册 ${body.name}，PolarProcess 将自动启动` });
  } catch (e) {
    return c.json({ ok: false, message: String(e) }, 400);
  }
}

export async function bridgePortConflicts(c: Context, db: SOTAgentDB): Promise<Response> {
  const result = await bridgeCall(TARGET, 'GET', '/api/services/port-conflicts', db);

  if (result.proxied && result.ok) {
    return c.json(result.body);
  }

  return c.json([]);
}

export async function bridgeServiceEvents(c: Context, db: SOTAgentDB): Promise<Response> {
  const serviceId = c.req.query('service_id');
  const limit = parseInt(c.req.query('limit') || '100', 10);
  const result = await bridgeCall(TARGET, 'GET', `/api/services/events?service_id=${serviceId ?? ''}&limit=${limit}`, db);

  if (result.proxied && result.ok) {
    return c.json(result.body);
  }

  return c.json(db.listServiceEvents(serviceId || undefined, limit));
}

export async function bridgeServiceAlerts(c: Context, db: SOTAgentDB): Promise<Response> {
  const result = await bridgeCall(TARGET, 'GET', '/api/services/alerts', db);

  if (result.proxied && result.ok) {
    return c.json(result.body);
  }

  return c.json(db.listUnresolvedAlerts());
}

// ─── Processes ─────────────────────────────────────

export async function bridgeAdoptProcess(c: Context, db: SOTAgentDB, scheduler: ResourceScheduler): Promise<Response> {
  const body = await c.req.json<{ pid: number; task_type: string; owner: string }>();
  if (!body.pid || !body.task_type || !body.owner) {
    return c.json({ ok: false, message: '需要 pid, task_type, owner' }, 400);
  }

  const result = await bridgeCall(TARGET, 'POST', '/api/processes/adopt', db, body);

  if (result.proxied) {
    return jsonWithStatus(c, result.body, result.status);
  }

  return c.json(scheduler.adoptProcess(body.pid, body.task_type, body.owner));
}

export async function bridgeDeleteProcess(c: Context, db: SOTAgentDB, scheduler: ResourceScheduler): Promise<Response> {
  const pid = parseInt(c.req.param('pid')!, 10);
  if (isNaN(pid)) return c.json({ ok: false, message: '无效 PID' }, 400);

  const result = await bridgeCall(TARGET, 'DELETE', `/api/processes/${pid}`, db);

  if (result.proxied) {
    return jsonWithStatus(c, result.body, result.status);
  }

  return c.json(scheduler.releaseProcess(pid));
}

export async function bridgeListProcesses(c: Context, db: SOTAgentDB, scheduler: ResourceScheduler): Promise<Response> {
  const result = await bridgeCall(TARGET, 'GET', '/api/processes', db);

  if (result.proxied && result.ok) {
    return c.json(result.body);
  }

  return c.json({ processes: scheduler.listAdoptedProcesses() });
}

// ─── Tasks ─────────────────────────────────────────

export async function bridgeCreateTask(c: Context, db: SOTAgentDB, deviceId: string): Promise<Response> {
  const body = await c.req.json();
  if (!body.task_type || !body.command) {
    return c.json({ ok: false, message: '缺少必填字段 task_type 和 command' }, 400);
  }

  const result = await bridgeCall(TARGET, 'POST', '/api/tasks', db, body);

  if (result.proxied) {
    return jsonWithStatus(c, result.body, result.status);
  }

  // Fallback: local task creation
  try {
    const taskId = db.createHeavyTask({
      requester: body.requester || `api-${deviceId}`,
      task_type: body.task_type,
      command: body.command,
      priority: body.priority ?? 0,
      estimated_duration_sec: body.estimated_duration_sec,
      checkpoint_path: body.checkpoint_path,
      callback_url: body.callback_url,
      source_path: body.source_path,
      output_dir: body.output_dir,
    });
    const position = db.listTasks('queued').length;
    return c.json({ ok: true, task_id: taskId, position, message: '任务已入队，等待调度' });
  } catch (e) {
    return c.json({ ok: false, message: String(e) }, 400);
  }
}

export async function bridgeForwardTask(c: Context, db: SOTAgentDB): Promise<Response> {
  const body = await c.req.json();
  const result = await bridgeCall(TARGET, 'POST', '/api/tasks/forward', db, body);

  if (result.proxied) {
    return jsonWithStatus(c, result.body, result.status);
  }

  // Fallback: local forward = local create
  try {
    const taskId = db.createHeavyTask({
      requester: body.requester,
      task_type: body.task_type,
      command: body.command,
      priority: body.priority ?? 0,
      estimated_duration_sec: body.estimated_duration_sec,
      checkpoint_path: body.checkpoint_path,
    });
    return c.json({ ok: true, task_id: taskId, message: '任务已接收' });
  } catch (e) {
    return c.json({ ok: false, message: String(e) }, 400);
  }
}

export async function bridgeListTasks(c: Context, db: SOTAgentDB): Promise<Response> {
  const status = c.req.query('status');
  const type = c.req.query('type');
  const result = await bridgeCall(TARGET, 'GET', `/api/tasks?status=${status ?? ''}&type=${type ?? ''}`, db);

  if (result.proxied && result.ok) {
    return c.json(result.body);
  }

  // Fallback: local
  let tasks = status ? db.listTasks(status as any) : db.listTasks();
  if (type) tasks = tasks.filter(t => t.task_type === type);
  return c.json(tasks);
}

// ─── Scheduler ─────────────────────────────────────

export async function bridgeSchedulerReservations(c: Context, db: SOTAgentDB, scheduler: ResourceScheduler): Promise<Response> {
  const result = await bridgeCall(TARGET, 'GET', '/api/scheduler/reservations', db);

  if (result.proxied && result.ok) {
    return c.json(result.body);
  }

  return c.json(scheduler.getReservationSummary());
}

export async function bridgeSchedulerCheckAdmission(c: Context, db: SOTAgentDB, scheduler: ResourceScheduler): Promise<Response> {
  const body = await c.req.json();
  if (!body.task_type) return c.json({ ok: false, message: '缺少 task_type' }, 400);

  const result = await bridgeCall(TARGET, 'POST', '/api/scheduler/check-admission', db, body);

  if (result.proxied) {
    return jsonWithStatus(c, result.body, result.status);
  }

  // Fallback: local check
  const mockTask = {
    id: 'check', requester: 'api', task_type: body.task_type, command: '',
    priority: 0, status: 'queued' as const, progress_percent: 0,
    estimated_duration_sec: null, actual_start: null, actual_end: null,
    checkpoint_path: null, pid: null, created_at: '', notified_eta: null,
    callback_url: null, source_path: null, output_dir: null,
  };
  const r = scheduler.checkAdmission(mockTask);
  return c.json({ ok: true, ...r });
}
