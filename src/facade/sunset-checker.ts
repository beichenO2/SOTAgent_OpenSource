/**
 * sunset-checker.ts — Dual-indicator sunset detection for facade bridges
 *
 * Periodically checks each pending_migration capability:
 *   Indicator 1: grep = 0 — no callers reference the old endpoint
 *   Indicator 2: capability_registry.status = 'migrated'
 *
 * When both indicators pass for a capability, sends a Hub prompt
 * asking the user to approve facade removal.
 *
 * Also supports manual acceleration via .facade-sunset/*.confirm files.
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execSync } from 'node:child_process';
import type { SOTAgentDB } from '../db.js';

const POLARISOR_ROOT = path.join(process.env.HOME || os.homedir(), 'Polarisor');
const FACADE_SUNSET_DIR = path.join(POLARISOR_ROOT, '任务书', '.facade-sunset');
const FACADE_STATE_PATH = path.join(POLARISOR_ROOT, 'SOTAgent', 'data', '.facade-state.json');

export interface SunsetState {
  last_scan: Record<string, string>; // capability_id → ISO timestamp of last check
  notified: Record<string, string>;  // capability_id → ISO timestamp when prompt was sent
}

interface SunsetCheckResult {
  capability_id: string;
  indicator_grep: boolean;
  indicator_registry: boolean;
  can_sunset: boolean;
  detail: string;
}

function loadState(): SunsetState {
  try {
    if (fs.existsSync(FACADE_STATE_PATH)) {
      return JSON.parse(fs.readFileSync(FACADE_STATE_PATH, 'utf-8'));
    }
  } catch { /* fresh start */ }
  return { last_scan: {}, notified: {} };
}

function saveState(state: SunsetState): void {
  const dir = path.dirname(FACADE_STATE_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(FACADE_STATE_PATH, JSON.stringify(state, null, 2), 'utf-8');
}

/**
 * Check Indicator 1: grep for callers of the old endpoint.
 * Returns true if zero matches found (excluding facade/* files).
 */
function checkGrepIndicator(endpoint: string): boolean {
  try {
    // Escape special regex chars in endpoint
    const escaped = endpoint.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const result = execSync(
      `grep -rn '${escaped}' ${shellEscape(POLARISOR_ROOT)} ` +
      `--include='*.ts' --include='*.js' --include='*.mjs' --include='*.vue' ` +
      `--include='*.json' --include='*.sh' ` +
      `--exclude-dir=node_modules --exclude-dir=dist --exclude-dir=.git ` +
      `--exclude-dir=_legacy --exclude-dir=facade ` +
      `|| true`,
      { encoding: 'utf8', timeout: 30_000, maxBuffer: 10 * 1024 * 1024 }
    );
    const lines = result.trim().split('\n').filter(l => l.length > 0);
    // Exclude lines from SOTAgent/src/facade/ itself
    const external = lines.filter(l => !l.includes('src/facade/'));
    return external.length === 0;
  } catch {
    // grep error → conservatively assume there ARE callers
    return false;
  }
}

function shellEscape(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

/**
 * Check Indicator 2: capability_registry status = 'migrated'
 */
function checkRegistryIndicator(capabilityId: string, db: SOTAgentDB): boolean {
  try {
    const row = db.getCapability(capabilityId);
    if (!row) return false;
    return row.status === 'migrated';
  } catch {
    return false;
  }
}

/**
 * Check if a manual confirm file exists for accelerated sunset.
 */
function checkManualConfirm(capabilityId: string): boolean {
  const confirmPath = path.join(FACADE_SUNSET_DIR, `${capabilityId}.confirm`);
  return fs.existsSync(confirmPath);
}

/**
 * Send sunset prompt to Hub Web UI via POST /api/ui/prompts.
 * Best-effort — Hub may not be running.
 */
async function sendSunsetPrompt(capabilityId: string, detail: string): Promise<void> {
  const hubPort = parseInt(process.env.HUB_PORT ?? '8040', 10);
  const url = `http://127.0.0.1:${hubPort}/api/ui/prompts`;
  try {
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        agent_id: 'sotagent-facade',
        prompt: `facade "${capabilityId}" 满足删除条件 (${detail})，是否清理？`,
        options: ['批准删除', '永久保留 facade', '再观察'],
      }),
      signal: AbortSignal.timeout(5000),
    });
  } catch {
    console.warn(`[sunset-checker] Hub prompt 发送失败 (${capabilityId})`);
  }
}

/**
 * Run a full sunset check cycle.
 * Returns results for each pending_migration capability.
 */
export async function runSunsetCheck(db: SOTAgentDB): Promise<SunsetCheckResult[]> {
  const state = loadState();
  const results: SunsetCheckResult[] = [];

  // Find all capabilities with pending_migration status
  const capabilities = db.listCapabilities().filter(
    (cap: any) => cap.status === 'pending_migration'
  );

  if (capabilities.length === 0) {
    return results;
  }

  // Check manual confirm files first
  fs.mkdirSync(FACADE_SUNSET_DIR, { recursive: true });

  for (const cap of capabilities) {
    const capId = cap.id;
    const endpoint = cap.endpoint ?? '';

    // Check manual acceleration
    const hasConfirm = checkManualConfirm(capId);

    let indicatorGrep = false;
    let indicatorRegistry = false;

    if (hasConfirm) {
      // Manual confirm → skip indicators, directly mark as sunset-ready
      indicatorGrep = true;
      indicatorRegistry = true;
    } else {
      indicatorGrep = endpoint ? checkGrepIndicator(endpoint) : false;
      indicatorRegistry = checkRegistryIndicator(capId, db);
    }

    const canSunset = indicatorGrep && indicatorRegistry;
    const detail = hasConfirm
      ? 'manual confirm'
      : `grep=${indicatorGrep}, registry=${indicatorRegistry}`;

    results.push({
      capability_id: capId,
      indicator_grep: indicatorGrep,
      indicator_registry: indicatorRegistry,
      can_sunset: canSunset,
      detail,
    });

    // Update scan time
    state.last_scan[capId] = new Date().toISOString();

    // Send prompt if can sunset and not already notified
    if (canSunset && !state.notified[capId]) {
      await sendSunsetPrompt(capId, detail);
      state.notified[capId] = new Date().toISOString();
      console.log(`[sunset-checker] ${capId}: 满足删除条件，已发 Hub prompt (${detail})`);
    } else if (canSunset && state.notified[capId]) {
      console.log(`[sunset-checker] ${capId}: 已通知过，等待用户操作`);
    } else {
      console.log(`[sunset-checker] ${capId}: 未满足 (${detail})`);
    }
  }

  saveState(state);
  return results;
}

/**
 * Get current sunset state.
 */
export function getSunsetState(): SunsetState {
  return loadState();
}

/**
 * Manual trigger: scan a specific confirm file and return if it exists.
 */
export function checkManualAccelerate(capabilityId: string): boolean {
  return checkManualConfirm(capabilityId);
}
