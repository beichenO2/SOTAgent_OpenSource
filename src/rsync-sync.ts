/**
 * rsync-sync.ts
 *
 * 大文件跨设备自动同步模块。
 * git 负责版本控制，此模块通过 rsync over SSH 同步 git-ignored 的大文件。
 *
 * 触发时机：
 *   - 本机 git push 成功后 → rsync PUSH 到对端（我的大文件 → 对端）
 *   - 本机 git pull 成功后 → rsync PULL 从对端（对端大文件 → 我这边）
 */

import { spawn } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import { IPeerSyncConfig, IDeviceConfigEntry } from './types.js';

const log = (...args: unknown[]) =>
  console.log('[rsync-sync]', new Date().toISOString(), ...args);

// ─── 构建 rsync 命令 ───────────────────────────────────────

function buildRsyncArgs(
  srcDir: string,
  dstDir: string,
  sshTarget: string,
  rsyncCfg: NonNullable<IPeerSyncConfig['rsync_large_files']>,
  direction: 'push' | 'pull',
): string[] {
  const port = rsyncCfg.ssh_port ?? 22;
  const bwLimit = rsyncCfg.bandwidth_limit_kbps ?? 0;
  const extraExcludes = rsyncCfg.exclude_patterns ?? [];

  const baseExcludes = ['.git/', 'node_modules/', '.DS_Store'];
  const allExcludes = [...new Set([...baseExcludes, ...extraExcludes])];

  const args: string[] = [
    '-avz',                             // archive + verbose + compress
    '--progress',
    '-e', `ssh -p ${port} -o StrictHostKeyChecking=no -o ConnectTimeout=10`,
  ];

  // 带宽限制
  if (bwLimit > 0) args.push(`--bwlimit=${bwLimit}`);

  // 排除列表
  for (const ex of allExcludes) args.push('--exclude', ex);

  // 只同步 git-ignored 文件（--filter=':- .gitignore' 让 rsync 读取各级 .gitignore）
  // 但我们需要反向：同步 gitignored 的文件，跳过 git-tracked 的
  // 简单实现：同步所有文件（git tracked 重复传一次无害，大文件是主要目标）
  // 对端 git 状态由 PeerSync git 逻辑保证，rsync 只补大文件

  if (direction === 'push') {
    // 本机 → 对端
    args.push(`${srcDir}/`, `${sshTarget}:${dstDir}/`);
  } else {
    // 对端 → 本机
    args.push(`${sshTarget}:${srcDir}/`, `${dstDir}/`);
  }

  return args;
}

// ─── 执行单个项目的 rsync ─────────────────────────────────

export async function rsyncProject(
  projectPath: string,
  remotePath: string,
  sshTarget: string,
  rsyncCfg: NonNullable<IPeerSyncConfig['rsync_large_files']>,
  direction: 'push' | 'pull',
): Promise<void> {
  if (!fs.existsSync(projectPath)) {
    log(`跳过（本地路径不存在）: ${projectPath}`);
    return;
  }

  const args = buildRsyncArgs(projectPath, remotePath, sshTarget, rsyncCfg, direction);
  const projectName = path.basename(projectPath);

  log(`${direction.toUpperCase()} ${projectName} via rsync...`);

  return new Promise((resolve, reject) => {
    const proc = spawn('rsync', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';

    proc.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });
    proc.on('close', (code) => {
      if (code === 0) {
        log(`✓ ${projectName} rsync ${direction} 完成`);
        resolve();
      } else {
        log(`✗ ${projectName} rsync ${direction} 失败 (exit ${code}): ${stderr.trim()}`);
        // rsync 失败不抛出，不阻塞主 PeerSync 流程
        resolve();
      }
    });
    proc.on('error', (err) => {
      log(`✗ ${projectName} rsync 启动失败:`, err.message);
      resolve(); // 同样不阻塞
    });
  });
}

// ─── 批量同步白名单项目 ───────────────────────────────────

export async function rsyncAllProjects(
  scanRoot: string,
  whitelist: string[],
  peerDeviceConfig: IDeviceConfigEntry & { tailscale_ip: string },
  rsyncCfg: NonNullable<IPeerSyncConfig['rsync_large_files']>,
  direction: 'push' | 'pull',
): Promise<void> {
  if (!rsyncCfg.enabled) return;

  const sshUser = peerDeviceConfig.ssh_user ?? 'root';
  const sshTarget = `${sshUser}@${peerDeviceConfig.tailscale_ip}`;
  const expandedRoot = scanRoot.replace(/^~/, process.env['HOME'] ?? '');
  const remoteRoot = expandedRoot; // 两端目录结构相同（~/Polarisor/xxx）

  const projects = whitelist.length > 0
    ? whitelist
    : (fs.existsSync(expandedRoot)
        ? fs.readdirSync(expandedRoot, { withFileTypes: true })
            .filter(e => e.isDirectory() && !e.name.startsWith('.'))
            .map(e => e.name)
        : []);

  log(`${direction.toUpperCase()} ${projects.length} 个项目大文件 → ${sshTarget}`);

  // 串行执行，避免带宽争抢
  for (const proj of projects) {
    const localPath = path.join(expandedRoot, proj);
    const remotePath = path.join(remoteRoot, proj);
    await rsyncProject(localPath, remotePath, sshTarget, rsyncCfg, direction);
  }

  log(`全部 rsync ${direction} 完成`);
}
