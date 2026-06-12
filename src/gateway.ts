/**
 * gateway.ts — SOTAgent 反向代理网关
 *
 * 将 /gw/<prefix>/* 请求代理到后端微服务端口，实现统一入口。
 * 后端端口通过以下优先级发现：
 *   1. config.json gateway.routes 中的固定映射
 *   2. port_registry 表中的动态注册（PolarPort SDK 分配）
 *
 * 支持 HTTP 请求流式代理（含 SSE），WebSocket 通过 HTTP Upgrade 代理。
 */

import http from 'node:http';
import type { Context, Next } from 'hono';
import type { SOTAgentDB } from './db.js';
import _Ajv from 'ajv';
const Ajv = (_Ajv as any).default || _Ajv;

const ajv = new Ajv({ allErrors: true, strict: false });

interface EnvelopeError { ok: false; error: { code: string; message: string; schema_diff?: Record<string, unknown> } }

function normalizeUpstreamError(status: number, body: Buffer<ArrayBufferLike>): Buffer<ArrayBufferLike> | null {
  if (status < 400) return null;
  try {
    const json = JSON.parse(body.toString('utf-8'));
    if (typeof json !== 'object' || json === null) return null;
    if (json.ok === false && json.error?.code) return null; // already normalized

    let envelope: EnvelopeError;
    if (json.ok === false && typeof json.message === 'string') {
      envelope = { ok: false, error: { code: 'SOT_ERROR', message: json.message } };
    } else if (typeof json.detail === 'string') {
      const code = typeof json.code === 'string' ? `PP_${json.code}` : `PP_HTTP_${status}`;
      envelope = { ok: false, error: { code, message: json.detail } };
    } else if (typeof json.error === 'string' && !json.code) {
      const code = `DIG_${json.error.toUpperCase().replace(/\s+/g, '_')}`;
      envelope = { ok: false, error: { code, message: json.message || json.error } };
    } else if (typeof json.code === 'string' && typeof json.status_code === 'number') {
      envelope = { ok: false, error: { code: `TQ_${json.code}`, message: json.message || json.detail || 'Unknown' } };
    } else {
      return null;
    }
    return Buffer.from(JSON.stringify(envelope), 'utf-8');
  } catch {
    return null;
  }
}

export interface IGatewayRoute {
  prefix: string;
  target_port: number;
  target_host?: string;
  strip_prefix?: boolean;
  service_id?: string;
}

export interface IGatewayConfig {
  enabled: boolean;
  base_path: string;
  routes: IGatewayRoute[];
}

const DEFAULT_CONFIG: IGatewayConfig = {
  enabled: false,
  base_path: '/gw',
  routes: [],
};

export class Gateway {
  private config: IGatewayConfig;
  private db: SOTAgentDB;
  private routeMap: Map<string, IGatewayRoute> = new Map();

