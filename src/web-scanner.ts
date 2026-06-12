/**
 * web-scanner.ts — Web 控制台实时 Git 扫描器
 *
 * 与 SOTAgent 的 github-sync（cli.ts）不同：
 * - github-sync 是定时后台巡检，负责自动 pull/push
 * - web-scanner 是按需实时扫描，为 Web 仪表盘提供即时状态
 *
 * 端口数据从 SOTAgent 的 port_registry 表读取，不再硬编码。
 */

import { exec } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { promisify } from 'node:util';
import { SOTAgentDB, type IPortRegistryRow } from './db.js';

const execAsync = promisify(exec);
const POLARISOR_ROOT = path.join(process.env.HOME || '~', 'Polarisor');

export interface IRepoStatus {
  name: string;
  path: string;
  branch: string;
  syncStatus: 'synced' | 'ahead' | 'behind' | 'diverged' | 'no_remote';
  ahead: number;
  behind: number;
  dirty: number;
  remote: string;
  lastChecked: string;
}

export interface IPortEntry {
  port: number;
  service: string;
  project: string;
  protocol: 'http' | 'ws' | 'tcp';
  description: string;
}

export interface IScanResult {
  repos: IRepoStatus[];
  ports: IPortEntry[];
  scannedAt: string;
}

async function run(cmd: string, cwd: string, timeoutMs = 8_000): Promise<string> {
  try {
    const { stdout } = await execAsync(cmd, {
      cwd,
      timeout: timeoutMs,
      env: { ...process.env, GIT_SSH_COMMAND: 'ssh -o ConnectTimeout=3 -o BatchMode=yes' },
    });
    return stdout.trim();
  } catch {
    return '';
  }
}

async function runAsync(cmd: string, cwd: string, timeoutMs = 15_000): Promise<string> {
  try {
    const { stdout } = await execAsync(cmd, { cwd, timeout: timeoutMs });
    return stdout.trim();
  } catch {
    return '';
  }
}

async function scanRepo(dirPath: string): Promise<IRepoStatus | null> {
  const gitDir = path.join(dirPath, '.git');
  if (!fs.existsSync(gitDir)) return null;

  const name = path.basename(dirPath);
  const branch = await run('git branch --show-current', dirPath) || 'detached';
  const remote = await run('git remote get-url origin', dirPath);

  await run('git fetch origin --quiet', dirPath, 5_000);

  const localHash = await run('git rev-parse --short HEAD', dirPath);
  const remoteHash = await run(`git rev-parse --short origin/${branch}`, dirPath);

  const dirtyOutput = await run('git status --porcelain', dirPath);
  const dirty = dirtyOutput ? dirtyOutput.split('\n').length : 0;

  let syncStatus: IRepoStatus['syncStatus'] = 'synced';
  let ahead = 0;
  let behind = 0;

  if (!remote || !remoteHash) {
    syncStatus = 'no_remote';
  } else if (localHash !== remoteHash) {
    ahead = parseInt(await run(`git rev-list --count origin/${branch}..HEAD`, dirPath) || '0');
    behind = parseInt(await run(`git rev-list --count HEAD..origin/${branch}`, dirPath) || '0');

    if (ahead > 0 && behind > 0) syncStatus = 'diverged';
    else if (behind > 0) syncStatus = 'behind';
    else if (ahead > 0) syncStatus = 'ahead';
  }

  return {
    name,
    path: dirPath,
    branch,
    syncStatus,
    ahead,
    behind,
    dirty,
    remote: remote || '',
    lastChecked: new Date().toISOString(),
  };
}

/** 从 SOTAgent port_registry 读取端口分配 */
function getPortsFromDB(db: SOTAgentDB): IPortEntry[] {
  const rows: IPortRegistryRow[] = db.listActivePorts();
  return rows.map(r => ({
    port: r.port,
    service: r.service_name,
    project: r.project,
    protocol: 'http' as const,
    description: `${r.project} — ${r.service_name}`,
  }));
}

export async function scanAll(db: SOTAgentDB): Promise<IScanResult> {
  const entries = fs.readdirSync(POLARISOR_ROOT, { withFileTypes: true });
  const dirs: string[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
    const fullPath = path.join(POLARISOR_ROOT, entry.name);
    try {
      const stat = fs.statSync(fullPath);
      if (stat.isDirectory()) dirs.push(fullPath);
    } catch { /* 忽略无法访问的目录 */ }
  }

  const results = await Promise.allSettled(dirs.map(d => scanRepo(d)));
  const repos: IRepoStatus[] = results
    .filter((r): r is PromiseFulfilledResult<IRepoStatus | null> => r.status === 'fulfilled' && r.value !== null)
    .map(r => r.value!);

  repos.sort((a, b) => {
    const order: Record<string, number> = { no_remote: 0, behind: 1, diverged: 2, ahead: 3, synced: 4 };
    return (order[a.syncStatus] ?? 5) - (order[b.syncStatus] ?? 5);
  });

  return {
    repos,
    ports: getPortsFromDB(db),
    scannedAt: new Date().toISOString(),
  };
}

export async function pullRepo(repoName: string): Promise<string> {
  const repoPath = path.join(POLARISOR_ROOT, repoName);
  if (!fs.existsSync(path.join(repoPath, '.git'))) {
    throw new Error(`${repoName} 不是 git 仓库`);
  }

  const branch = await runAsync('git branch --show-current', repoPath);
  const result = await runAsync(`git pull origin ${branch}`, repoPath);
  return result || 'pull completed';
}

export async function pullAllClean(db: SOTAgentDB): Promise<string[]> {
  const result = await scanAll(db);
  const pulled: string[] = [];

  for (const repo of result.repos) {
    if (repo.syncStatus === 'behind' && repo.dirty === 0) {
      try {
        await pullRepo(repo.name);
        pulled.push(repo.name);
      } catch { /* 跳过失败的 */ }
    }
  }

  return pulled;
}
