/**
 * peer-sync-bridge.ts — Facade bridge for /api/peer/* → PolarSync
 *
 * Bridges peer heartbeat, notify, status, resolve.
 * Falls back to local SOTAgent PeerSync on failure.
 */

import type { Context } from 'hono';
import { bridgeCall, BRIDGE_TARGETS, type BridgeTarget } from './facade.js';
import type { SOTAgentDB } from '../db.js';
import type { PeerSync } from '../peer-sync.js';
import type { IPeerHeartbeat, IPeerNotification } from '../types.js';

const TARGET: BridgeTarget = BRIDGE_TARGETS.polarsync!;

export async function bridgePeerHeartbeat(c: Context, db: SOTAgentDB, peerSync: PeerSync): Promise<Response> {
  if (!peerSync.validatePeerSecret(c.req.header('X-Peer-Secret'))) {
    return c.json({ ok: false, message: 'Invalid peer secret' }, 403);
  }

  const heartbeat = await c.req.json() as IPeerHeartbeat;

  const result = await bridgeCall(TARGET, 'POST', '/api/peer/heartbeat', db, heartbeat);

  if (result.proxied && result.ok) {
    return c.json(result.body);
  }

  // Fallback: local PeerSync
  try {
    const r = await peerSync.receiveHeartbeat(heartbeat);
    return c.json({ ok: true, alerts: r.alerts });
  } catch (e) {
    return c.json({ ok: false, message: String(e) }, 400);
  }
}

export async function bridgePeerNotify(c: Context, db: SOTAgentDB, peerSync: PeerSync): Promise<Response> {
  if (!peerSync.validatePeerSecret(c.req.header('X-Peer-Secret'))) {
    return c.json({ ok: false, message: 'Invalid peer secret' }, 403);
  }

  const notification = await c.req.json() as IPeerNotification;

  const result = await bridgeCall(TARGET, 'POST', '/api/peer/notify', db, notification);

  if (result.proxied && result.ok) {
    return c.json(result.body);
  }

  // Fallback: local
  try {
    await peerSync.receiveNotification(notification);
    return c.json({ ok: true });
  } catch (e) {
    return c.json({ ok: false, message: String(e) }, 400);
  }
}

export async function bridgePeerNotifyPush(c: Context, db: SOTAgentDB, peerSync: PeerSync): Promise<Response> {
  const body = await c.req.json() as { project?: string };
  const project = body.project;
  if (!project) {
    return c.json({ ok: false, message: 'missing project name' }, 400);
  }

  const result = await bridgeCall(TARGET, 'POST', '/api/peer/notify-push', db, body);

  if (result.proxied && result.ok) {
    return c.json(result.body);
  }

  // Fallback: local
  const sent = await peerSync.notifyPeerPushCompleted(project);
  return c.json({
    ok: true,
    message: sent ? `已通知对端 ${project} push 完成` : '对端不可达，下次心跳时会自动同步',
    peerNotified: sent,
  });
}

export async function bridgePeerStatus(c: Context, db: SOTAgentDB, peerSync: PeerSync): Promise<Response> {
  const result = await bridgeCall(TARGET, 'GET', '/api/peer/status', db);

  if (result.proxied && result.ok) {
    return c.json(result.body);
  }

  // Fallback: local status
  const { getResolutionLog, resolveConflict } = await import('../conflict-resolver.js');
  return c.json({
    enabled: peerSync.isEnabled(),
    peerState: peerSync.getPeerState(),
    alerts: peerSync.getActiveAlerts(),
    recentNotifications: peerSync.getNotificationLog().slice(-20),
    resolutions: getResolutionLog().slice(-20),
  });
}

export async function bridgePeerResolve(c: Context, db: SOTAgentDB, peerSync: PeerSync): Promise<Response> {
  const result = await bridgeCall(TARGET, 'POST', '/api/peer/resolve', db);

  if (result.proxied && result.ok) {
    return c.json(result.body);
  }

  // Fallback: local resolve
  const { resolveConflict } = await import('../conflict-resolver.js');
  const alerts = peerSync.getActiveAlerts();
  if (alerts.length === 0) {
    return c.json({ ok: true, message: '无冲突需要解决', resolved: [] });
  }
  const resolved: Array<{ project: string; action: string; detail: string }> = [];
  for (const alert of alerts) {
    const r = await resolveConflict(alert);
    resolved.push({ project: r.project, action: r.action, detail: r.detail });
  }
  return c.json({ ok: true, resolved });
}
