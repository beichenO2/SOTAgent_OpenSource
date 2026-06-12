/**
 * sync-engine.ts — SOTA 技术同步引擎
 *
 * 两级同步策略：
 * - Level 1 (auto): Skill 等标准文件，检测变更后自动 rsync 到所有订阅项目
 * - Level 2 (suggest): 架构/工作方式等非标准内容，生成建议文件等待评估
 *
 * 同步流程：
 * 1. 接收 sync_request（来自 inbox）
 * 2. 更新技术注册表（canonical 版本）
 * 3. 查找所有订阅该资产的项目
 * 4. 根据 sync_level 决定自动同步或生成建议
 * 5. 记录同步日志
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';
import crypto from 'node:crypto';
import { nanoid } from 'nanoid';
import { SOTAgentDB, type ISubscriptionRow } from './db.js';
import type { ISyncRequestPayload, AssetType, IOutboxResponse } from './types.js';
import { writeInboxFlag } from './inbox-flag.js';
import { validatePath } from './command-guard.js';

/**
 * Canonical outbox path — always ~/.sotagent/outbox/ regardless of
 * whether the process runs from the repo or the launchd local copy.
 * repo-sync.sh handles pushing to the git-tracked repo outbox.
 */
const GLOBAL_OUTBOX_DIR = path.join(os.homedir(), '.sotagent', 'outbox');

export interface ISyncResult {
  asset_id: string;
  auto_synced: string[];      // 自动同步成功的项目
  suggestions_sent: string[]; // 发送建议的项目
  skipped: string[];          // 跳过的项目（源项目自己）
  errors: Array<{ project: string; error: string }>;
}

export class SyncEngine {
  private db: SOTAgentDB;

  constructor(db: SOTAgentDB) {
    this.db = db;
  }

  /** 计算文件内容 hash */
  private fileHash(filePath: string): string {
    if (!fs.existsSync(filePath)) return '';
    const content = fs.readFileSync(filePath);
    return crypto.createHash('sha256').update(content).digest('hex').slice(0, 16);
  }

  /** 用 diff 生成变更摘要 */
  private diffFiles(oldPath: string, newPath: string): string {
    try {
      const result = execSync(
        `diff -u "${oldPath}" "${newPath}" 2>/dev/null || true`,
        { encoding: 'utf-8', timeout: 5000 },
      );
      if (!result.trim()) return '(无差异)';
      // 截断过长的 diff
      const lines = result.split('\n');
      if (lines.length > 50) {
        return lines.slice(0, 50).join('\n') + `\n... (共 ${lines.length} 行差异)`;
      }
      return result;
    } catch {
      return '(diff 生成失败)';
    }
  }

  /** 复制文件（rsync 风格，保留目录结构） */
  private syncFile(src: string, dest: string): void {
    const destDir = path.dirname(dest);
    if (!fs.existsSync(destDir)) fs.mkdirSync(destDir, { recursive: true });
    fs.copyFileSync(src, dest);
  }

