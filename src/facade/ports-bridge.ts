/**
 * ports-bridge.ts — Facade bridge for /api/ports/* → PolarPort
 *
 * Pure proxy: all port operations delegate to PolarPort.
 * If PolarPort is unreachable, returns 502 (no local fallback).
 */

import type { Context } from 'hono';
import { bridgeCall, BRIDGE_TARGETS, type BridgeTarget } from './facade.js';
import type { SOTAgentDB } from '../db.js';

const TARGET: BridgeTarget = BRIDGE_TARGETS.polarport!;

export async function bridgeListPorts(c: Context, db: SOTAgentDB): Promise<Response> {
  const all = c.req.query('all') === 'true';
  const result = await bridgeCall(TARGET, 'GET', `/api/list${all ? '?all=true' : ''}`, db);

  if (result.proxied && result.ok) {
    return c.json(result.body);
  }

  return c.json({ ok: false, message: 'PolarPort unreachable' }, 502);
}

export async function bridgeAllocatePort(c: Context, db: SOTAgentDB, deviceId: string): Promise<Response> {
  const body = await c.req.json<{
    service_name: string;
    project: string;
    preferred_port?: number;
    range_start?: number;
    range_end?: number;
  }>();

  if (!body.service_name || !body.project) {
    return c.json({ ok: false, message: '缺少 service_name 或 project' }, 400);
  }

  const result = await bridgeCall(TARGET, 'POST', '/api/allocate', db, body);

  if (result.proxied && result.ok) {
    return c.json(result.body);
  }

  return c.json({ ok: false, message: 'PolarPort unreachable' }, 502);
}

export async function bridgeReleasePort(c: Context, db: SOTAgentDB): Promise<Response> {
  const body = await c.req.json<{ port: number }>();
  if (body.port == null) return c.json({ ok: false, message: '缺少 port' }, 400);

  const result = await bridgeCall(TARGET, 'POST', '/api/release', db, { port: body.port });

  if (result.proxied && result.ok) {
    return c.json(result.body);
  }

  return c.json({ ok: false, message: 'PolarPort unreachable' }, 502);
}

export async function bridgePortHeartbeat(c: Context, db: SOTAgentDB, deviceId: string): Promise<Response> {
  const body = await c.req.json<{
    port: number;
    pid?: number;
    service_name?: string;
    project?: string;
  }>();
  if (!body.port) return c.json({ ok: false, message: '缺少 port' }, 400);

  const result = await bridgeCall(TARGET, 'POST', '/api/heartbeat', db, body);

  if (result.proxied && result.ok) {
    return c.json(result.body);
  }

  return c.json({ ok: false, message: 'PolarPort unreachable' }, 502);
}

export async function bridgeReservePort(c: Context, db: SOTAgentDB): Promise<Response> {
  const body = await c.req.json<{
    service_name: string;
    project: string;
    preferred_port: number;
  }>();

  if (!body.service_name || !body.project || body.preferred_port == null) {
    return c.json({ ok: false, message: 'service_name, project, and preferred_port required' }, 400);
  }

  const result = await bridgeCall(TARGET, 'POST', '/api/ports/reserve', db, body);

  if (result.proxied && result.ok) {
    return c.json(result.body);
  }

  return c.json({ ok: false, message: 'PolarPort unavailable' }, 502);
}

export async function bridgeReleaseReserve(c: Context, db: SOTAgentDB): Promise<Response> {
  const sn = c.req.param('service_name');
  const pj = c.req.param('project');

  const result = await bridgeCall(TARGET, 'DELETE', `/api/ports/reserve/${sn}/${pj}`, db);

  if (result.proxied && result.ok) {
    return c.json(result.body);
  }

  return c.json({ ok: false, message: 'PolarPort unavailable' }, 502);
}

export async function bridgeListReserved(c: Context, db: SOTAgentDB): Promise<Response> {
  const result = await bridgeCall(TARGET, 'GET', '/api/ports/reserved', db);

  if (result.proxied && result.ok) {
    return c.json(result.body);
  }

  return c.json([], 502);
}
