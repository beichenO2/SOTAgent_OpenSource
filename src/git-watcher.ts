/**
 * git-watcher.ts — 本地项目 Git 状态扫描器
 *
 * 扫描 scan_root（默认 ~/Polarisor/）下所有 git 仓库，
 * 返回每个项目的分支、HEAD hash、未提交改动、未推送 commit 数等信息。
 * 供 PeerSync 心跳使用。
 *
 * 全部使用异步 exec 以避免阻塞 Node 事件循环。
 *
 * 忽略规则（两级）：
 *   1. 项目根目录的 .peersyncignore — 项目级，仅对该项目生效
 *   2. config.json peer_sync.global_ignore 数组 — 全局级，对所有项目生效
 *
 * 语法同 .gitignore：支持 * ** ? 通配符，# 注释行，目录前缀自动匹配子路径。
 */

import fs from 'node:fs';
import path from 'node:path';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import type { IProjectGitState } from './types.js';

const execAsync = promisify(exec);

// ─── ignore 工具 ──────────────────────────────────────────────────────────────

/**
 * 将 .gitignore 风格的 glob pattern 转换为 RegExp，支持 * ** ?
 * 目录前缀匹配：pattern "foo/bar" 也会匹配 "foo/bar/baz.ts"
 */
function patternToRegex(pattern: string): RegExp {
  const escaped = pattern
    .replace(/\\/g, '/')                       // 统一斜杠
    .replace(/[.+^${}()|[\]]/g, '\\$&')       // 转义正则特殊字符（保留 * ?）
    .replace(/\*\*/g, '\x00DSTAR\x00')         // 暂存 **
    .replace(/\*/g, '[^/]*')                    // * → 不含斜杠的任意字符
    .replace(/\x00DSTAR\x00/g, '.*')            // ** → 任意字符（含斜杠）
    .replace(/\?/g, '[^/]');                    // ? → 单个非斜杠字符

  // 末尾加 (/.*)?$ 使目录前缀也能匹配其子路径
  return new RegExp(`^${escaped}(/.*)?$`);
}

/**
 * 判断文件路径是否匹配某条 ignore pattern
 */
function matchesPattern(filePath: string, pattern: string): boolean {
  return patternToRegex(pattern).test(filePath.replace(/\\/g, '/'));
}

/**
 * 读取项目根目录的 .peersyncignore 文件，返回有效 pattern 列表。
 * 文件不存在时返回空数组。
 */
function loadPeerSyncIgnore(repoPath: string): string[] {
  const ignorePath = path.join(repoPath, '.peersyncignore');
  if (!fs.existsSync(ignorePath)) return [];
  return fs.readFileSync(ignorePath, 'utf-8')
    .split('\n')
    .map(line => line.trim())
    .filter(line => line.length > 0 && !line.startsWith('#'));
}

/**
 * 过滤掉命中任意 ignore pattern 的文件路径
 */
function filterIgnoredFiles(files: string[], patterns: string[]): string[] {
  if (patterns.length === 0) return files;
  return files.filter(f => !patterns.some(p => matchesPattern(f, p)));
}

// ─── git 工具 ─────────────────────────────────────────────────────────────────

async function git(cwd: string, args: string, timeoutMs = 10_000): Promise<string> {
  try {
    const { stdout } = await execAsync(`git ${args}`, {
      cwd,
      timeout: timeoutMs,
      env: { ...process.env, GIT_SSH_COMMAND: 'ssh -o ConnectTimeout=3 -o BatchMode=yes' },
    });
    return stdout.trim();
  } catch {
    return '';
  }
}