  /**
   * 处理同步请求
   * @param request - 来自 inbox 的同步请求
   * @param fromProject - 发起同步的项目 ID
   */
  async processSyncRequest(
    request: ISyncRequestPayload,
    fromProject: string,
  ): Promise<ISyncResult> {
    const assetId = request.asset_id ?? `${request.asset_type}:${path.basename(request.asset_path, path.extname(request.asset_path))}`;
    const srcPath = request.asset_path;

    const pathCheck = validatePath(srcPath);
    if (!pathCheck.ok) {
      throw new Error(`路径安全校验失败: ${pathCheck.reason}`);
    }

    if (!fs.existsSync(srcPath)) {
      throw new Error(`源文件不存在: ${srcPath}`);
    }

    const contentHash = this.fileHash(srcPath);

    // 1. 更新技术注册表
    this.db.registerAsset({
      id: assetId,
      type: request.asset_type,
      canonical_path: srcPath,
      content_hash: contentHash,
      updated_by: fromProject,
    });

    // 2. 查找订阅者
    const subscribers = this.db.getSubscribers(assetId);
    const result: ISyncResult = {
      asset_id: assetId,
      auto_synced: [],
      suggestions_sent: [],
      skipped: [],
      errors: [],
    };

    if (subscribers.length === 0) {
      console.log(`[sync-engine] 资产 ${assetId} 暂无订阅者`);
      return result;
    }

    // 3. 逐个订阅者处理
    for (const sub of subscribers) {
      if (sub.project_id === fromProject) {
        result.skipped.push(sub.project_id);
        continue;
      }

      try {
        if (sub.sync_level === 'auto') {
          this.autoSync(srcPath, sub, assetId, fromProject, contentHash, result);
        } else if (sub.sync_level === 'suggest') {
          this.suggestSync(srcPath, sub, assetId, fromProject, request.change_summary, result);
        } else {
          // manual: 只记录日志，不做任何事
          this.db.logSync({
            asset_id: assetId,
            from_project: fromProject,
            to_project: sub.project_id,
            action: 'pending',
            diff_summary: '手动同步级别，等待用户操作',
          });
          result.skipped.push(sub.project_id);
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        result.errors.push({ project: sub.project_id, error: msg });
        console.error(`[sync-engine] 同步到 ${sub.project_id} 失败: ${msg}`);
      }
    }

    return result;
  }

  /** Level 1: 自动同步 — 直接复制文件 */
  private autoSync(
    srcPath: string,
    sub: ISubscriptionRow,
    assetId: string,
    fromProject: string,
    contentHash: string,
    result: ISyncResult,
  ): void {
    const destPath = sub.project_path;

    // 检查目标文件是否和源一致（避免无意义同步）
    if (fs.existsSync(destPath)) {
      const destHash = this.fileHash(destPath);
      if (destHash === contentHash) {
        console.log(`[sync-engine] ${sub.project_id} 已是最新，跳过`);
        result.skipped.push(sub.project_id);
        return;
      }
    }

    // 生成 diff 日志
    let diffSummary = '(新文件)';
    if (fs.existsSync(destPath)) {
      diffSummary = this.diffFiles(destPath, srcPath);
    }

    // 执行同步
    this.syncFile(srcPath, destPath);

    this.db.logSync({
      asset_id: assetId,
      from_project: fromProject,
      to_project: sub.project_id,
      action: 'synced',
      diff_summary: diffSummary,
    });

    result.auto_synced.push(sub.project_id);
    console.log(`[sync-engine] 自动同步 ${assetId} → ${sub.project_id}`);
  }

  /**
   * Check if an identical suggest already exists in outbox for the same
   * asset+project combination by comparing source/target content hashes.
   * Returns true when the suggestion would be a duplicate.
   */
  private hasDuplicateSuggest(
    outboxDir: string,
    assetId: string,
    srcHash: string,
    destHash: string,
  ): boolean {
    const markerFile = path.join(outboxDir, `.last-suggest-${assetId.replace(/[:/]/g, '_')}.json`);
    if (!fs.existsSync(markerFile)) return false;
    try {
      const marker = JSON.parse(fs.readFileSync(markerFile, 'utf-8'));
      return marker.srcHash === srcHash && marker.destHash === destHash;
    } catch {
      return false;
    }
  }

  private writeSuggestMarker(
    outboxDir: string,
    assetId: string,
    srcHash: string,
    destHash: string,
  ): void {
    const markerFile = path.join(outboxDir, `.last-suggest-${assetId.replace(/[:/]/g, '_')}.json`);
    fs.writeFileSync(markerFile, JSON.stringify({ srcHash, destHash, ts: Date.now() }));
  }

  /** Level 2: 建议同步 — 生成建议文件到 outbox */
  private suggestSync(
    srcPath: string,
    sub: ISubscriptionRow,
    assetId: string,
    fromProject: string,
    changeSummary: string,
    result: ISyncResult,
  ): void {
    const outboxDir = path.join(GLOBAL_OUTBOX_DIR, sub.project_id);
    if (!fs.existsSync(outboxDir)) fs.mkdirSync(outboxDir, { recursive: true });

    const srcHash = this.fileHash(srcPath);
    const destHash = fs.existsSync(sub.project_path) ? this.fileHash(sub.project_path) : '';

    if (srcHash === destHash) {
      result.skipped.push(sub.project_id);
      return;
    }

    if (this.hasDuplicateSuggest(outboxDir, assetId, srcHash, destHash)) {
      result.skipped.push(sub.project_id);
      return;
    }

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const suggestFile = path.join(outboxDir, `suggest-${timestamp}.md`);

    // 生成 diff
    let diffContent = '(新文件，无对比)';
    if (fs.existsSync(sub.project_path)) {
      diffContent = this.diffFiles(sub.project_path, srcPath);
    }

    this.writeSuggestMarker(outboxDir, assetId, srcHash, destHash);

    const content = `# 技术同步建议

- **资产**: ${assetId}
- **类型**: suggest（需要评估）
- **来源项目**: ${fromProject}
- **变更摘要**: ${changeSummary}
- **时间**: ${new Date().toISOString()}

## 变更内容

源文件: \`${srcPath}\`
目标文件: \`${sub.project_path}\`

\`\`\`diff
${diffContent}
\`\`\`

## 建议操作

请评估此变更是否适用于本项目。回复方式：

写入一个 JSON 文件到 SOTAgent 的 inbox：
\`\`\`json
{
  "type": "sync_response",
  "from": "your-agent-id",
  "device": "your-device",
  "project": "${sub.project_id}",
  "timestamp": "${new Date().toISOString()}",
  "payload": {
    "asset_id": "${assetId}",
    "action": "self-evolved 或 needs-user-intervention",
    "details": "说明你做了什么或为什么需要用户介入"
  }
}
\`\`\`
`;

    fs.writeFileSync(suggestFile, content, 'utf-8');

    // 同时生成一个 evolution_request 到 outbox
    const evolutionReq: IOutboxResponse = {
      id: `evo-${nanoid(10)}`,
      type: 'evolution_request',
      to_project: sub.project_id,
      timestamp: new Date().toISOString(),
      payload: {
        asset_id: assetId,
        asset_type: 'suggest',
        source_project: fromProject,
        source_path: srcPath,
        target_path: sub.project_path,
        change_summary: changeSummary,
        suggest_file: suggestFile,
      },
    };
    const reqFile = path.join(outboxDir, `evolution-req-${timestamp}.json`);
    fs.writeFileSync(reqFile, JSON.stringify(evolutionReq, null, 2), 'utf-8');

    this.db.logSync({
      asset_id: assetId,
      from_project: fromProject,
      to_project: sub.project_id,
      action: 'suggested',
      diff_summary: changeSummary,
    });

    result.suggestions_sent.push(sub.project_id);
    writeInboxFlag('sync_suggestion', {
      project: sub.project_id,
      detail: `${assetId} from ${fromProject}`,
    });
    console.log(`[sync-engine] 同步建议已发送 → ${sub.project_id}: ${suggestFile}`);
  }

  /**
   * 清理 outbox 中超过 maxAgeDays 天的 suggest/evolution-req 文件。
   * 由 web.ts 的每日定时器调用。
   */
  purgeStaleOutbox(maxAgeDays = 3): { deleted: number; dirs: number } {
    let deleted = 0;
    let dirs = 0;
    if (!fs.existsSync(GLOBAL_OUTBOX_DIR)) return { deleted, dirs };

    const cutoff = Date.now() - maxAgeDays * 86_400_000;

    for (const entry of fs.readdirSync(GLOBAL_OUTBOX_DIR, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const dirPath = path.join(GLOBAL_OUTBOX_DIR, entry.name);
      if (entry.name === 'user-review') continue;

      for (const file of fs.readdirSync(dirPath)) {
        if (file.startsWith('.last-suggest-')) continue;
        const filePath = path.join(dirPath, file);
        try {
          const stat = fs.statSync(filePath);
          if (stat.mtimeMs < cutoff) {
            fs.unlinkSync(filePath);
            deleted++;
          }
        } catch { /* skip */ }
      }

      const remaining = fs.readdirSync(dirPath).filter(f => !f.startsWith('.'));
      if (remaining.length === 0) {
        try { fs.rmSync(dirPath, { recursive: true }); dirs++; } catch { /* skip */ }
      }
    }

    if (deleted > 0) {
      console.log(`[sync-engine] outbox purge: ${deleted} files deleted, ${dirs} empty dirs removed`);
    }
    return { deleted, dirs };
  }

  /** 处理 Agent 的同步回复（self-evolved / needs-user-intervention） */
  processSyncResponse(params: {
    asset_id: string;
    from_project: string;
    action: 'self-evolved' | 'needs-user-intervention';
    details?: string;
  }): void {
    this.db.logSync({
      asset_id: params.asset_id,
      from_project: params.from_project,
      to_project: params.from_project,
      action: params.action === 'self-evolved' ? 'self-evolved' : 'rejected',
      diff_summary: params.details ?? params.action,
    });

    if (params.action === 'needs-user-intervention') {
      // 写入 user-review
      const reviewDir = path.join(GLOBAL_OUTBOX_DIR, 'user-review');
      if (!fs.existsSync(reviewDir)) fs.mkdirSync(reviewDir, { recursive: true });

      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const reviewFile = path.join(reviewDir, `review-${params.from_project}-${timestamp}.md`);
      fs.writeFileSync(reviewFile, `# 需要用户干预

- **项目**: ${params.from_project}
- **资产**: ${params.asset_id}
- **原因**: ${params.details ?? '(未说明)'}
- **时间**: ${new Date().toISOString()}

Agent 表示无法自行完成此同步，需要用户介入。
`, 'utf-8');

      console.log(`[sync-engine] 用户干预请求已记录: ${reviewFile}`);
    } else {
      console.log(`[sync-engine] ${params.from_project} 已自进化适配 ${params.asset_id}`);
    }
  }
}
