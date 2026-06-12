/**
 * cli.ts — SOTAgent 命令行入口
 *
 * 由 sentinel.sh 调用，也可手动执行。
 * 命令：
 *   process-inbox  扫描并处理所有 inbox 消息
 *   schedule       运行一次调度循环
 *   monitor        采样运行中任务 + 系统扫描
 *   status         显示系统状态摘要
 *   sync           手动触发同步
 *   register       注册技术资产
 *   subscribe      订阅技术资产
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { SOTAgentDB } from './db.js';
import { Communicator } from './communicator.js';
import { ResourceScheduler } from './scheduler.js';
import { ResourceProfiler } from './profiler.js';
import { SyncEngine } from './sync-engine.js';
import type { ISOTAgentConfig, AssetType, SyncLevel } from './types.js';

const SOTAGENT_DIR = path.join(import.meta.dirname, '..');
const CONFIG_PATH = path.join(SOTAGENT_DIR, 'config.json');

function loadConfig(): ISOTAgentConfig {
  const raw = fs.readFileSync(CONFIG_PATH, 'utf-8');
  return JSON.parse(raw) as ISOTAgentConfig;
}

function getDeviceId(): string {
  return process.env['SOTAGENT_DEVICE_ID'] || os.hostname().split('.')[0] || os.hostname();
}

const command = process.argv[2];

async function main(): Promise<void> {
  const config = loadConfig();
  const deviceId = getDeviceId();
  const db = new SOTAgentDB();

  try {
    switch (command) {
      case 'process-inbox': {
        const comm = new Communicator({ db, config, deviceId });
        const report = await comm.processInbox();
        if (report.processed.length === 0 && report.errors.length === 0) {
          console.log('[cli] inbox 为空');
        } else {
          console.log(`[cli] inbox 处理完成: ${report.processed.length} 条消息, ${report.errors.length} 个错误`);
        }
        break;
      }

      case 'schedule': {
        const scheduler = new ResourceScheduler(db, config, deviceId);
        const report = await scheduler.runScheduleCycle();
        if (report.actions.length > 0) {
          console.log(`[cli] 调度完成: ${report.actions.length} 个动作`);
          for (const action of report.actions) {
            console.log(`  - ${action.action}: ${action.task_id}`);
          }
        }
        if (report.system_status) {
          console.log(`[cli] 系统状态: CPU=${report.system_status.avgCpu}%, MEM=${report.system_status.avgMem}%, idle=${report.system_status.idle}`);
        }
        break;
      }

      case 'monitor': {
        const profiler = new ResourceProfiler(db);

        // 采样运行中任务
        const sampling = profiler.sampleRunningTasks();
        if (sampling.sampled.length > 0) {
          console.log(`[cli] 采样了 ${sampling.sampled.length} 个运行中任务:`);
          for (const s of sampling.sampled) {
            console.log(`  - ${s.task_type}: CPU=${s.cpu_percent}%, MEM=${s.mem_mb}MB`);
          }
        }

        // 扫描已知进程类型
        const scan = profiler.scanKnownProcessTypes();
        if (scan.found.length > 0) {
          console.log(`[cli] 发现 ${scan.found.length} 种已知进程类型:`);
          for (const f of scan.found) {
            console.log(`  - ${f.type}: ${f.instance_count}个实例, CPU=${f.total_cpu}%, MEM=${f.total_mem}MB`);
          }
        }
        break;
      }

      case 'status': {
        console.log('=== SOTAgent 状态 ===\n');

        // 设备信息
        console.log(`设备: ${deviceId}`);
        console.log(`平台: ${os.platform()} ${os.arch()}`);
        console.log(`总内存: ${Math.round(os.totalmem() / 1073741824)}GB\n`);

        // 资源快照
        const snapshots = db.recentSnapshots(deviceId, 1);
        if (snapshots.length > 0) {
          const s = snapshots[0]!;
          console.log(`--- 最新资源快照 (${s.timestamp}) ---`);
          console.log(`CPU: ${s.cpu_percent}%`);
          console.log(`内存: ${s.mem_used_mb}/${s.mem_total_mb}MB (${s.mem_percent}%)`);
          if (s.gpu_mem_used_mb) console.log(`GPU内存: ${s.gpu_mem_used_mb}MB`);
          console.log();
        }

        // 任务状态
        const allTasks = db.listTasks();
        const queued = allTasks.filter(t => t.status === 'queued').length;
        const running = allTasks.filter(t => t.status === 'running').length;
        const done = allTasks.filter(t => t.status === 'done').length;
        const failed = allTasks.filter(t => t.status === 'failed').length;
        console.log(`--- 任务队列 ---`);
        console.log(`排队: ${queued}  运行: ${running}  完成: ${done}  失败: ${failed}\n`);

        // 画像
        const profiler = new ResourceProfiler(db);
        const profiles = profiler.getProfileSummary();
        if (profiles.length > 0) {
          console.log('--- 资源画像 ---');
          for (const p of profiles) {
            console.log(`  ${p.task_type}: CPU=${p.avg_cpu}(peak:${p.peak_cpu}), MEM=${p.avg_mem}(peak:${p.peak_mem}), samples=${p.samples}, confidence=${p.confidence}`);
          }
          console.log();
        }

        // 技术资产
        const assets = db.listAssets();
        console.log(`--- 技术资产: ${assets.length} 项 ---`);
        for (const a of assets.slice(0, 10)) {
          const subs = db.getSubscribers(a.id);
          console.log(`  ${a.id} (v${a.version}) — ${subs.length} 个订阅者`);
        }

        // 同步历史
        const history = db.getSyncHistory(undefined, 5);
        if (history.length > 0) {
          console.log(`\n--- 最近同步 ---`);
          for (const h of history) {
            console.log(`  ${h.timestamp}: ${h.asset_id} ${h.from_project}→${h.to_project} [${h.action}]`);
          }
        }
        break;
      }

      case 'monitor-collect': {
        // 由 resource-monitor.sh 调用：采集一次系统资源快照并写入 SQLite
        const { execSync } = await import('node:child_process');
        const snapshot = JSON.parse(execSync(`python3 << 'PYEOF'
import subprocess, re, json

try:
    out = subprocess.check_output(["top", "-l", "2", "-n", "0", "-s", "0"], text=True, timeout=10)
    lines = [l for l in out.splitlines() if l.startswith("CPU usage")]
    last = lines[-1] if lines else ""
    m = re.search(r'([\\d.]+)% idle', last)
    cpu = round(100 - float(m.group(1)), 1) if m else 0
except:
    cpu = 0

try:
    total = int(subprocess.check_output(["sysctl", "-n", "hw.memsize"], text=True).strip())
    total_mb = total // 1048576
    vmstat = subprocess.check_output(["vm_stat"], text=True)
    ps = 16384
    m = re.search(r'page size of (\\d+)', vmstat)
    if m: ps = int(m.group(1))
    def gp(pat):
        m = re.search(pat + r':\\s+(\\d+)', vmstat)
        return int(m.group(1)) if m else 0
    used_mb = int((gp(r'Pages active') + gp(r'Pages wired down') + gp(r'Pages occupied by compressor')) * ps / 1048576)
    mem_pct = round(used_mb / total_mb * 100, 1)
except:
    used_mb, total_mb, mem_pct = 0, 16384, 0

gpu = 0
try:
    out = subprocess.check_output(["ioreg", "-r", "-d", "1", "-c", "AGXAccelerator"], text=True, timeout=5)
    m = re.search(r'(?:allocatedMem|currentAllocatedSystemMemory)\\D+(\\d+)', out, re.IGNORECASE)
    if m and int(m.group(1)) > 0: gpu = int(m.group(1)) // 1048576
except:
    pass

print(json.dumps({"cpu": cpu, "mem_used": used_mb, "mem_total": total_mb, "mem_pct": mem_pct, "gpu": gpu}))
PYEOF`, { encoding: 'utf-8', timeout: 15000 }).trim());

        db.recordSnapshot({
          device_id: deviceId,
          cpu_percent: snapshot.cpu,
          mem_used_mb: snapshot.mem_used,
          mem_total_mb: snapshot.mem_total,
          mem_percent: snapshot.mem_pct,
          gpu_mem_used_mb: snapshot.gpu || undefined,
          timestamp: new Date().toISOString(),
        });
        db.pruneSnapshots(7);
        console.log(`[monitor] ${deviceId} — CPU: ${snapshot.cpu}%, MEM: ${snapshot.mem_used}/${snapshot.mem_total}MB (${snapshot.mem_pct}%), GPU: ${snapshot.gpu}MB`);
        break;
      }

      case 'register': {
        // 手动注册: npx tsx src/cli.ts register <type> <id> <path>
        const type = process.argv[3] as AssetType;
        const id = process.argv[4];
        const assetPath = process.argv[5];
        if (!type || !id || !assetPath) {
          console.error('用法: register <type> <id> <canonical_path>');
          console.error('  type: skill | architecture | workflow | config');
          process.exit(1);
        }
        db.registerAsset({ id, type, canonical_path: assetPath, updated_by: deviceId });
        console.log(`[cli] 已注册: ${id} (${type}) → ${assetPath}`);
        break;
      }

      case 'subscribe': {
        // 手动订阅: npx tsx src/cli.ts subscribe <project> <asset_id> <project_path> [sync_level]
        const project = process.argv[3];
        const assetId = process.argv[4];
        const projectPath = process.argv[5];
        const syncLevel = (process.argv[6] || 'auto') as SyncLevel;
        if (!project || !assetId || !projectPath) {
          console.error('用法: subscribe <project_id> <asset_id> <project_path> [auto|suggest|manual]');
          process.exit(1);
        }
        db.subscribe({ project_id: project, asset_id: assetId, sync_level: syncLevel, project_path: projectPath });
        console.log(`[cli] ${project} 已订阅 ${assetId} (${syncLevel}) → ${projectPath}`);
        break;
      }

      case 'github-sync': {
        /**
         * GitHub 同步巡检：对所有注册项目执行 git pull/push
         * 资源感知：CPU>80% 或 MEM>90% 时跳过
         * Agent 感知：第一责任人在工作时通知而不自动 pull
         */
        const { execSync } = await import('node:child_process');
        const projects = db.listProjects();
        if (projects.length === 0) {
          console.log('[sync] 没有注册的项目。用 project-register 添加');
          break;
        }

        // 检查系统资源
        const snapshots = db.recentSnapshots(deviceId, 1);
        if (snapshots.length > 0) {
          const s = snapshots[0]!;
          if (s.cpu_percent > 80 || s.mem_percent > 90) {
            console.log(`[sync] 系统资源紧张 (CPU=${s.cpu_percent}%, MEM=${s.mem_percent}%), 跳过本轮同步`);
            for (const p of projects) {
              db.recordSyncEvent({ project_path: p.path, action: 'skip_resource', summary: `CPU=${s.cpu_percent}% MEM=${s.mem_percent}%` });
            }
            break;
          }
        }

        for (const project of projects) {
          if (!project.auto_sync) continue;
          if (!fs.existsSync(path.join(project.path, '.git'))) {
            console.log(`[sync] ${project.name}: 不是 git 仓库，跳过`);
            continue;
          }

          try {
            // git fetch
            execSync('git fetch origin --quiet 2>/dev/null', { cwd: project.path, timeout: 30000 });
            const local = execSync('git rev-parse HEAD', { cwd: project.path, encoding: 'utf-8', timeout: 5000 }).trim();
            const remote = execSync('git rev-parse origin/main 2>/dev/null || git rev-parse origin/master 2>/dev/null', { cwd: project.path, encoding: 'utf-8', timeout: 5000 }).trim();
            const unpushed = execSync('git log origin/main..HEAD --oneline 2>/dev/null || git log origin/master..HEAD --oneline 2>/dev/null', { cwd: project.path, encoding: 'utf-8', timeout: 5000 }).trim();

            const needsPull = local !== remote;
            const needsPush = unpushed.length > 0;

            if (!needsPull && !needsPush) {
              console.log(`[sync] ${project.name}: 已是最新`);
              db.updateProjectSync(project.path, 'up-to-date');
              continue;
            }

            // 检查是否有 Agent 在工作
            const agentBusy = project.primary_agent_session !== null;
            if (agentBusy && needsPull) {
              // 通知 Agent 而不自动 pull
              console.log(`[sync] ${project.name}: Agent 在工作，写入同步通知`);
              const behindCount = execSync('git log HEAD..origin/main --oneline 2>/dev/null | wc -l', { cwd: project.path, encoding: 'utf-8', timeout: 5000 }).trim();
              const changedFiles = execSync('git diff --name-only HEAD origin/main 2>/dev/null | head -10', { cwd: project.path, encoding: 'utf-8', timeout: 5000 }).trim();

              // 写入同步日志供 Agent 读取
              const syncLogPath = path.join(project.path, '.planning', 'sync-log.jsonl');
              fs.mkdirSync(path.dirname(syncLogPath), { recursive: true });
              const logEntry = JSON.stringify({
                timestamp: new Date().toISOString(),
                action: 'notify_pending_pull',
                commits_behind: parseInt(behindCount) || 0,
                files_changed: changedFiles.split('\n').filter(Boolean),
                summary: `远程有 ${behindCount} 个新 commit，等 Agent 空闲时 pull`,
              });
              fs.appendFileSync(syncLogPath, logEntry + '\n');

              db.recordSyncEvent({
                project_path: project.path,
                action: 'notify_agent',
                commits_pulled: 0,
                summary: `通知 Agent: ${behindCount} commits behind`,
              });
              continue;
            }

            // 自动 pull
            if (needsPull) {
              execSync('git pull --rebase origin main 2>/dev/null || git pull --rebase origin master 2>/dev/null', { cwd: project.path, timeout: 60000 });
              const pulledCount = execSync('git log HEAD@{1}..HEAD --oneline 2>/dev/null | wc -l', { cwd: project.path, encoding: 'utf-8', timeout: 5000 }).trim();
              const changedFiles = execSync('git diff --name-only HEAD@{1} HEAD 2>/dev/null | head -20', { cwd: project.path, encoding: 'utf-8', timeout: 5000 }).trim();
              console.log(`[sync] ${project.name}: pulled ${pulledCount} commits`);

              // 同步后自动重建依赖（node_modules/venv 不参与同步）
              try {
                const depChanged = changedFiles.split('\n');
                if (depChanged.some(f => /package.*json/.test(f)) && fs.existsSync(path.join(project.path, 'package.json'))) {
                  console.log(`[sync] ${project.name}: package.json 变化，执行 npm install...`);
                  execSync('npm install --silent 2>/dev/null', { cwd: project.path, timeout: 120000 });
                }
                if (depChanged.some(f => f.includes('requirements.txt')) && fs.existsSync(path.join(project.path, 'requirements.txt'))) {
                  console.log(`[sync] ${project.name}: requirements.txt 变化，执行 pip install...`);
                  execSync('pip install -r requirements.txt -q 2>/dev/null', { cwd: project.path, timeout: 120000 });
                }
              } catch (rebuildErr) {
                console.warn(`[sync] ${project.name}: 依赖重建失败（不影响同步）`, (rebuildErr as Error).message?.slice(0, 80));
              }

              // 写入同步日志
              const syncLogPath = path.join(project.path, '.planning', 'sync-log.jsonl');
              fs.mkdirSync(path.dirname(syncLogPath), { recursive: true });
              const logEntry = JSON.stringify({
                timestamp: new Date().toISOString(),
                action: 'auto_pull',
                commits_pulled: parseInt(pulledCount) || 0,
                files_changed: changedFiles.split('\n').filter(Boolean),
                summary: `自动拉取了 ${pulledCount} 个 commit`,
                next_agent_should: 'review changes before continuing',
              });
              fs.appendFileSync(syncLogPath, logEntry + '\n');

              db.recordSyncEvent({
                project_path: project.path,
                action: 'auto_pull',
                commits_pulled: parseInt(pulledCount) || 0,
                files_changed: changedFiles,
                summary: `拉取 ${pulledCount} commits`,
              });
            }

            // 自动 push
            if (needsPush) {
              execSync('git push origin HEAD 2>/dev/null', { cwd: project.path, timeout: 60000 });
              const pushCount = unpushed.split('\n').filter(Boolean).length;
              console.log(`[sync] ${project.name}: pushed ${pushCount} commits`);

              db.recordSyncEvent({
                project_path: project.path,
                action: 'auto_push',
                commits_pushed: pushCount,
                summary: `推送 ${pushCount} commits`,
              });
            }

            db.updateProjectSync(project.path, 'synced');
          } catch (err) {
            console.error(`[sync] ${project.name}: 同步失败 —`, (err as Error).message?.slice(0, 100));
            db.updateProjectSync(project.path, `error: ${(err as Error).message?.slice(0, 100)}`);
          }
        }
        break;
      }

      case 'project-register': {
        // 注册项目: npx tsx src/cli.ts project-register <path> [name] [github_remote]
        const projectPath = process.argv[3];
        const projectName = process.argv[4];
        const githubRemote = process.argv[5];
        if (!projectPath) {
          console.error('用法: project-register <path> [name] [github_remote]');
          process.exit(1);
        }
        const resolvedPath = path.resolve(projectPath);
        const name = projectName || path.basename(resolvedPath);

        // 自动检测 GitHub remote
        let remote = githubRemote;
        if (!remote && fs.existsSync(path.join(resolvedPath, '.git'))) {
          try {
            const { execSync } = await import('node:child_process');
            remote = execSync('git remote get-url origin 2>/dev/null', { cwd: resolvedPath, encoding: 'utf-8' }).trim();
          } catch { /* no remote */ }
        }

        db.registerProject({ path: resolvedPath, name, github_remote: remote });
        console.log(`[cli] 已注册项目: ${name} → ${resolvedPath}${remote ? ` (${remote})` : ''}`);
        break;
      }

      case 'project-list': {
        const projects = db.listProjects();
        if (projects.length === 0) {
          console.log('[cli] 没有注册的项目');
        } else {
          console.log(`\n=== 注册项目 (${projects.length}) ===\n`);
          for (const p of projects) {
            const syncStatus = p.last_sync_at ? `last sync: ${p.last_sync_at} (${p.last_sync_result})` : 'never synced';
            const agent = p.primary_agent_session ? `agent: ${p.primary_agent_session}` : 'no agent';
            console.log(`  ${p.name}`);
            console.log(`    path: ${p.path}`);
            console.log(`    ${syncStatus} | ${agent}`);
            console.log();
          }
        }
        break;
      }

      case 'agent-register': {
        // Agent 报到: npx tsx src/cli.ts agent-register <project_path> <agent_type> [session_id]
        const projectPath = process.argv[3];
        const agentType = process.argv[4] as 'solo' | 'proxy' | 'worker' | 'controller';
        const sessionId = process.argv[5];
        if (!projectPath || !agentType) {
          console.error('用法: agent-register <project_path> <agent_type> [session_id]');
          console.error('  agent_type: solo | proxy | worker | controller');
          process.exit(1);
        }
        const resolvedPath = path.resolve(projectPath);
        const result = db.registerAgent({
          project_path: resolvedPath,
          agent_type: agentType,
          device_id: deviceId,
          session_id: sessionId,
        });
        console.log(`[cli] Agent 注册成功:`);
        console.log(`  session: ${result.session_id}`);
        console.log(`  primary: ${result.is_primary ? '是（第一责任人）' : '否'}`);
        console.log(`  inherited: ${result.inherited ? '是（继承了前任 session）' : '否'}`);
        break;
      }

      case 'agent-heartbeat': {
        // Agent 心跳: npx tsx src/cli.ts agent-heartbeat <session_id>
        const sid = process.argv[3];
        if (!sid) { console.error('用法: agent-heartbeat <session_id>'); process.exit(1); }
        db.agentHeartbeat(sid);
        console.log(`[cli] heartbeat: ${sid}`);
        break;
      }

      case 'agent-deregister': {
        // Agent 注销: npx tsx src/cli.ts agent-deregister <session_id>
        const sid = process.argv[3];
        if (!sid) { console.error('用法: agent-deregister <session_id>'); process.exit(1); }
        db.deregisterAgent(sid);
        console.log(`[cli] Agent 已注销: ${sid}`);
        break;
      }

      case 'agent-prune': {
        const pruned = db.pruneDeadAgents();
        if (pruned > 0) console.log(`[cli] 清理了 ${pruned} 个超时 Agent`);
        break;
      }

      case 'agent-list': {
        const filterProject = process.argv[3];
        const agents = db.listAgents(filterProject ? path.resolve(filterProject) : undefined);
        if (agents.length === 0) {
          console.log('[cli] 没有注册的 Agent');
        } else {
          console.log(`\n=== Agent Sessions (${agents.length}) ===\n`);
          for (const a of agents) {
            const primary = a.is_primary ? ' [PRIMARY]' : '';
            console.log(`  ${a.session_id}${primary}`);
            console.log(`    project: ${a.project_path}`);
            console.log(`    type: ${a.agent_type} | status: ${a.status} | device: ${a.device_id}`);
            console.log(`    heartbeat: ${a.last_heartbeat}`);
            console.log();
          }
        }
        break;
      }

      case 'sandbox': {
        const subCmd = process.argv[3];
        const SOTAGENT_API = `http://127.0.0.1:${(config as any).ports?.sotagent_api ?? 4800}`;

        if (subCmd === 'start') {
          const command = process.argv[4];
          if (!command) {
            console.error('用法: sandbox start <command> [--name <name>] [--nice <priority>] [--timeout <sec>] [--memory <mb>]');
            process.exit(1);
          }
          const flags = process.argv.slice(5);
          const getFlag = (name: string): string | undefined => {
            const idx = flags.indexOf(name);
            return idx >= 0 && idx + 1 < flags.length ? flags[idx + 1] : undefined;
          };
          const body: Record<string, unknown> = { command };
          const name = getFlag('--name'); if (name) body.name = name;
          const nice = getFlag('--nice'); if (nice) body.nice_priority = parseInt(nice);
          const timeout = getFlag('--timeout'); if (timeout) body.max_duration_sec = parseInt(timeout);
          const memory = getFlag('--memory'); if (memory) body.max_memory_mb = parseInt(memory);
          const variant = getFlag('--variant'); if (variant) body.name = (body.name ?? command.split(/\s/)[0]) + '-' + variant;

          try {
            const res = await fetch(`${SOTAGENT_API}/api/sandbox/start`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(body),
            });
            const data = await res.json() as Record<string, unknown>;
            if (data.ok) {
              console.log(`[sandbox] 启动成功: ${data.sandbox_id ?? data.id ?? 'ok'}`);
            } else {
              console.error(`[sandbox] 启动失败: ${data.message ?? JSON.stringify(data)}`);
              process.exit(1);
            }
          } catch (e) {
            console.error(`[sandbox] SOTAgent 不可达 (${SOTAGENT_API}):`, (e as Error).message);
            process.exit(1);
          }
        } else if (subCmd === 'stop') {
          const sandboxId = process.argv[4];
          if (!sandboxId) {
            console.error('用法: sandbox stop <sandbox-id>');
            process.exit(1);
          }
          try {
            const res = await fetch(`${SOTAGENT_API}/api/sandbox/stop/${sandboxId}`, { method: 'POST' });
            const data = await res.json() as Record<string, unknown>;
            if (data.ok) {
              console.log(`[sandbox] 已停止: ${sandboxId}`);
            } else {
              console.error(`[sandbox] 停止失败: ${data.message ?? JSON.stringify(data)}`);
              process.exit(1);
            }
          } catch (e) {
            console.error(`[sandbox] SOTAgent 不可达:`, (e as Error).message);
            process.exit(1);
          }
        } else if (subCmd === 'status') {
          try {
            const res = await fetch(`${SOTAGENT_API}/api/sandbox/status`);
            const data = await res.json() as { sandboxes?: Array<Record<string, unknown>> };
            const sandboxes = data.sandboxes ?? (Array.isArray(data) ? data : []);
            if (sandboxes.length === 0) {
              console.log('[sandbox] 当前没有沙箱进程');
            } else {
              console.log(`\n=== 沙箱进程 (${sandboxes.length}) ===\n`);
              const header = 'ID'.padEnd(20) + 'NAME'.padEnd(20) + 'STATUS'.padEnd(12) + 'PID'.padEnd(8) + 'RUNTIME';
              console.log(header);
              console.log('-'.repeat(header.length));
              for (const s of sandboxes) {
                const id = String(s.id ?? s.sandbox_id ?? '').slice(0, 18);
                const name = String(s.name ?? '-').slice(0, 18);
                const status = String(s.status ?? 'unknown');
                const pid = String(s.pid ?? '-');
                const startedAt = s.started_at ? new Date(s.started_at as string) : null;
                const runtime = startedAt ? `${Math.round((Date.now() - startedAt.getTime()) / 1000)}s` : '-';
                console.log(`${id.padEnd(20)}${name.padEnd(20)}${status.padEnd(12)}${pid.padEnd(8)}${runtime}`);
              }
            }
          } catch (e) {
            console.error(`[sandbox] SOTAgent 不可达:`, (e as Error).message);
            process.exit(1);
          }
        } else {
          console.log(`sandbox 子命令:
  sandbox start <command> [--name <n>] [--nice <p>] [--timeout <s>] [--memory <mb>] [--variant <v>]
  sandbox stop <sandbox-id>
  sandbox status`);
        }
        break;
      }

      case 'register-port': {
        const port = parseInt(process.argv[3] ?? '', 10);
        const serviceName = process.argv[4];
        const project = process.argv[5] || 'unknown';
        if (isNaN(port) || !serviceName) {
          console.error('用法: register-port <port> <service_name> [project]');
          process.exit(1);
        }
        if (!SOTAgentDB.isPortCompliant(port)) {
          console.error(
            `[cli] 端口 ${port} 不符合治理规则（须以 0 或 5 结尾）。请改用合规端口后再注册。`,
          );
          process.exit(1);
        }
        const deviceKeys = config.devices ? Object.keys(config.devices) : [];
        const deviceId = deviceKeys[0] || 'local';
        const allocated = db.allocatePort({
          service_name: serviceName,
          project,
          device_id: deviceId,
          preferred_port: port,
        });
        if (allocated) {
          console.log(`[cli] 端口已注册: ${allocated} → ${serviceName} (${project})`);
        } else {
          console.error(`[cli] 端口注册失败: ${port} 不可用或不符合治理规则`);
          process.exit(1);
        }
        break;
      }

      default:
        console.log(`SOTAgent CLI — 可用命令:
  process-inbox     扫描并处理所有 inbox 消息
  schedule          运行一次调度循环
  monitor           采样运行中任务 + 系统进程扫描
  monitor-collect   采集一次资源快照
  status            显示系统状态摘要
  register          注册技术资产
  subscribe         订阅技术资产
  github-sync       GitHub 同步巡检（每 30 分钟自动执行）
  project-register  注册项目到同步管理
  project-list      列出所有注册项目
  agent-register    Agent 报到并获取 session
  agent-heartbeat   Agent 心跳
  agent-deregister  Agent 注销
  agent-list        列出所有 Agent session
  register-port     注册端口到端口治理表
  sandbox           沙箱进程管理 (start/stop/status)
`);
    }
  } finally {
    db.close();
  }
}

main().catch(err => {
  console.error('[cli] 致命错误:', err);
  process.exit(1);
});
