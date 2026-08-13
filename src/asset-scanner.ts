/**
 * asset-scanner.ts — 自动发现并注册技术资产
 *
 * 类似 auto-discover.ts 对项目/端口的自动发现，
 * 本模块扫描所有已注册项目中的技术文件（Skills、Rules、配置等），
 * 自动注册到 tech_assets 表，并按规则建立跨项目订阅。
 *
 * 扫描时机：每次 backgroundScan() 完成后调用。
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { SOTAgentDB } from './db.js';
import { SyncEngine } from './sync-engine.js';
import type { AssetType, SyncLevel } from './types.js';

export interface IAssetPattern {
  glob: string;
  type: AssetType;
  /** 资产 ID 模板，支持 {dirname}、{filename}、{project} 占位符 */
  idTemplate: string;
  /** 默认订阅级别（跨项目发现同类文件时使用） */
  defaultSyncLevel: SyncLevel;
}

const PATTERNS: IAssetPattern[] = [
  // Copilot Skills（.cursor/skills/ — IDE 层技能）
  { glob: '.cursor/skills/*/SKILL.md', type: 'skill', idTemplate: 'skill:{dirname}', defaultSyncLevel: 'suggest' },
  // Claw Skills（skills/ — PolarClaw 自学习生成的运行时技能）
  { glob: 'skills/*/SKILL.md', type: 'skill', idTemplate: 'claw-skill:{dirname}', defaultSyncLevel: 'suggest' },
  { glob: '.cursor/rules/*.mdc', type: 'config', idTemplate: 'rule:{filename}', defaultSyncLevel: 'auto' },
  { glob: '.cursor/rules/*.md', type: 'config', idTemplate: 'rule:{filename}', defaultSyncLevel: 'auto' },

  // 配置文件
  { glob: 'tsconfig.json', type: 'config', idTemplate: 'config:tsconfig', defaultSyncLevel: 'auto' },
  { glob: '.prettierrc*', type: 'config', idTemplate: 'config:prettier', defaultSyncLevel: 'suggest' },
  { glob: '.eslintrc*', type: 'config', idTemplate: 'config:eslint', defaultSyncLevel: 'suggest' },
  { glob: 'eslint.config.*', type: 'config', idTemplate: 'config:eslint-flat', defaultSyncLevel: 'suggest' },
  { glob: 'vitest.config.*', type: 'config', idTemplate: 'config:vitest', defaultSyncLevel: 'suggest' },

  // 架构文档
  { glob: '.planning/ARCHITECTURE.md', type: 'architecture', idTemplate: 'arch:{project}', defaultSyncLevel: 'suggest' },

  // 工作流
  { glob: '.github/workflows/*.yml', type: 'workflow', idTemplate: 'workflow:{filename}', defaultSyncLevel: 'suggest' },
  { glob: '.github/workflows/*.yaml', type: 'workflow', idTemplate: 'workflow:{filename}', defaultSyncLevel: 'suggest' },
];

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '__pycache__', '.venv', 'venv']);

/** 计算文件内容 hash（前 16 位 SHA-256） */
function fileHash(filePath: string): string {
  const content = fs.readFileSync(filePath);
  return crypto.createHash('sha256').update(content).digest('hex').slice(0, 16);
}

/** 用模板生成资产 ID */
function resolveId(template: string, context: { dirname: string; filename: string; project: string }): string {
  return template
    .replace('{dirname}', context.dirname)
    .replace('{filename}', context.filename)
    .replace('{project}', context.project);
}

export interface IScanAssetsResult {
  registered: number;
  updated: number;
  deleted: number;
  subscriptions_created: number;
  syncs_triggered: number;
  errors: string[];
}

/**
 * 扫描所有已注册项目，发现技术资产并注册/更新。
 * 同时为拥有同类文件的项目建立交叉订阅。
 * 当已注册资产的 content_hash 变更时，触发 SyncEngine 推送给订阅者。
 */
