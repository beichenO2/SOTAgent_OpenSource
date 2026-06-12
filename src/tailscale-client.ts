/**
 * tailscale-client.ts — Tailscale IP 查询
 *
 * 通过 `tailscale status --json` CLI 命令获取设备 IP。
 * Tailscale IP 不是敏感信息，可以直接查询和使用。
 */

import { execSync, exec } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";

const execAsync = promisify(exec);

interface ITailscaleStatus {
  Self: { TailscaleIPs: string[]; HostName: string };
  Peer: Record<string, { TailscaleIPs: string[]; HostName: string; Online: boolean }>;
}

/** 内存缓存，避免每次都执行 CLI */
let _cache: { data: ITailscaleStatus; expiresAt: number } | null = null;
const CACHE_TTL_MS = 60_000; // 1 分钟

/** 已探测到的 tailscale 二进制路径 */
let _resolvedBin: string | null = null;

/**
 * 探测 tailscale CLI 二进制路径。
 * macOS App Store 版不会将 CLI 加到 PATH，需要从 .app bundle 中查找。
 */
function resolveTailscaleBin(): string {
  if (_resolvedBin) return _resolvedBin;

  // 优先：PATH 中直接可用
  try {
    execSync("tailscale version", { timeout: 3_000, stdio: "pipe" });
    _resolvedBin = "tailscale";
    return _resolvedBin;
  } catch { /* fallthrough */ }

  // macOS App Store 版：二进制在 .app bundle 内
  const appStorePath = "/Applications/Tailscale.app/Contents/MacOS/Tailscale";
  if (fs.existsSync(appStorePath)) {
    _resolvedBin = appStorePath;
    return _resolvedBin;
  }

  // 都找不到，回退默认名（会在 queryTailscaleStatus 中捕获错误）
  _resolvedBin = "tailscale";
  return _resolvedBin;
}

async function queryTailscaleStatus(): Promise<ITailscaleStatus | null> {
  const cached = _cache;
  if (cached && cached.expiresAt > Date.now()) return cached.data;

  try {
    const bin = resolveTailscaleBin();
    const { stdout } = await execAsync(`${bin} status --json`, { timeout: 5_000 });
    const data = JSON.parse(stdout) as ITailscaleStatus;
    _cache = { data, expiresAt: Date.now() + CACHE_TTL_MS };
    return data;
  } catch {
    return null;
  }
}

/** 本机 IPv4 Tailscale 地址 */
export async function getLocalTailscaleIP(): Promise<string | null> {
  const status = await queryTailscaleStatus();
  if (!status) return null;
  return status.Self.TailscaleIPs.find((ip) => !ip.includes(":")) ?? null;
}

/**
 * 根据设备 ID（config.json 中的 key，如 "mac-studio"）获取对端 IP。
 * 匹配逻辑：HostName 做大小写/连字符模糊匹配。
 */
export async function getPeerTailscaleIP(deviceId: string): Promise<string | null> {
  const status = await queryTailscaleStatus();
  if (!status) return null;

  const normalized = deviceId.toLowerCase().replace(/-/g, "");

  for (const peer of Object.values(status.Peer)) {
    const peerName = peer.HostName.toLowerCase().replace(/-/g, "").replace(/ /g, "");
    if (peerName.includes(normalized) || normalized.includes(peerName)) {
      return peer.TailscaleIPs.find((ip) => !ip.includes(":")) ?? null;
    }
  }
  return null;
}

/** 检查 Tailscale 是否可用 */
export async function isTailscaleAvailable(): Promise<boolean> {
  return (await queryTailscaleStatus()) !== null;
}

/** 清除缓存（测试用） */
export function clearTailscaleCache(): void {
  _cache = null;
}

// ─── Funnel / Serve 管理 ──────────────────────────────────

export interface IFunnelHandler {
  Proxy?: string;
  Path?: string;
  Text?: string;
}

export interface IFunnelDomain {
  domain: string;
  port: number;
  isFunnel: boolean;
  handlers: Array<{ path: string; proxy: string }>;
}

export interface IFunnelStatus {
  domains: IFunnelDomain[];
  raw: Record<string, unknown>;
}

/**
 * 查询当前设备的 Tailscale serve/funnel 配置（`tailscale serve status --json`）
 */
export async function queryFunnelStatus(): Promise<IFunnelStatus> {
  try {
    const bin = resolveTailscaleBin();
    const { stdout } = await execAsync(`${bin} serve status --json`, { timeout: 5_000 });
    const data = JSON.parse(stdout) as Record<string, unknown>;

    const domains: IFunnelDomain[] = [];
    const webMap = data.Web as Record<string, { Handlers: Record<string, IFunnelHandler> }> | undefined;
    const allowFunnel = data.AllowFunnel as Record<string, boolean> | undefined;

    if (webMap) {
      for (const [domainPort, config] of Object.entries(webMap)) {
        const [domain = domainPort, portStr] = domainPort.split(':');
        const port = parseInt(portStr ?? '', 10) || 443;
        const isFunnel = allowFunnel?.[domainPort] === true;
        const handlers: Array<{ path: string; proxy: string }> = [];

        if (config.Handlers) {
          for (const [path, handler] of Object.entries(config.Handlers)) {
            handlers.push({
              path,
              proxy: handler.Proxy ?? handler.Text ?? handler.Path ?? 'unknown',
            });
          }
        }

        domains.push({ domain, port, isFunnel, handlers });
      }
    }

    return { domains, raw: data };
  } catch {
    return { domains: [], raw: {} };
  }
}

/**
 * 添加 Funnel 路径挂载。
 * @param mountPath 挂载路径（如 /8790/PolarPrivate）
 * @param target 代理目标（如 http://127.0.0.1:12790）
 * @param asFunnel true=公网可达(funnel), false=仅 tailnet(serve)
 */
export async function addFunnelRoute(mountPath: string, target: string, asFunnel: boolean): Promise<{ ok: boolean; message: string }> {
  try {
    const bin = resolveTailscaleBin();
    const cmd = asFunnel ? 'funnel' : 'serve';
    const { stdout } = await execAsync(
      `${bin} ${cmd} --bg --set-path ${mountPath} ${target}`,
      { timeout: 10_000 },
    );
    return { ok: true, message: stdout.trim() || `${cmd} ${mountPath} → ${target} 已添加` };
  } catch (err) {
    return { ok: false, message: String(err) };
  }
}

/**
 * 移除 Funnel/Serve 路径挂载
 */
export async function removeFunnelRoute(mountPath: string): Promise<{ ok: boolean; message: string }> {
  try {
    const bin = resolveTailscaleBin();
    await execAsync(
      `${bin} serve --set-path ${mountPath} off`,
      { timeout: 10_000 },
    );
    return { ok: true, message: `${mountPath} 已移除` };
  } catch (err) {
    return { ok: false, message: String(err) };
  }
}

/**
 * 重置所有 serve/funnel 配置
 */
export async function resetAllFunnels(): Promise<{ ok: boolean; message: string }> {
  try {
    const bin = resolveTailscaleBin();
    await execAsync(`${bin} serve reset`, { timeout: 10_000 });
    return { ok: true, message: '所有 serve/funnel 配置已重置' };
  } catch (err) {
    return { ok: false, message: String(err) };
  }
}
