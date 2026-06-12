/**
 * auto-discover.ts — 自动发现并注册项目和端口
 *
 * 在每次扫描后调用，将发现的 git 仓库同步到 project_registry，
 * 将系统实际监听的端口同步到 port_registry。
 * 不再依赖手工种子数据。
 *
 * 同时检测同一服务的重复实例（端口冲突后自动递增 = 多实例启动）。
 */

import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import { SOTAgentDB } from './db.js';
import type { IScanResult, IRepoStatus } from './web-scanner.js';

const execAsync = promisify(exec);

const KNOWN_SYSTEM_PORTS: Record<number, { service: string; project: string }> = {
  5000: { service: 'AirPlay (ControlCenter)', project: '(system)' },
  7000: { service: 'AirPlay (ControlCenter)', project: '(system)' },
  8080: { service: 'llama-server', project: '(system)' },
  1234: { service: 'LM Studio', project: '(system)' },
};

const IGNORED_PROCESSES = new Set([
  'QQ', 'WeChat', 'rapportd', 'Electron', 'Cursor', 'ControlCe',
  'clash-ver', 'clash-verge',
]);

const KILL_PROTECTED_PATTERNS = ['SOTAgent', 'polarcop', 'PolarCopilot'];

/** 重复实例告警 */
export interface IDuplicateAlert {
  project: string;
  process: string;
  instances: { pid: number; port: number; startedAt?: string }[];
  recommendation: 'kill_older' | 'manual_review';
}

/**
 * 根据扫描结果自动注册/更新项目
 */
export function syncProjects(db: SOTAgentDB, scanResult: IScanResult): void {
  for (const repo of scanResult.repos) {
    db.registerProject({
      path: repo.path,
      name: repo.name,
      github_remote: repo.remote || undefined,
      auto_sync: !!repo.remote,
    });
  }
  // 清理目录已不存在的 stale 项目记录
  const validPaths = scanResult.repos.map(r => r.path);
  const removed = db.removeStaleProjects(validPaths);
  if (removed > 0) {
    console.log(`[auto-discover] 🗑️ 清理 ${removed} 个目录已删除的 stale 项目`);
  }
}


interface ListeningPort {
  port: number;
  process: string;
  pid: number;
  cwd?: string;
  command?: string;
}

/**
 * 扫描系统所有监听端口并返回结构化数据
 */
async function discoverListeningPorts(): Promise<ListeningPort[]> {
  try {
    const { stdout } = await execAsync(
      "lsof -iTCP -sTCP:LISTEN -P -n -F pcn 2>/dev/null",
      { timeout: 5000 },
    );

    const results: ListeningPort[] = [];
    let currentPid = 0;
    let currentProcess = '';

    for (const line of stdout.split('\n')) {
      if (line.startsWith('p')) currentPid = parseInt(line.slice(1), 10);
      else if (line.startsWith('c')) currentProcess = line.slice(1);
      else if (line.startsWith('n')) {
        const match = line.match(/:(\d+)$/);
        if (match?.[1]) {
          results.push({
            port: parseInt(match[1], 10),
            process: currentProcess,
            pid: currentPid,
          });
        }
      }
    }

    const seen = new Set<number>();
    const deduped = results.filter(r => {
      if (seen.has(r.port)) return false;
      seen.add(r.port);
      return true;
    });

    // Enrich with cwd via lsof -a -p PID -d cwd
    const pids = [...new Set(deduped.map(r => r.pid))];
    if (pids.length > 0) {
      try {
        const { stdout: cwdOut } = await execAsync(
          `lsof -a -d cwd -F pn -p ${pids.join(',')} 2>/dev/null`,
          { timeout: 3000 },
        );
        const cwdMap = new Map<number, string>();
        let pid = 0;
        for (const line of cwdOut.split('\n')) {
          if (line.startsWith('p')) pid = parseInt(line.slice(1), 10);
          else if (line.startsWith('n') && pid) cwdMap.set(pid, line.slice(1));
        }
        for (const r of deduped) {
          r.cwd = cwdMap.get(r.pid);
        }
      } catch { /* cwd enrichment is best-effort */ }

      try {
        const { stdout: psOut } = await execAsync(
          `ps -p ${pids.join(',')} -o pid=,command= 2>/dev/null`,
          { timeout: 3000 },
        );
        const cmdMap = new Map<number, string>();
        for (const line of psOut.split('\n')) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          const spaceIdx = trimmed.indexOf(' ');
          if (spaceIdx > 0) {
            cmdMap.set(parseInt(trimmed.slice(0, spaceIdx), 10), trimmed.slice(spaceIdx + 1));
          }
        }
        for (const r of deduped) {
          r.command = cmdMap.get(r.pid);
        }
      } catch { /* command enrichment is best-effort */ }
    }

    return deduped;
  } catch {
    return [];
  }
}


