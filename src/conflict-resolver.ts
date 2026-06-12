/**
 * conflict-resolver.ts — 同步冲突自动解决
 *
 * 由 PeerSync 检测到冲突后调用。
 * 策略：
 *   1. local_behind_with_changes:
 *      - git stash → git pull → git stash pop
 *      - 如果 stash pop 有合并冲突 → 回滚到 stash，通知用户
 *   2. both_uncommitted:
 *      - 不自动处理，仅记录告警日志
 *
 * 所有操作都有详细日志，写入 conflict-log。
 */

import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import type { IConflictAlert, IProjectGitState } from './types.js';

const execAsync = promisify(exec);

export interface IResolutionResult {
  project: string;
  conflictType: string;
  action: 'auto_resolved' | 'needs_human' | 'skipped';
  detail: string;
  timestamp: string;
}

const resolutionLog: IResolutionResult[] = [];
const MAX_LOG = 200;

async function gitAsync(cwd: string, args: string, timeoutMs = 15_000): Promise<string> {
  try {
    const { stdout } = await execAsync(`git ${args}`, { cwd, timeout: timeoutMs });
    return stdout.trim();
  } catch (err: any) {
    throw new Error(err.stderr?.trim() || err.message);
  }
}

/**
 * 尝试自动解决 local_behind_with_changes 冲突
 */
async function resolveLocalBehind(project: IProjectGitState): Promise<IResolutionResult> {
  const result: IResolutionResult = {
    project: project.project,
    conflictType: 'local_behind_with_changes',
    action: 'skipped',
    detail: '',
    timestamp: new Date().toISOString(),
  };

  try {
    // 1. Stash local changes
    const stashMsg = `auto-stash-${Date.now()}`;
    await gitAsync(project.path, `stash push -m "${stashMsg}"`);
    console.log(`[conflict-resolver] ${project.project}: stash 完成`);

    // 2. Pull
    try {
      await gitAsync(project.path, 'pull --ff-only --quiet', 30_000);
      console.log(`[conflict-resolver] ${project.project}: pull 完成`);
    } catch (pullErr) {
      // ff-only 失败（diverged），回滚 stash
      await gitAsync(project.path, 'stash pop').catch(() => {});
      result.action = 'needs_human';
      result.detail = `pull --ff-only 失败（分支已分叉），本地改动已恢复: ${pullErr}`;
      return result;
    }

    // 3. Stash pop
    try {
      await gitAsync(project.path, 'stash pop');
      console.log(`[conflict-resolver] ${project.project}: stash pop 完成，无冲突`);
      result.action = 'auto_resolved';
      result.detail = 'stash→pull→pop 成功，本地改动已合并到最新版本';
    } catch (popErr) {
      // stash pop 有冲突 — 回滚
      await gitAsync(project.path, 'checkout -- .').catch(() => {});
      await gitAsync(project.path, 'stash pop').catch(() => {});
      result.action = 'needs_human';
      result.detail = `stash pop 时有文件冲突，已回滚。需要手动处理: ${popErr}`;
    }
  } catch (err) {
    result.action = 'needs_human';
    result.detail = `意外错误: ${err}`;
  }

  return result;
}

/**
 * 尝试自动解决 diverged 分支（本地和远端各有对方没有的 commit）
 *
 * 策略优先级：
 *   1. git pull --rebase（保持线性历史）
 *   2. rebase 失败时 abort → 尝试 merge commit
 *   3. merge 也失败 → 回滚，标记 needs_human
 */
