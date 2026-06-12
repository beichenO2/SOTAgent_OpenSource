/**
 * inbox-bridge.ts — Facade bridge for lobster inbox-outbox → PolarCopilot Hub
 *
 * Bridges /api/lobster/events to Hub's lobster endpoint.
 * Falls back to local SOTAgent lobster jsonl on failure.
 */

import type { Context } from 'hono';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { bridgeCall, BRIDGE_TARGETS, type BridgeTarget } from './facade.js';
import type { SOTAgentDB } from '../db.js';
import { lobsterEventSchema, lobsterEventTypes } from '../types.js';
import type { ILobsterEventStored } from '../types.js';

const TARGET: BridgeTarget = BRIDGE_TARGETS.hub!;

export async function bridgeLobsterPost(c: Context, db: SOTAgentDB, sotagentDir: string): Promise<Response> {
  const body = await c.req.json();
  const parsed = lobsterEventSchema.safeParse(body);
  if (!parsed.success) {
    const errors = parsed.error.issues.map(i => `${i.path.join('.')}: ${i.message}`);
    return c.json({ ok: false, message: '事件校验失败', errors, valid_types: [...lobsterEventTypes] }, 400);
  }

  const event: ILobsterEventStored = {
    ...parsed.data,
    ts: parsed.data.ts || new Date().toISOString(),
    id: crypto.randomUUID(),
  };

  // Try proxy to Hub
  const result = await bridgeCall(TARGET, 'POST', '/api/lobster/events', db, event);

  if (result.proxied && result.ok) {
    return c.json({ ok: true, id: event.id, ts: event.ts, proxied_to: 'hub' }, 201);
  }

  // Fallback: local jsonl append
  const lobsterPath = path.join(sotagentDir, 'data', 'lobster-events.jsonl');
  try {
    fs.mkdirSync(path.dirname(lobsterPath), { recursive: true });
    fs.appendFileSync(lobsterPath, JSON.stringify(event) + '\n');
  } catch (e) {
    return c.json({ ok: false, message: String(e) }, 500);
  }

  return c.json({ ok: true, id: event.id, ts: event.ts, fallback: 'local' }, 201);
}

export async function bridgeLobsterGet(c: Context, db: SOTAgentDB, sotagentDir: string): Promise<Response> {
  const project = c.req.query('project');
  const since = c.req.query('since');
  const limit = Math.min(parseInt(c.req.query('limit') ?? '200', 10), 1000);
  const type = c.req.query('type');

  // For GET queries, always read from local jsonl (authoritative store)
  const lobsterPath = path.join(sotagentDir, 'data', 'lobster-events.jsonl');
  let events: ILobsterEventStored[] = [];
  try {
    if (fs.existsSync(lobsterPath)) {
      const lines = fs.readFileSync(lobsterPath, 'utf-8').trim().split('\n').filter(Boolean);
      for (const line of lines) {
        try { events.push(JSON.parse(line)); }
        catch { /* skip malformed */ }
      }
    }
  } catch {
    return c.json({ events: [], total: 0 });
  }

  if (project) events = events.filter(e => e.source_project === project || e.target_project === project);
  if (since) events = events.filter(e => e.ts >= since);
  if (type) events = events.filter(e => e.type === type);

  events.sort((a, b) => b.ts.localeCompare(a.ts));
  const total = events.length;
  events = events.slice(0, limit);

  return c.json({ events, total });
}