const HOME_DIR = process.env['HOME'] || '~';

function extractProjectFromPath(path: string): string | null {
  const homePrefix = HOME_DIR + '/';
  if (!path.startsWith(homePrefix)) return null;
  const rel = path.slice(homePrefix.length);
  const parts = rel.split('/');
  if (parts.length >= 2) return `${parts[0]}/${parts[1]}`;
  if (parts.length === 1 && parts[0]) return parts[0];
  return null;
}

/**
 * 根据端口信息匹配项目。
 * 优先级: 已知端口 > cwd 匹配 > 命令行路径匹配 > 进程名匹配 > unknown
 */
function matchPortToProject(
  lp: ListeningPort,
  repos: IRepoStatus[],
): { service: string; project: string } | null {
  if (IGNORED_PROCESSES.has(lp.process)) return null;
  if (lp.port > 40000) return null;

  const known = KNOWN_SYSTEM_PORTS[lp.port];
  if (known) return known;

  // cwd 匹配：进程 cwd 在 ~/任意目录/ 下
  if (lp.cwd) {
    const proj = extractProjectFromPath(lp.cwd);
    if (proj) return { service: lp.process, project: proj };
  }

  // 命令行路径匹配：从完整命令中提取文件路径
  if (lp.command) {
    const pathMatch = lp.command.match(new RegExp(`${HOME_DIR.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/([^\\s]+)`));
    if (pathMatch) {
      const proj = extractProjectFromPath(HOME_DIR + '/' + pathMatch[1]);
      if (proj) return { service: lp.process, project: proj };
    }
  }

  // 进程名匹配
  for (const repo of repos) {
    const nameLower = repo.name.toLowerCase();
    const processLower = lp.process.toLowerCase();
    if (processLower.includes(nameLower) || nameLower.includes(processLower)) {
      return { service: lp.process, project: repo.name };
    }
  }

  return { service: `${lp.process} (auto)`, project: '(unknown)' };
}

/** 最近一次检测到的重复实例告警 */
let _lastDuplicateAlerts: IDuplicateAlert[] = [];

export function getDuplicateAlerts(): IDuplicateAlert[] {
  return _lastDuplicateAlerts;
}

/**
 * 检测同一服务的重复实例。
 * 判定标准：同一 project + 同一进程名，但不同 PID → 重复。
 * 同一 PID 多端口（如 gateway 监听多个端口）→ 正常，不算重复。
 */