export async function scanAssets(db: SOTAgentDB, syncEngine?: SyncEngine): Promise<IScanAssetsResult> {
  const projects = db.listProjects();
  const result: IScanAssetsResult = {
    registered: 0,
    updated: 0,
    deleted: 0,
    subscriptions_created: 0,
    syncs_triggered: 0,
    errors: [],
  };

  // Collect hash changes to trigger sync after registration
  const changedAssets: Array<{ assetId: string; type: AssetType; filePath: string; projectName: string }> = [];

  // assetId → 拥有该资产的项目列表（用于后续交叉订阅）
  const assetOwners = new Map<string, { projectName: string; projectPath: string; filePath: string; pattern: IAssetPattern }[]>();
  // 本次扫描发现的所有 assetId
  const discoveredIds = new Set<string>();
  // Track per-project hashes to detect real changes vs multi-owner oscillation
  const perProjectHash = new Map<string, string>(); // "assetId::project" → hash

  for (const project of projects) {
    if (!fs.existsSync(project.path)) continue;

    const projectName = project.name;

    for (const pattern of PATTERNS) {
      try {
        const matches = findFiles(project.path, pattern.glob);

        for (const match of matches) {
          const relPath = path.relative(project.path, match);
          const dirname = path.basename(path.dirname(match));
          const filename = path.basename(match, path.extname(match));

          const assetId = resolveId(pattern.idTemplate, { dirname, filename, project: projectName });
          discoveredIds.add(assetId);

          const hash = fileHash(match);
          perProjectHash.set(`${assetId}::${projectName}`, hash);
          const existing = db.getAsset(assetId);

          if (!existing) {
            db.registerAsset({
              id: assetId,
              type: pattern.type,
              canonical_path: match,
              content_hash: hash,
              updated_by: projectName,
            });
            result.registered++;
          } else if (existing.content_hash !== hash && existing.updated_by === projectName) {
            // Only count as updated when the same project that last set the
            // canonical version has a new hash — avoids oscillation when
            // multiple projects own variants of the same assetId.
            db.registerAsset({
              id: assetId,
              type: pattern.type,
              canonical_path: match,
              content_hash: hash,
              updated_by: projectName,
            });
            result.updated++;
            changedAssets.push({ assetId, type: pattern.type, filePath: match, projectName });
          }

          if (!assetOwners.has(assetId)) assetOwners.set(assetId, []);
          assetOwners.get(assetId)!.push({
            projectName,
            projectPath: project.path,
            filePath: match,
            pattern,
          });
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        result.errors.push(`${projectName}/${pattern.glob}: ${msg}`);
      }
    }
  }

  // 交叉订阅：如果多个项目拥有同一 assetId 的文件，互相订阅
  for (const [assetId, owners] of assetOwners) {
    if (owners.length < 2) continue;

    for (const owner of owners) {
      const existingSubs = db.getSubscribers(assetId);
      const alreadySubscribed = existingSubs.some(s => s.project_id === owner.projectName);

      if (!alreadySubscribed) {
        db.subscribe({
          project_id: owner.projectName,
          asset_id: assetId,
          sync_level: owner.pattern.defaultSyncLevel,
          project_path: owner.filePath,
        });
        result.subscriptions_created++;
      }
    }
  }

  // Trigger SyncEngine for changed assets → push updates to subscribers
  if (syncEngine && changedAssets.length > 0) {
    for (const changed of changedAssets) {
      try {
        const subscribers = db.getSubscribers(changed.assetId);
        if (subscribers.length === 0) continue;

        const syncResult = await syncEngine.processSyncRequest(
          {
            asset_type: changed.type,
            asset_id: changed.assetId,
            asset_path: changed.filePath,
            change_summary: `asset-scanner 检测到 ${changed.assetId} 在 ${changed.projectName} 中发生变更`,
          },
          changed.projectName,
        );

        const syncCount = syncResult.auto_synced.length + syncResult.suggestions_sent.length;
        if (syncCount > 0) {
          result.syncs_triggered += syncCount;
          console.log(
            `[asset-scanner] 同步触发 ${changed.assetId}: ${syncResult.auto_synced.length} auto, ${syncResult.suggestions_sent.length} suggest`,
          );
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        result.errors.push(`sync ${changed.assetId}: ${msg}`);
      }
    }
  }

  // 标记已消失的资产（文件被删除的情况）
  const allAssets = db.listAssets();
  for (const asset of allAssets) {
    if (!discoveredIds.has(asset.id) && !fs.existsSync(asset.canonical_path)) {
      db.logSync({
        asset_id: asset.id,
        from_project: 'asset-scanner',
        to_project: 'asset-scanner',
        action: 'pending',
        diff_summary: `文件已删除: ${asset.canonical_path}`,
      });
      result.deleted++;
    }
  }

  if (result.registered > 0 || result.updated > 0 || result.deleted > 0 || result.syncs_triggered > 0) {
    console.log(
      `[asset-scanner] 扫描完成: +${result.registered} 新增, ~${result.updated} 更新, -${result.deleted} 消失, ${result.subscriptions_created} 订阅, ${result.syncs_triggered} 同步`,
    );
  }

  return result;
}

/**
 * 在指定目录下查找匹配简单 glob 模式的文件。
 * 支持的通配符：* 匹配单层任意字符。
 * 跳过 node_modules、.git 等目录。
 */
function findFiles(baseDir: string, pattern: string): string[] {
  const results: string[] = [];
  const segments = pattern.split('/');

  function walk(dir: string, segIdx: number): void {
    if (segIdx >= segments.length) return;

    const seg = segments[segIdx]!;
    const isLast = segIdx === segments.length - 1;

    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }

    if (seg === '*') {
      // 匹配当前目录下所有条目
      for (const entry of entries) {
        if (SKIP_DIRS.has(entry.name)) continue;
        const full = path.join(dir, entry.name);
        if (isLast && entry.isFile()) {
          results.push(full);
        } else if (!isLast && entry.isDirectory()) {
          walk(full, segIdx + 1);
        }
      }
    } else if (seg.includes('*')) {
      // 通配符匹配（如 *.mdc、vitest.config.*）
      const re = new RegExp('^' + seg.replace(/\./g, '\\.').replace(/\*/g, '.*') + '$');
      for (const entry of entries) {
        if (SKIP_DIRS.has(entry.name)) continue;
        if (!re.test(entry.name)) continue;
        const full = path.join(dir, entry.name);
        if (isLast && entry.isFile()) {
          results.push(full);
        } else if (!isLast && entry.isDirectory()) {
          walk(full, segIdx + 1);
        }
      }
    } else {
      // 精确匹配目录/文件名
      const full = path.join(dir, seg);
      try {
        const stat = fs.statSync(full);
        if (isLast && stat.isFile()) {
          results.push(full);
        } else if (!isLast && stat.isDirectory()) {
          walk(full, segIdx + 1);
        }
      } catch {
        // 不存在就跳过
      }
    }
  }

  walk(baseDir, 0);
  return results;
}
