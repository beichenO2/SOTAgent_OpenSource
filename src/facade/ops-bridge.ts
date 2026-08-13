/**
 * ops-bridge.ts — Facade bridge for monitoring APIs → PolarOps
 *
 * Bridges: /api/checkup-events, /api/digist/*, /api/knowlever/*
 * Falls back to local SOTAgent monitor modules on failure.
 */

import type { Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { bridgeCall, BRIDGE_TARGETS, type BridgeTarget } from './facade.js';
import type { SOTAgentDB } from '../db.js';

const TARGET: BridgeTarget = BRIDGE_TARGETS.polarops!;

/** Helper to safely use proxy result status with Hono's c.json() */
function jsonWithStatus(c: Context, body: unknown, status: number): Response {
  return c.json(body, status as ContentfulStatusCode);
}

// ─── Checkup Events ────────────────────────────────

export async function bridgeCheckupEvent(c: Context, db: SOTAgentDB): Promise<Response> {
  const body = await c.req.json();
  const result = await bridgeCall(TARGET, 'POST', '/api/checkup-events', db, body);

  if (result.proxied) {
    return jsonWithStatus(c, result.body, result.status);
  }

  // Fallback: local checkup aggregator
  try {
    const mod = await import('../checkup-aggregator.js');
    if (
      !body || typeof body !== 'object' ||
      typeof body.event_id !== 'string' ||
      typeof body.project !== 'string' ||
      typeof body.agent_target !== 'string' ||
      typeof body.timestamp !== 'string'
    ) {
      return c.json({ ok: false, error: 'invalid_payload' }, 400);
    }
    const envelope = mod.getCheckupAggregator().append(body, 'polarcop-hub');
    return c.json({ ok: true, received_at: envelope.received_at, event_id: body.event_id });
  } catch (err) {
    return c.json({ ok: false, error: 'append_failed', detail: err instanceof Error ? err.message : String(err) }, 500);
  }
}

// ─── KnowLever ─────────────────────────────────────

export async function bridgeKnowLeverStatus(c: Context, db: SOTAgentDB): Promise<Response> {
  const result = await bridgeCall(TARGET, 'GET', '/api/knowlever/status', db);
  if (result.proxied && result.ok) return c.json(result.body);

  const { getOverallStatus } = await import('../knowlever-monitor.js');
  return c.json(await getOverallStatus());
}

export async function bridgeKnowLeverTopics(c: Context, db: SOTAgentDB): Promise<Response> {
  const user = c.req.query('user') || 'all';
  const result = await bridgeCall(TARGET, 'GET', `/api/knowlever/topics?user=${encodeURIComponent(user)}`, db);
  if (result.proxied && result.ok) return c.json(result.body);

  const { listTopics, listAllTopics } = await import('../knowlever-monitor.js');
  if (user === 'all') return c.json(listAllTopics());
  return c.json(listTopics(user));
}

export async function bridgeKnowLeverTopicDetail(c: Context, db: SOTAgentDB): Promise<Response> {
  const name = c.req.param('name')!;
  const user = c.req.query('user') || 'admin';
  const result = await bridgeCall(TARGET, 'GET', `/api/knowlever/topics/${encodeURIComponent(name)}?user=${encodeURIComponent(user)}`, db);
  if (result.proxied && result.ok) return c.json(result.body);

  const { getTopicStatus } = await import('../knowlever-monitor.js');
  const topic = getTopicStatus(name, user);
  if (!topic) return c.json({ ok: false, message: 'Topic 不存在' }, 404);
  return c.json(topic);
}

export async function bridgeKnowLeverRun(c: Context, db: SOTAgentDB): Promise<Response> {
  const name = c.req.param('name')!;
  const user = c.req.query('user') || 'admin';
  const body = await c.req.json().catch(() => ({}));
  const outputs = body.outputs ?? ['html'];

  const result = await bridgeCall(TARGET, 'POST', `/api/knowlever/topics/${encodeURIComponent(name)}/run?user=${encodeURIComponent(user)}`, db, { outputs });
  if (result.proxied) return jsonWithStatus(c, result.body, result.status);

  const mod = await import('../knowlever-monitor.js');
  try {
    const run = await mod.runPipeline(name, outputs, user);
    return c.json({ ok: true, run });
  } catch (e) {
    return c.json({ ok: false, message: String(e) }, 500);
  }
}

export async function bridgeKnowLeverCancel(c: Context, db: SOTAgentDB): Promise<Response> {
  const name = c.req.param('name')!;
  const user = c.req.query('user') || 'admin';

  const result = await bridgeCall(TARGET, 'POST', `/api/knowlever/topics/${encodeURIComponent(name)}/cancel?user=${encodeURIComponent(user)}`, db);
  if (result.proxied) return jsonWithStatus(c, result.body, result.status);

  const { cancelPipeline } = await import('../knowlever-monitor.js');
  const cancelled = cancelPipeline(name, user);
  return c.json({ ok: cancelled });
}

export async function bridgeKnowLeverProgress(c: Context, db: SOTAgentDB): Promise<Response> {
  const name = c.req.param('name')!;
  const user = c.req.query('user') || 'admin';

  const result = await bridgeCall(TARGET, 'GET', `/api/knowlever/topics/${encodeURIComponent(name)}/progress?user=${encodeURIComponent(user)}`, db);
  if (result.proxied) return jsonWithStatus(c, result.body, result.status);

  const { getPipelineRun } = await import('../knowlever-monitor.js');
  const run = getPipelineRun(name, user);
  if (!run) return c.json({ ok: false, message: '无运行中的流水线' }, 404);
  return c.json(run);
}

export async function bridgeKnowLeverConfigGet(c: Context, db: SOTAgentDB): Promise<Response> {
  const result = await bridgeCall(TARGET, 'GET', '/api/knowlever/config', db);
  if (result.proxied && result.ok) return c.json(result.body);

  const { getConfig } = await import('../knowlever-monitor.js');
  return c.json(getConfig());
}

export async function bridgeKnowLeverConfigPost(c: Context, db: SOTAgentDB): Promise<Response> {
  const body = await c.req.json();
  const result = await bridgeCall(TARGET, 'POST', '/api/knowlever/config', db, body);
  if (result.proxied) return jsonWithStatus(c, result.body, result.status);

  const { updateConfig } = await import('../knowlever-monitor.js');
  try {
    return c.json(updateConfig(body));
  } catch (e) {
    return c.json({ ok: false, message: String(e) }, 400);
  }
}

export async function bridgeKnowLeverUsers(c: Context, db: SOTAgentDB): Promise<Response> {
  const result = await bridgeCall(TARGET, 'GET', '/api/knowlever/users', db);
  if (result.proxied && result.ok) return c.json(result.body);

  const { listUsers } = await import('../knowlever-monitor.js');
  return c.json(listUsers());
}

// ─── DiGist ────────────────────────────────────────

export async function bridgeDigistStatus(c: Context, db: SOTAgentDB): Promise<Response> {
  const result = await bridgeCall(TARGET, 'GET', '/api/digist/status', db);
  if (result.proxied && result.ok) return c.json(result.body);

  const { getDigistStatus } = await import('../digist-monitor.js');
  return c.json(await getDigistStatus());
}

export async function bridgeDigistListInterests(c: Context, db: SOTAgentDB): Promise<Response> {
  const limit = parseInt(c.req.query('limit') || '0', 10);
  const result = await bridgeCall(TARGET, 'GET', '/api/digist/interests', db);
  if (result.proxied && result.ok) {
    const data = Array.isArray(result.body) && limit > 0 ? result.body.slice(0, limit) : result.body;
    return c.json(data);
  }

  const { listInterests } = await import('../digist-monitor.js');
  const all = listInterests();
  return c.json(limit > 0 ? all.slice(0, limit) : all);
}

export async function bridgeDigistCreateInterest(c: Context, db: SOTAgentDB): Promise<Response> {
  const body = await c.req.json();
  const result = await bridgeCall(TARGET, 'POST', '/api/digist/interests', db, body);
  if (result.proxied) return jsonWithStatus(c, result.body, result.status);

  const { createInterest } = await import('../digist-monitor.js');
  const r = createInterest(body);
  return c.json(r, r.ok ? 200 : 400);
}

export async function bridgeDigistUpdateInterest(c: Context, db: SOTAgentDB): Promise<Response> {
  const id = c.req.param('id')!;
  const body = await c.req.json();
  const result = await bridgeCall(TARGET, 'PUT', `/api/digist/interests/${encodeURIComponent(id)}`, db, body);
  if (result.proxied) return jsonWithStatus(c, result.body, result.status);

  const { updateInterest } = await import('../digist-monitor.js');
  const r = updateInterest(id, body);
  return c.json(r, r.ok ? 200 : r.message === 'not found' ? 404 : 400);
}

export async function bridgeDigistDeleteInterest(c: Context, db: SOTAgentDB): Promise<Response> {
  const id = c.req.param('id')!;
  const result = await bridgeCall(TARGET, 'DELETE', `/api/digist/interests/${encodeURIComponent(id)}`, db);
  if (result.proxied) return jsonWithStatus(c, result.body, result.status);

  const { deleteInterest } = await import('../digist-monitor.js');
  const r = deleteInterest(id);
  return c.json(r, r.ok ? 200 : 400);
}

export async function bridgeDigistListSources(c: Context, db: SOTAgentDB): Promise<Response> {
  const limit = parseInt(c.req.query('limit') || '0', 10);
  const result = await bridgeCall(TARGET, 'GET', '/api/digist/sources', db);
  if (result.proxied && result.ok) {
    const data = Array.isArray(result.body) && limit > 0 ? result.body.slice(0, limit) : result.body;
    return c.json(data);
  }

  const { listSources } = await import('../digist-monitor.js');
  const all = listSources();
  return c.json(limit > 0 ? all.slice(0, limit) : all);
}

export async function bridgeDigistAddSource(c: Context, db: SOTAgentDB): Promise<Response> {
  const body = await c.req.json();
  const result = await bridgeCall(TARGET, 'POST', '/api/digist/sources', db, body);
  if (result.proxied) return jsonWithStatus(c, result.body, result.status);

  const { addSource } = await import('../digist-monitor.js');
  const r = addSource(body);
  return c.json(r, r.ok ? 200 : 400);
}

export async function bridgeDigistRemoveSource(c: Context, db: SOTAgentDB): Promise<Response> {
  const id = c.req.param('id')!;
  const result = await bridgeCall(TARGET, 'DELETE', `/api/digist/sources/${encodeURIComponent(id)}`, db);
  if (result.proxied) return jsonWithStatus(c, result.body, result.status);

  const { removeSource } = await import('../digist-monitor.js');
  const r = removeSource(id);
  return c.json(r, r.ok ? 200 : 404);
}

export async function bridgeDigistCrawlTrigger(c: Context, db: SOTAgentDB): Promise<Response> {
  const body = await c.req.json().catch(() => ({}));
  const result = await bridgeCall(TARGET, 'POST', '/api/digist/crawl/trigger', db, body);
  if (result.proxied) return jsonWithStatus(c, result.body, result.status);

  const { triggerCrawl } = await import('../digist-monitor.js');
  const r = await triggerCrawl(body);
  return c.json(r, r.ok ? 200 : 502);
}

export async function bridgeDigistCrawlHistory(c: Context, db: SOTAgentDB): Promise<Response> {
  const limit = parseInt(c.req.query('limit') || '50', 10);
  const result = await bridgeCall(TARGET, 'GET', `/api/digist/crawl/history?limit=${limit}`, db);
  if (result.proxied && result.ok) return c.json(result.body);

  const { getCrawlHistory } = await import('../digist-monitor.js');
  return c.json(getCrawlHistory(limit));
}

export async function bridgeDigistSyncToKnowLever(c: Context, db: SOTAgentDB): Promise<Response> {
  const body = await c.req.json();
  const result = await bridgeCall(TARGET, 'POST', '/api/digist/sync-to-knowlever', db, body);
  if (result.proxied) return jsonWithStatus(c, result.body, result.status);

  const { syncToKnowLever } = await import('../digist-monitor.js');
  try {
    const r = await syncToKnowLever(body);
    return c.json(r, r.ok ? 200 : 400);
  } catch (e) {
    return c.json({ ok: false, message: String(e) }, 500);
  }
}
