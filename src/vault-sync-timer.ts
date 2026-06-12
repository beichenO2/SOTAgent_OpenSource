/**
 * PolarPrivate vault 自动定时同步模块。
 *
 * 根据 config.json 中的 polar_private.auto_sync 配置，
 * 定期检查 PolarPrivate vault 状态并在已解锁时自动执行
 * sync-push 操作以将加密备份推送到 git。
 */

import type { ISOTAgentConfig } from "./types.js";
import { POLAR_PRIVATE_PORT } from "./ports.js";

let _timer: ReturnType<typeof setInterval> | null = null;
let _running = false;

async function isVaultUnlocked(baseUrl: string): Promise<boolean> {
  try {
    const res = await fetch(`${baseUrl}/api/vault/status`, { signal: AbortSignal.timeout(5_000) });
    if (!res.ok) return false;
    const data = (await res.json()) as { locked: boolean; role: string | null };
    return !data.locked && data.role === "admin";
  } catch {
    return false;
  }
}

async function runSyncPush(baseUrl: string): Promise<void> {
  try {
    const res = await fetch(`${baseUrl}/api/vault/sync-push`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: AbortSignal.timeout(60_000),
    });
    if (res.ok) {
      const data = (await res.json()) as { git_pushed: boolean; message: string };
      console.log(`[vault-sync] push result: pushed=${data.git_pushed}, ${data.message}`);
    } else {
      console.warn(`[vault-sync] push failed: HTTP ${res.status}`);
    }
  } catch (err) {
    console.warn(`[vault-sync] push error:`, err);
  }
}

async function tick(baseUrl: string): Promise<void> {
  if (_running) return;
  _running = true;
  try {
    const unlocked = await isVaultUnlocked(baseUrl);
    if (unlocked) {
      console.log("[vault-sync] vault is unlocked as admin, triggering sync-push...");
      await runSyncPush(baseUrl);
    }
  } catch (err) {
    console.warn("[vault-sync] tick error:", err);
  } finally {
    _running = false;
  }
}

export function startVaultSyncTimer(config: ISOTAgentConfig): void {
  const syncConfig = config.polar_private?.auto_sync;
  if (!syncConfig?.enabled) {
    console.log("[vault-sync] auto sync disabled, skipping timer setup");
    return;
  }

  const baseUrl = config.polar_private?.base_url ?? `http://127.0.0.1:${POLAR_PRIVATE_PORT}`;
  const intervalMs = (syncConfig.interval_minutes ?? 30) * 60 * 1000;

  console.log(`[vault-sync] auto sync enabled, interval=${syncConfig.interval_minutes}m`);

  // Initial check after 60 seconds to allow services to start
  setTimeout(() => {
    void tick(baseUrl);
  }, 60_000);

  _timer = setInterval(() => {
    void tick(baseUrl);
  }, intervalMs);
}

export function stopVaultSyncTimer(): void {
  if (_timer) {
    clearInterval(_timer);
    _timer = null;
  }
}