  constructor(config: Partial<IGatewayConfig> | undefined, db: SOTAgentDB) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.db = db;
    this.rebuildRouteMap();
  }

  get enabled(): boolean { return this.config.enabled; }
  get basePath(): string { return this.config.base_path; }

  private rebuildRouteMap(): void {
    this.routeMap.clear();
    for (const route of this.config.routes) {
      this.routeMap.set(route.prefix, route);
    }
  }

  /**
   * Resolve a prefix to a target port. Static routes take priority,
   * then fall back to port_registry by service_name matching the prefix.
   */
  private resolveTarget(prefix: string): { host: string; port: number; stripPrefix: boolean } | null {
    const staticRoute = this.routeMap.get(prefix);
    if (staticRoute && staticRoute.target_port > 0) {
      return {
        host: staticRoute.target_host ?? '127.0.0.1',
        port: staticRoute.target_port,
        stripPrefix: staticRoute.strip_prefix !== false,
      };
    }

    // Fall through to DB for dynamic port lookup (covers target_port=0
    // and routes not in config)
    const activePorts = this.db.listActivePorts();
    const match = activePorts.find(p =>
      p.service_name.toLowerCase().includes(prefix.toLowerCase()) ||
      p.project.toLowerCase().includes(prefix.toLowerCase())
    );
    if (match) {
      return {
        host: staticRoute?.target_host ?? '127.0.0.1',
        port: match.port,
        stripPrefix: staticRoute?.strip_prefix !== false,
      };
    }

    return null;
  }

  /**
   * Hono middleware — intercepts requests under basePath and proxies them.
   */
  middleware() {
    return async (c: Context, next: Next) => {
      if (!this.config.enabled) return next();

      const url = new URL(c.req.url);
      const pathname = url.pathname;

      if (!pathname.startsWith(this.config.base_path + '/')) {
        return next();
      }

      const rest = pathname.slice(this.config.base_path.length + 1);
      const slashIdx = rest.indexOf('/');
      const prefix = slashIdx === -1 ? rest : rest.slice(0, slashIdx);
      const remainder = slashIdx === -1 ? '' : rest.slice(slashIdx);

      if (!prefix) return next();

      const target = this.resolveTarget(prefix);
      if (!target) {
        return c.json({
          ok: false,
          error: { code: 'GATEWAY_NO_ROUTE', message: `No backend for prefix: ${prefix}` },
        }, 502);
      }

      const targetPath = target.stripPrefix ? (remainder || '/') : `/${prefix}${remainder}`;
      const targetUrl = `http://${target.host}:${target.port}${targetPath}${url.search}`;

      const validationError = await this.validateRequestSchema(c, prefix, remainder);
      if (validationError) return validationError;

      try {
        return await this.proxyRequest(c, targetUrl, target.host, target.port, targetPath + url.search);
      } catch (e: any) {
        const msg = e.code === 'ECONNREFUSED'
          ? `Backend ${prefix} not reachable at :${target.port}`
          : String(e.message || e);
        return c.json({
          ok: false,
          error: { code: 'GATEWAY_UPSTREAM_ERROR', message: msg },
        }, 502);
      }
    };
  }

  private async validateRequestSchema(c: Context, prefix: string, endpoint: string): Promise<Response | null> {
    if (c.req.method === 'GET' || c.req.method === 'HEAD' || c.req.method === 'OPTIONS') {
      return null;
    }

    const cap = this.db.getCapabilityByRoute(prefix, endpoint);
    if (!cap?.input_schema) return null;

    let schema: Record<string, unknown>;
    try {
      schema = typeof cap.input_schema === 'string' ? JSON.parse(cap.input_schema) : cap.input_schema;
    } catch {
      return null;
    }

    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({
        ok: false,
        error: { code: 'SCHEMA_VALIDATION_ERROR', message: 'Request body must be valid JSON' },
      } satisfies EnvelopeError, 400);
    }

    const validate = ajv.compile(schema);
    if (!validate(body)) {
      const errors = validate.errors ?? [];
      return c.json({
        ok: false,
        error: {
          code: 'SCHEMA_VALIDATION_ERROR',
          message: errors.map((e: any) => `${e.instancePath || '/'} ${e.message}`).join('; '),
          schema_diff: {
            expected_schema: schema,
            validation_errors: errors.map((e: any) => ({
              path: e.instancePath || '/',
              keyword: e.keyword,
              message: e.message,
              params: e.params,
            })),
          },
        },
      } satisfies EnvelopeError, 400);
    }

    return null;
  }

  private proxyRequest(c: Context, _targetUrl: string, host: string, port: number, path: string): Promise<Response> {
    return new Promise((resolve, reject) => {
      const incomingHeaders: Record<string, string> = {};
      c.req.raw.headers.forEach((v, k) => {
        if (k === 'host') return;
        incomingHeaders[k] = v;
      });
      incomingHeaders['x-forwarded-for'] = c.req.header('x-forwarded-for') ?? '127.0.0.1';
      incomingHeaders['x-forwarded-host'] = c.req.header('host') ?? '';
      incomingHeaders['x-gateway-prefix'] = 'sotagent';

      const proxyReq = http.request(
        {
          hostname: host,
          port,
          path,
          method: c.req.method,
          headers: incomingHeaders,
          timeout: 120_000,
        },
        (proxyRes) => {
          const status = proxyRes.statusCode ?? 502;
          const responseHeaders = new Headers();
          for (const [k, v] of Object.entries(proxyRes.headers)) {
            if (v == null) continue;
            const val = Array.isArray(v) ? v.join(', ') : v;
            if (k.toLowerCase() === 'transfer-encoding') continue;
            responseHeaders.set(k, val);
          }

          const isSSE = (proxyRes.headers['content-type'] ?? '').includes('text/event-stream');
          if (isSSE) {
            const stream = new ReadableStream({
              start(controller) {
                proxyRes.on('data', (chunk: Buffer) => controller.enqueue(chunk));
                proxyRes.on('end', () => controller.close());
                proxyRes.on('error', (e) => controller.error(e));
              },
            });
            resolve(new Response(stream, { status, headers: responseHeaders }));
            return;
          }

          const chunks: Buffer[] = [];
          proxyRes.on('data', (chunk: Buffer) => chunks.push(chunk));
          proxyRes.on('end', () => {
            let body: Buffer<ArrayBufferLike> = Buffer.concat(chunks);
            const ct = (proxyRes.headers['content-type'] ?? '').toLowerCase();
            if (status >= 400 && ct.includes('application/json')) {
              const normalized = normalizeUpstreamError(status, body);
              if (normalized) {
                body = normalized;
                responseHeaders.set('content-type', 'application/json; charset=utf-8');
                responseHeaders.set('x-envelope-normalized', '1');
              }
            }
            resolve(new Response(body, { status, headers: responseHeaders }));
          });
          proxyRes.on('error', reject);
        },
      );

      proxyReq.on('error', reject);
      proxyReq.on('timeout', () => {
        proxyReq.destroy();
        reject(new Error('Gateway proxy timeout'));
      });

      if (c.req.method !== 'GET' && c.req.method !== 'HEAD') {
        c.req.raw.body
          ? c.req.raw.arrayBuffer().then(buf => {
              proxyReq.end(Buffer.from(buf));
            })
          : proxyReq.end();
      } else {
        proxyReq.end();
      }
    });
  }

  /**
   * Handle HTTP Upgrade (WebSocket) — called from Node http.Server 'upgrade' event.
   */
  handleUpgrade(req: http.IncomingMessage, socket: import('node:net').Socket, head: Buffer): void {
    if (!this.config.enabled) return;

    const pathname = req.url ?? '';
    if (!pathname.startsWith(this.config.base_path + '/')) return;

    const rest = pathname.slice(this.config.base_path.length + 1);
    const slashIdx = rest.indexOf('/');
    const prefix = slashIdx === -1 ? rest : rest.slice(0, slashIdx);
    const remainder = slashIdx === -1 ? '' : rest.slice(slashIdx);

    if (!prefix) return;

    const target = this.resolveTarget(prefix);
    if (!target) {
      socket.end('HTTP/1.1 502 Bad Gateway\r\n\r\n');
      return;
    }

    const targetPath = target.stripPrefix ? (remainder || '/') : `/${prefix}${remainder}`;

    const proxyReq = http.request({
      hostname: target.host,
      port: target.port,
      path: targetPath,
      method: 'GET',
      headers: {
        ...req.headers,
        host: `${target.host}:${target.port}`,
      },
    });

    proxyReq.on('upgrade', (proxyRes, proxySocket, proxyHead) => {
      const statusLine = `HTTP/1.1 ${proxyRes.statusCode} ${proxyRes.statusMessage}\r\n`;
      let headerStr = '';
      for (const [k, v] of Object.entries(proxyRes.headers)) {
        if (v == null) continue;
        const val = Array.isArray(v) ? v.join(', ') : v;
        headerStr += `${k}: ${val}\r\n`;
      }
      socket.write(statusLine + headerStr + '\r\n');
      if (proxyHead.length > 0) socket.write(proxyHead);

      proxySocket.pipe(socket);
      socket.pipe(proxySocket);

      proxySocket.on('error', () => socket.destroy());
      socket.on('error', () => proxySocket.destroy());
      proxySocket.on('close', () => socket.destroy());
      socket.on('close', () => proxySocket.destroy());
    });

    proxyReq.on('error', () => {
      socket.end('HTTP/1.1 502 Bad Gateway\r\n\r\n');
    });

    proxyReq.end(head);
  }

  /** List all configured routes (for /api/gateway/routes) */
  listRoutes(): Array<{ prefix: string; target: string; service_id?: string }> {
    return this.config.routes.map(r => ({
      prefix: r.prefix,
      target: `http://${r.target_host ?? '127.0.0.1'}:${r.target_port}`,
      service_id: r.service_id,
    }));
  }
}