async function scanRepo(repoPath: string, globalIgnore: string[] = []): Promise<IProjectGitState | null> {
  const gitDir = path.join(repoPath, '.git');
  if (!fs.existsSync(gitDir)) return null;

  const [branch, headHash, statusOutput] = await Promise.all([
    git(repoPath, 'rev-parse --abbrev-ref HEAD'),
    git(repoPath, 'rev-parse --short HEAD'),
    git(repoPath, 'status --porcelain'),
  ]);

  // 合并两级 ignore 规则：项目级 + 全局级
  const projectIgnore = loadPeerSyncIgnore(repoPath);
  const allPatterns = [...projectIgnore, ...globalIgnore];

  const rawFiles = statusOutput
    ? statusOutput.split('\n').map(line => line.slice(3).trim()).filter(Boolean)
    : [];

  // 过滤后的文件列表才参与冲突检测和自动同步
  const uncommittedFiles = filterIgnoredFiles(rawFiles, allPatterns);
  const hasUncommitted = uncommittedFiles.length > 0;

  if (allPatterns.length > 0 && rawFiles.length !== uncommittedFiles.length) {
    const ignoredCount = rawFiles.length - uncommittedFiles.length;
    console.log(
      `[git-watcher] ${path.basename(repoPath)}: ${rawFiles.length} 个改动文件，忽略 ${ignoredCount} 个 (.peersyncignore)`,
    );
  }

  await git(repoPath, 'fetch origin --quiet', 5_000);

  const effectiveBranch = branch || 'unknown';
  const trackingBranch = await git(repoPath, `rev-parse --abbrev-ref ${effectiveBranch}@{upstream}`);
  let unpushedCount = 0;
  let remoteAhead = 0;

  if (trackingBranch) {
    const [unpushed, ahead] = await Promise.all([
      git(repoPath, `rev-list ${trackingBranch}..HEAD --count`),
      git(repoPath, `rev-list HEAD..${trackingBranch} --count`),
    ]);
    unpushedCount = parseInt(unpushed, 10) || 0;
    remoteAhead = parseInt(ahead, 10) || 0;
  }

  const lastCommitTs = await git(repoPath, 'log -1 --format=%aI') || new Date().toISOString();

  return {
    project: path.basename(repoPath),
    path: repoPath,
    branch: effectiveBranch,
    headHash: headHash || 'unknown',
    hasUncommitted,
    uncommittedFiles,
    unpushedCount,
    remoteAhead,
    lastActivityTs: lastCommitTs,
  };
}

/**
 * 扫描 scanRoot 下一级 git 仓库（异步）
 * @param scanRoot        扫描根目录（支持 ~ 展开）
 * @param globalIgnore    来自 config.json peer_sync.global_ignore 的全局忽略模式
 * @param projectWhitelist 项目白名单（目录名列表）。非空时只扫描列表内的项目
 */
export async function scanAllRepos(
  scanRoot: string,
  globalIgnore: string[] = [],
  projectWhitelist: string[] = [],
): Promise<IProjectGitState[]> {
  const expandedRoot = scanRoot.replace(/^~/, process.env['HOME'] || '');

  if (!fs.existsSync(expandedRoot)) {
    console.warn(`[git-watcher] 扫描根目录不存在: ${expandedRoot}`);
    return [];
  }

  const entries = fs.readdirSync(expandedRoot, { withFileTypes: true });
  const whitelistSet = new Set(projectWhitelist);
  const repoPaths: string[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (entry.name.startsWith('.')) continue;
    // 白名单模式：非空时只接受白名单内的目录
    if (whitelistSet.size > 0 && !whitelistSet.has(entry.name)) continue;
    repoPaths.push(path.join(expandedRoot, entry.name));
  }

  if (whitelistSet.size > 0) {
    console.log(`[git-watcher] 白名单模式：扫描 ${repoPaths.length}/${entries.filter(e => e.isDirectory()).length} 个项目`);
  }

  const results = await Promise.allSettled(repoPaths.map(p => scanRepo(p, globalIgnore)));
  return results
    .filter((r): r is PromiseFulfilledResult<IProjectGitState | null> =>
      r.status === 'fulfilled' && r.value !== null)
    .map(r => r.value!);
}

