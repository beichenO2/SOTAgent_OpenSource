/**
 * facade.ts — Facade bridge orchestrator
 *
 * Manages service discovery (via PolarPort SDK) and provides a unified
 * proxy function used by all individual bridges.
 *
 * Each bridge:
 * 1. Discovers the target service port via PolarPort /api/ports
 * 2. Proxies the incoming request to the target
 * 3. Falls back to the local legacy handler on failure
 */

import type { SOTAgentDB } from '../db.js';

const POLARPORT_URL = process.env.POLARPORT_URL ?? 'http://127.0.0.1:11050';
const SOTAGENT_URL = process.env.SOTAGENT_URL ?? 'http://127.0.0.1:4800';

export interface ProxyResult {
  ok: boolean;
  status: number;
  body: unknown;
  proxied: boolean;
  target?: string;
  error?: string;
}

/** Service registry: maps bridge target name → discovery info */
export interface BridgeTarget {
  serviceName: string;
  project: string;
  defaultPort: number;
  envVar: string;
}

export const BRIDGE_TARGETS: Record<string, BridgeTarget> = {
  polarport:    { serviceName: 'polarport-api',  project: 'PolarPort',    defaultPort: 11050, envVar: 'POLARPORT_PORT' },
  polarprocess: { serviceName: 'polarprocess',   project: 'PolarProcess', defaultPort: 11055, envVar: 'POLARPROCESS_PORT' },
  polarsync:    { serviceName: 'polarsync',       project: 'PolarSync',    defaultPort: 11060, envVar: 'POLARSYNC_PORT' },
  polarops:     { serviceName: 'polarops',        project: 'PolarOps',     defaultPort: 11065, envVar: 'POLAROPS_PORT' },
  hub:          { serviceName: 'polarcop-hub',    project: 'PolarCopilot', defaultPort: 8040,  envVar: 'HUB_PORT' },
};

/**
 * Resolve the port for a bridge target.
 * Strategy: env var → PolarPort /api/ports → default
 */
export async function resolvePort(target: BridgeTarget, db: SOTAgentDB): Promise<number> {
  // 1. Env var override
  const envPort = parseInt(process.env[target.envVar] ?? '', 10);
  if (!isNaN(envPort) && envPort > 0) return envPort;

  // 2. Try PolarPort SDK discovery
  try {
    const ports = db.listActivePorts();
    const match = ports.find((p: any) =>
      p.service_name === target.serviceName ||
      p.project === target.project
    );
    if (match?.port) return match.port;
  } catch {
    // DB not available yet, continue
  }

  // 3. Default
  return target.defaultPort;
}

/**
 * Proxy an HTTP request to a target service.
 * Returns ProxyResult with the response or error.
 */
export async function proxyRequest(
  targetPort: number,
  method: string,
  path: string,
  body?: unknown,
  headers?: Record<string, string>,
): Promise<ProxyResult> {
  const url = `http://127.0.0.1:${targetPort}${path}`;
  try {
    const resp = await fetch(url, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...headers,
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(5_000),
    });

    let respBody: unknown;
    const ct = resp.headers.get('content-type') ?? '';
    if (ct.includes('application/json')) {
      respBody = await resp.json();
    } else {
      respBody = await resp.text();
    }

    return {
      ok: resp.status >= 200 && resp.status < 300,
      status: resp.status,
      body: respBody,
      proxied: true,
      target: `127.0.0.1:${targetPort}`,
    };
  } catch (err: any) {
    return {
      ok: false,
      status: 502,
      body: { ok: false, message: `Facade proxy failed: ${err.message}` },
      proxied: false,
      target: `127.0.0.1:${targetPort}`,
      error: err.message,
    };
  }
}

/**
 * Facade bridge: tries to proxy to the target, falls back to legacy handler.
 */
export async function bridgeCall(
  target: BridgeTarget,
  method: string,
  path: string,
  db: SOTAgentDB,
  body?: unknown,
  headers?: Record<string, string>,
): Promise<ProxyResult> {
  const port = await resolvePort(target, db);
  const result = await proxyRequest(port, method, path, body, headers);

  if (!result.proxied) {
    console.warn(`[facade] ${target.serviceName} unreachable at :${port}, falling back to legacy`);
  } else {
    console.log(`[facade] ${method} ${path} → :${port} (${result.status})`);
  }

  return result;
}

/**
 * Check if a bridge target is alive.
 */
export async function isTargetAlive(target: BridgeTarget, db: SOTAgentDB): Promise<boolean> {
  const port = await resolvePort(target, db);
  try {
    const resp = await fetch(`http://127.0.0.1:${port}/api/health`, {
      signal: AbortSignal.timeout(3000),
    });
    return resp.ok;
  } catch {
    return false;
  }
}