async function resolveDiverged(project: IProjectGitState): Promise<IResolutionResult> {
  const result: IResolutionResult = {
    project: project.project,
    conflictType: 'diverged',
    action: 'skipped',
    detail: '',
    timestamp: new Date().toISOString(),
  };

  try {
    // 1. Try rebase (preferred: linear history)
    try {
      await gitAsync(project.path, 'pull --rebase --quiet', 30_000);
      console.log(`[conflict-resolver] ${project.project}: rebase 成功`);
      result.action = 'auto_resolved';
      result.detail = 'pull --rebase 成功，分支已合并为线性历史';

      await gitAsync(project.path, 'push origin HEAD --quiet', 30_000);
      result.detail += '，已推送到远端';
      return result;
    } catch (rebaseErr) {
      // Rebase failed — abort it
      await gitAsync(project.path, 'rebase --abort').catch(() => {});
      console.log(`[conflict-resolver] ${project.project}: rebase 失败，尝试 merge...`);
    }

    // 2. Fallback: merge commit
    try {
      await gitAsync(project.path, 'pull --no-rebase --quiet', 30_000);
      console.log(`[conflict-resolver] ${project.project}: merge 成功`);
      result.action = 'auto_resolved';
      result.detail = 'pull --no-rebase (merge commit) 成功，分支已合并';

      await gitAsync(project.path, 'push origin HEAD --quiet', 30_000);
      result.detail += '，已推送到远端';
      return result;
    } catch (mergeErr) {
      // Merge also failed — abort
      await gitAsync(project.path, 'merge --abort').catch(() => {});
      result.action = 'needs_human';
      result.detail = `rebase 和 merge 均失败（存在文件级冲突），需手动解决: ${mergeErr}`;
    }
  } catch (err) {
    result.action = 'needs_human';
    result.detail = `diverged 自动合并意外失败: ${err}`;
  }

  return result;
}

/**
 * 尝试自动解决 diverged_with_changes（分支分叉 + 本地有未提交改动）
 *
 * 策略：stash → rebase → stash pop → push
 * 失败时回滚到初始状态，标记 needs_human
 */
async function resolveDivergedWithChanges(project: IProjectGitState): Promise<IResolutionResult> {
  const result: IResolutionResult = {
    project: project.project,
    conflictType: 'diverged_with_changes',
    action: 'skipped',
    detail: '',
    timestamp: new Date().toISOString(),
  };

  try {
    // 1. Stash local changes
    const stashMsg = `auto-stash-diverged-${Date.now()}`;
    await gitAsync(project.path, `stash push -m "${stashMsg}"`);
    console.log(`[conflict-resolver] ${project.project}: diverged+dirty — stash 完成`);

    // 2. Try rebase
    let merged = false;
    try {
      await gitAsync(project.path, 'pull --rebase --quiet', 30_000);
      console.log(`[conflict-resolver] ${project.project}: rebase 成功`);
      merged = true;
    } catch {
      await gitAsync(project.path, 'rebase --abort').catch(() => {});
      // 3. Fallback: merge commit
      try {
        await gitAsync(project.path, 'pull --no-rebase --quiet', 30_000);
        console.log(`[conflict-resolver] ${project.project}: merge 成功`);
        merged = true;
      } catch {
        await gitAsync(project.path, 'merge --abort').catch(() => {});
      }
    }

    if (!merged) {
      // Rebase and merge both failed — restore stash and bail
      await gitAsync(project.path, 'stash pop').catch(() => {});
      result.action = 'needs_human';
      result.detail = 'diverged+dirty: rebase 和 merge 均失败（commit 级冲突），已恢复本地改动，需手动解决';
      return result;
    }

    // 4. Apply stashed changes back
    try {
      await gitAsync(project.path, 'stash pop');
      console.log(`[conflict-resolver] ${project.project}: stash pop 完成，无冲突`);
    } catch {
      // Stash pop has conflicts — reset and re-apply stash
      await gitAsync(project.path, 'checkout -- .').catch(() => {});
      await gitAsync(project.path, 'stash pop').catch(() => {});
      result.action = 'needs_human';
      result.detail = 'diverged+dirty: 分支合并成功但 stash pop 时有文件冲突，已恢复本地改动，需手动处理';
      return result;
    }

    // 5. Push the merged result
    await gitAsync(project.path, 'push origin HEAD --quiet', 30_000);

    result.action = 'auto_resolved';
    result.detail = 'diverged+dirty: stash→合并→stash pop→push 全部成功';
  } catch (err) {
    result.action = 'needs_human';
    result.detail = `diverged+dirty 意外失败: ${err}`;
  }

  return result;
}