function detectDuplicateInstances(
  ports: ListeningPort[],
  repos: IRepoStatus[],
): IDuplicateAlert[] {
  // 按 (project, process) 分组，每组里不同 PID 即为不同实例
  const groups = new Map<string, { pid: number; port: number; cwd?: string }[]>();

  for (const lp of ports) {
    if (IGNORED_PROCESSES.has(lp.process)) continue;
    if (lp.port > 40000) continue;

    const match = matchPortToProject(lp, repos);
    if (!match || match.project === '(system)' || match.project === '(unknown)') continue;

    const key = `${match.project}::${lp.process}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push({ pid: lp.pid, port: lp.port, cwd: lp.cwd });
  }

  const alerts: IDuplicateAlert[] = [];

  for (const [key, entries] of groups) {
    // 按 PID 去重——同一 PID 多端口是正常的
    const byPid = new Map<number, typeof entries>();
    for (const e of entries) {
      if (!byPid.has(e.pid)) byPid.set(e.pid, []);
      byPid.get(e.pid)!.push(e);
    }

    if (byPid.size < 2) continue;

    const [project = 'unknown', process = 'unknown'] = key.split('::');
    const instances = [...byPid.entries()].map(([pid, ports]) => ({
      pid,
      port: ports[0]!.port,
    }));

    alerts.push({
      project,
      process,
      instances,
      recommendation: KILL_PROTECTED_PATTERNS.some(p => project!.includes(p)) ? 'manual_review' : 'kill_older',
    });
  }

  return alerts;
}

/**
 * 自动杀掉重复实例中较老的进程（保留最新的）
 */
const SELF_PIDS = new Set([process.pid, process.ppid]);
async function killOlderDuplicates(alerts: IDuplicateAlert[]): Promise<string[]> {
  const killed: string[] = [];

  for (const alert of alerts) {
    if (alert.recommendation !== 'kill_older') continue;
    if (alert.instances.length < 2) continue;

    // 获取每个 PID 的启动时间来判断哪个更老
    const pidAges: { pid: number; port: number; startMs: number }[] = [];
    for (const inst of alert.instances) {
      try {
        const { stdout } = await execAsync(
          `ps -p ${inst.pid} -o lstart= 2>/dev/null`,
          { timeout: 2000 },
        );
        const started = new Date(stdout.trim()).getTime();
        pidAges.push({ pid: inst.pid, port: inst.port, startMs: started || 0 });
      } catch {
        pidAges.push({ pid: inst.pid, port: inst.port, startMs: 0 });
      }
    }

    // 按启动时间排序，保留最新的（startMs 最大），杀掉其余的
    pidAges.sort((a, b) => a.startMs - b.startMs);
    const toKill = pidAges.slice(0, -1); // 杀掉除最新之外的所有

    for (const old of toKill) {
      if (SELF_PIDS.has(old.pid)) {
        console.warn(`[auto-discover] ⛔ 跳过自身/父进程 PID ${old.pid}`);
        continue;
      }
      try {
        await execAsync(`kill ${old.pid}`, { timeout: 3000 });
        killed.push(`${alert.project}/${alert.process} PID ${old.pid} (port ${old.port})`);
        console.log(
          `[auto-discover] 🔪 杀掉重复实例: ${alert.project}/${alert.process} PID ${old.pid} (port ${old.port})`,
        );
      } catch {
        console.warn(`[auto-discover] 无法杀掉 PID ${old.pid}`);
      }
    }
  }

  return killed;
}

/**
 * 发现系统端口并同步到 port_registry。
 * 同时检测并处理重复实例。
 */
export async function syncPorts(db: SOTAgentDB, scanResult: IScanResult, deviceId: string): Promise<void> {
  const listeningPorts = await discoverListeningPorts();

  // 1) 检测重复实例
  const duplicates = detectDuplicateInstances(listeningPorts, scanResult.repos);
  _lastDuplicateAlerts = duplicates;

  if (duplicates.length > 0) {
    for (const dup of duplicates) {
      const pids = dup.instances.map(i => `PID ${i.pid} :${i.port}`).join(', ');
      console.warn(`[auto-discover] ⚠️ 重复实例: ${dup.project}/${dup.process} → ${pids}`);
    }

    // 2) 自动杀掉较老的重复实例
    const killed = await killOlderDuplicates(duplicates);
    if (killed.length > 0) {
      console.log(`[auto-discover] 已清理 ${killed.length} 个重复实例: ${killed.join(', ')}`);
    }
  }

  // 3) 注册/刷新端口
  for (const lp of listeningPorts) {
    const match = matchPortToProject(lp, scanResult.repos);
    if (!match) continue;

    const existing = db.getPortAllocation(lp.port);
    if (existing) {
      db.touchPort(lp.port);
      if (match.project !== '(unknown)' && existing.project !== match.project) {
        console.log(`[auto-discover] 更新端口 :${lp.port} 项目: ${existing.project} → ${match.project}`);
        db.upsertPort(lp.port, existing.service_name, match.project, deviceId);
      }
    } else {
      const anyRow = db.getPortRow(lp.port);
      if (anyRow && (anyRow.status === 'released' || anyRow.status === 'stale')) {
        // 端口记录存在但状态为 released/stale，且实际正在被监听 → 复活
        const reactivated = db.reactivatePort(lp.port, anyRow.service_name, anyRow.project, deviceId);
        if (reactivated) {
          console.log(`[auto-discover] 复活端口 :${lp.port} (${anyRow.service_name}/${anyRow.project})`);
          continue;
        }
      }
      const svcName = anyRow?.service_name ?? match.service;
      db.upsertPort(lp.port, svcName, match.project, deviceId);
    }
  }

  db.pruneStalePortAllocations();
}