/**
 * 处理冲突告警
 */
export async function resolveConflict(alert: IConflictAlert): Promise<IResolutionResult> {
  let result: IResolutionResult;

  switch (alert.type) {
    case 'local_behind_with_changes':
      result = await resolveLocalBehind(alert.localState);
      break;

    case 'both_uncommitted':
      result = await resolveBothUncommitted(alert);
      break;

    case 'diverged':
      result = await resolveDiverged(alert.localState);
      break;

    case 'diverged_with_changes':
      result = await resolveDivergedWithChanges(alert.localState);
      break;

    default:
      result = {
        project: alert.project,
        conflictType: alert.type,
        action: 'skipped',
        detail: `未知冲突类型: ${alert.type}`,
        timestamp: new Date().toISOString(),
      };
  }

  resolutionLog.push(result);
  if (resolutionLog.length > MAX_LOG) resolutionLog.shift();

  const icon = result.action === 'auto_resolved' ? '✅' :
               result.action === 'needs_human' ? '🚨' : '⏭️';
  console.log(`[conflict-resolver] ${icon} ${result.project}: ${result.action} — ${result.detail}`);

  return result;
}

/**
 * 处理 both_uncommitted：文件级冲突检测
 *
 * 如果两端的未提交文件列表没有重叠 → 安全处理：
 * 本端先 commit+push，然后对端可以 pull（PeerSync 心跳会触发）
 *
 * 如果有重叠 → 仍需人工处理
 */
async function resolveBothUncommitted(alert: IConflictAlert): Promise<IResolutionResult> {
  const localFiles = new Set(alert.localState.uncommittedFiles ?? []);
  const peerFiles = new Set(alert.peerState.uncommittedFiles ?? []);

  // 文件级信息不可用（老版本心跳没带 uncommittedFiles）
  if (localFiles.size === 0 && peerFiles.size === 0) {
    return {
      project: alert.project,
      conflictType: 'both_uncommitted',
      action: 'needs_human',
      detail: '两端都有未提交改动（缺少文件级信息），不自动处理。建议：一端先 commit+push，另一端再 pull。',
      timestamp: new Date().toISOString(),
    };
  }

  const overlapping = [...localFiles].filter(f => peerFiles.has(f));

  if (overlapping.length > 0) {
    return {
      project: alert.project,
      conflictType: 'both_uncommitted',
      action: 'needs_human',
      detail: `两端有 ${overlapping.length} 个重叠文件: ${overlapping.slice(0, 5).join(', ')}${overlapping.length > 5 ? '...' : ''}。需手动处理。`,
      timestamp: new Date().toISOString(),
    };
  }

  // 无重叠 → 安全自动提交本端
  try {
    const commitMsg = `chore: 自动同步本地改动 (PeerSync auto-commit, ${localFiles.size} 个文件)`;
    await gitAsync(alert.localState.path, 'add -A');
    await gitAsync(alert.localState.path, `commit -m "${commitMsg.replace(/"/g, '\\"')}"`);
    await gitAsync(alert.localState.path, 'push origin HEAD', 30_000);
    console.log(`[conflict-resolver] ✅ ${alert.project}: 无文件重叠，本端已自动 commit+push (${localFiles.size} 文件)`);

    return {
      project: alert.project,
      conflictType: 'both_uncommitted',
      action: 'auto_resolved',
      detail: `无文件重叠（本端 ${localFiles.size} 文件, 对端 ${peerFiles.size} 文件），本端已自动 commit+push。对端将在下次心跳时 auto-pull。`,
      timestamp: new Date().toISOString(),
    };
  } catch (err) {
    return {
      project: alert.project,
      conflictType: 'both_uncommitted',
      action: 'needs_human',
      detail: `无文件重叠但自动 commit+push 失败: ${err}`,
      timestamp: new Date().toISOString(),
    };
  }
}

export function getResolutionLog(): IResolutionResult[] {
  return resolutionLog;
}
