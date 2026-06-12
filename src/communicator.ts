/**
 * communicator.ts — Agent 通信管理器
 *
 * 核心职责：
 * 1. 扫描 inbox/ 下所有设备子目录的 JSON 文件
 * 2. 解析和验证消息格式
 * 3. 根据消息类型分发到对应处理器（sync-engine / scheduler）
 * 4. 处理完成后将消息移到 processed/
 * 5. 管理 outbox 的回复和通知
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { nanoid } from 'nanoid';
import { SOTAgentDB } from './db.js';
import { SyncEngine } from './sync-engine.js';
import { ResourceScheduler } from './scheduler.js';
import { ResourceProfiler } from './profiler.js';
import { writeInboxFlag } from './inbox-flag.js';
import {
  inboxMessageSchema,
  type IInboxMessage,
  type ISyncRequestPayload,
  type IResourceRequestPayload,
  type IStatusQueryPayload,
  type ISyncResponsePayload,
  type IPortRequestPayload,
  type IPortReleasePayload,
  type IServiceForwardPayload,
  type ILessonRegisterPayload,
  type IOutboxResponse,
  type ISOTAgentConfig,
} from './types.js';

const SOTAGENT_DIR = path.join(import.meta.dirname, '..');

/**
 * 全局运行时数据目录 ~/.sotagent/
 * Agent 通过 inbox 发消息到这里，SOTAgent 从这里读取
 */
const GLOBAL_SOTAGENT_DIR = path.join(os.homedir(), '.sotagent');

export class Communicator {
  private db: SOTAgentDB;
  private syncEngine: SyncEngine;
  private scheduler: ResourceScheduler;
  private profiler: ResourceProfiler;
  private inboxDir: string;
  private outboxDir: string;
  private processedDir: string;

  private deviceId: string;

  constructor(params: {
    db: SOTAgentDB;
    config: ISOTAgentConfig;
    deviceId: string;
  }) {
    this.db = params.db;
    this.deviceId = params.deviceId;
    this.syncEngine = new SyncEngine(params.db);
    this.profiler = new ResourceProfiler(params.db);
    this.scheduler = new ResourceScheduler(params.db, params.config, params.deviceId, this.profiler);
    this.inboxDir = path.join(GLOBAL_SOTAGENT_DIR, 'inbox');
    this.outboxDir = path.join(GLOBAL_SOTAGENT_DIR, 'outbox');
    this.processedDir = path.join(GLOBAL_SOTAGENT_DIR, 'processed');
  }

  /**
   * 扫描并处理所有 inbox 消息
   * 返回处理报告
   */
  async processInbox(): Promise<IInboxReport> {
    const report: IInboxReport = {
      timestamp: new Date().toISOString(),
      processed: [],
      errors: [],
    };

    // 确保目录存在
    if (!fs.existsSync(this.inboxDir)) {
      fs.mkdirSync(this.inboxDir, { recursive: true });
      return report;
    }
    if (!fs.existsSync(this.processedDir)) {
      fs.mkdirSync(this.processedDir, { recursive: true });
    }

    // 扫描所有设备子目录
    const deviceDirs = fs.readdirSync(this.inboxDir, { withFileTypes: true })
      .filter(d => d.isDirectory());

    for (const deviceDir of deviceDirs) {
      const devicePath = path.join(this.inboxDir, deviceDir.name);
      const files = fs.readdirSync(devicePath)
        .filter(f => f.endsWith('.json'))
        .sort(); // 按时间戳排序

      for (const file of files) {
        const filePath = path.join(devicePath, file);
        try {
          const content = fs.readFileSync(filePath, 'utf-8');
          const raw = JSON.parse(content);
          const message = inboxMessageSchema.parse(raw);

          // 添加 ID（如果没有）
          if (!message.id) {
            message.id = `msg-${nanoid(10)}`;
          }

          const result = await this.dispatchMessage(message);
          report.processed.push({
            file: filePath,
            type: message.type,
            from: message.from,
            result,
          });

          // 移到 processed/
          this.archiveMessage(filePath, deviceDir.name, file);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          console.error(`[communicator] 处理消息失败 ${filePath}: ${msg}`);
          report.errors.push({ file: filePath, error: msg });

          // 错误的消息也移走，避免重复处理
          this.archiveMessage(filePath, deviceDir.name, file, true);
        }
      }
    }

    if (report.processed.length > 0 || report.errors.length > 0) {
      console.log(`[communicator] 处理完成: ${report.processed.length} 成功, ${report.errors.length} 失败`);
      writeInboxFlag('inbox_processed', {
        detail: `${report.processed.length} messages from ${[...new Set(report.processed.map(p => p.from))].join(', ')}`,
      });
    }

    return report;
  }

  /** 根据消息类型分发处理 */
  private async dispatchMessage(message: IInboxMessage): Promise<string> {
    switch (message.type) {
      case 'sync_request':
        return this.handleSyncRequest(message);
      case 'resource_request':
        return this.handleResourceRequest(message);
      case 'status_query':
        return this.handleStatusQuery(message);
      case 'sync_response':
        return this.handleSyncResponse(message);
      case 'port_request':
        return this.handlePortRequest(message);
      case 'port_release':
        return this.handlePortRelease(message);
      case 'lesson_register':
        return this.handleLessonRegister(message);
      case 'service_forward':
        return this.handleServiceForward(message);
      default:
        throw new Error(`未知消息类型: ${(message as IInboxMessage).type}`);
    }
  }

  /** 处理技术同步请求 */
  private async handleSyncRequest(message: IInboxMessage): Promise<string> {
    const payload = message.payload as ISyncRequestPayload;
    const result = await this.syncEngine.processSyncRequest(payload, message.project);
    return `同步完成: auto=${result.auto_synced.length}, suggest=${result.suggestions_sent.length}, skip=${result.skipped.length}, errors=${result.errors.length}`;
  }

  /** 处理资源申请 */
  private handleResourceRequest(message: IInboxMessage): string {
    const payload = message.payload as IResourceRequestPayload;

    // 解析预计时长
    let estimatedSec: number | undefined;
    if (payload.estimated_duration) {
      estimatedSec = parseDuration(payload.estimated_duration);
    }

    const taskId = this.db.createHeavyTask({
      requester: `${message.project}-${message.from}`,
      task_type: payload.task_type,
      command: payload.command,
      priority: payload.priority === 'high' ? 2 : payload.priority === 'normal' ? 1 : 0,
      estimated_duration_sec: estimatedSec,
      checkpoint_path: payload.checkpoint_path,
    });

    // 立即回复确认
    this.sendResponse(message.project, {
      id: `ack-${nanoid(10)}`,
      in_reply_to: message.id,
      type: 'resource_update',
      to_project: message.project,
      to_agent: message.from,
      timestamp: new Date().toISOString(),
      payload: {
        task_id: taskId,
        status: 'queued',
        message: '任务已加入队列，SOTAgent 会在系统空闲时自动执行',
        queue_position: this.db.listTasks('queued').length,
      },
    });

    return `任务已创建: ${taskId}`;
  }

  /** 处理状态查询 */
  private handleStatusQuery(message: IInboxMessage): string {
    const payload = message.payload as IStatusQueryPayload;
    let responsePayload: Record<string, unknown> = {};

    switch (payload.query_type) {
      case 'task_status': {
        if (payload.task_id) {
          const task = this.db.getTask(payload.task_id);
          responsePayload = { task: task ?? null };
        } else {
          const queued = this.db.listTasks('queued');
          const running = this.db.listTasks('running');
          responsePayload = {
            queued: queued.length,
            running: running.length,
            tasks: [...running, ...queued].slice(0, 10),
          };
        }
        break;
      }
      case 'resource_usage': {
        const snapshots = this.db.recentSnapshots(message.device, 1);
        const profiles = this.profiler.getProfileSummary();
        responsePayload = {
          latest_snapshot: snapshots[0] ?? null,
          profiles,
        };
        break;
      }
      case 'sync_status': {
        const history = this.db.getSyncHistory(undefined, 20);
        const assets = this.db.listAssets();
        responsePayload = {
          total_assets: assets.length,
          recent_syncs: history.slice(0, 10),
        };
        break;
      }
      case 'all': {
        const tasks = this.db.listTasks();
        const profiles = this.profiler.getProfileSummary();
        const history = this.db.getSyncHistory(undefined, 10);
        responsePayload = {
          tasks_summary: {
            queued: tasks.filter(t => t.status === 'queued').length,
            running: tasks.filter(t => t.status === 'running').length,
            done: tasks.filter(t => t.status === 'done').length,
          },
          profiles,
          recent_syncs: history,
        };
        break;
      }
    }

    this.sendResponse(message.project, {
      id: `status-${nanoid(10)}`,
      in_reply_to: message.id,
      type: 'status_report',
      to_project: message.project,
      to_agent: message.from,
      timestamp: new Date().toISOString(),
      payload: responsePayload,
    });

    return `状态查询已回复: ${payload.query_type}`;
  }

  /** 处理同步回复（Agent 自进化结果） */
  private handleSyncResponse(message: IInboxMessage): string {
    const payload = message.payload as ISyncResponsePayload;

    this.syncEngine.processSyncResponse({
      asset_id: payload.asset_id,
      from_project: message.project,
      action: payload.action,
      details: payload.details,
    });

    return `同步回复已处理: ${payload.asset_id} → ${payload.action}`;
  }

  /** 处理端口申请 */
  private handlePortRequest(message: IInboxMessage): string {
    const payload = message.payload as IPortRequestPayload;

    const port = this.db.allocatePort({
      service_name: payload.service_name,
      project: message.project,
      device_id: this.deviceId,
      preferred_port: payload.preferred_port,
      range_start: payload.port_range_start,
      range_end: payload.port_range_end,
    });

    this.sendResponse(message.project, {
      id: `port-${nanoid(10)}`,
      in_reply_to: message.id,
      type: 'port_assignment',
      to_project: message.project,
      to_agent: message.from,
      timestamp: new Date().toISOString(),
      payload: {
        allocated_port: port,
        service_name: payload.service_name,
        success: port !== null,
        message: port !== null
          ? `端口 ${port} 已分配给 ${payload.service_name}`
          : `无可用端口（范围 ${payload.port_range_start}-${payload.port_range_end}）`,
      },
    });

    return port !== null ? `端口 ${port} 已分配给 ${payload.service_name}` : '端口分配失败';
  }

  /** 处理端口释放 */
  private handlePortRelease(message: IInboxMessage): string {
    const payload = message.payload as IPortReleasePayload;
    this.db.releasePort(payload.port);

    this.sendResponse(message.project, {
      id: `portrel-${nanoid(10)}`,
      in_reply_to: message.id,
      type: 'port_released',
      to_project: message.project,
      to_agent: message.from,
      timestamp: new Date().toISOString(),
      payload: { port: payload.port, message: `端口 ${payload.port} 已释放` },
    });

    return `端口 ${payload.port} 已释放`;
  }

  /**
   * 处理经验备案 — 更新 ~/.sotagent/lessons-index.json
   *
   * Agent 创建/更新经验文件后发送此消息，SOTAgent 将其索引到全局索引中，
   * 供所有项目的 Agent 本地查询（零延迟，不依赖 SOTAgent 在线）。
   */
  private handleLessonRegister(message: IInboxMessage): string {
    const payload = message.payload as ILessonRegisterPayload;
    const indexPath = path.join(GLOBAL_SOTAGENT_DIR, 'lessons-index.json');

    let index: ILessonsIndex = { lessons: [], last_updated: '' };
    if (fs.existsSync(indexPath)) {
      try {
        index = JSON.parse(fs.readFileSync(indexPath, 'utf-8')) as ILessonsIndex;
      } catch {
        console.warn('[communicator] lessons-index.json 解析失败，将重建');
      }
    }

    const existingIdx = index.lessons.findIndex(
      (l) => l.file_path === payload.file_path,
    );

    const entry: ILessonEntry = {
      title: payload.title,
      project: message.project,
      file_path: payload.file_path,
      tags: payload.tags,
      applicable_when: payload.applicable_when,
    };

    if (existingIdx >= 0) {
      index.lessons[existingIdx] = entry;
    } else {
      index.lessons.push(entry);
    }

    index.last_updated = new Date().toISOString();
    fs.writeFileSync(indexPath, JSON.stringify(index, null, 2), 'utf-8');

    this.sendResponse(message.project, {
      id: `lesson-${nanoid(10)}`,
      in_reply_to: message.id,
      type: 'status_report',
      to_project: message.project,
      to_agent: message.from,
      timestamp: new Date().toISOString(),
      payload: {
        action: existingIdx >= 0 ? 'updated' : 'registered',
        title: payload.title,
        total_lessons: index.lessons.length,
      },
    });

    return existingIdx >= 0
      ? `经验已更新: ${payload.title}`
      : `经验已注册: ${payload.title} (总计 ${index.lessons.length} 条)`;
  }

  /** 处理 service_forward — 转发操作到 process-manager */
  private handleServiceForward(message: IInboxMessage): string {
    const payload = message.payload as IServiceForwardPayload;
    const { service_id, action } = payload;

    this.sendResponse(message.project, {
      id: `svc-fwd-${nanoid(10)}`,
      in_reply_to: message.id,
      correlation_id: message.correlation_id,
      type: 'status_report',
      from: 'sotagent',
      to_project: message.project,
      to_agent: message.from,
      timestamp: new Date().toISOString(),
      payload: {
        service_id,
        action,
        status: 'forwarded',
        detail: `service_forward for ${service_id}:${action} received and acknowledged`,
      },
    });

    return `Service forward: ${service_id} → ${action}`;
  }

  /** 发送回复到 outbox */
  private sendResponse(project: string, response: IOutboxResponse): void {
    const projectDir = path.join(this.outboxDir, project);
    if (!fs.existsSync(projectDir)) fs.mkdirSync(projectDir, { recursive: true });

    const fileName = `response-${Date.now()}-${nanoid(6)}.json`;
    fs.writeFileSync(
      path.join(projectDir, fileName),
      JSON.stringify(response, null, 2),
      'utf-8',
    );
  }

  /** 将处理过的消息移到 processed/ */
  private archiveMessage(filePath: string, deviceDir: string, fileName: string, isError = false): void {
    const archiveDir = path.join(this.processedDir, deviceDir);
    if (!fs.existsSync(archiveDir)) fs.mkdirSync(archiveDir, { recursive: true });

    const prefix = isError ? 'ERROR-' : '';
    const destPath = path.join(archiveDir, `${prefix}${fileName}`);

    try {
      fs.renameSync(filePath, destPath);
    } catch {
      // 跨文件系统 rename 可能失败，退化为 copy + delete
      try {
        fs.copyFileSync(filePath, destPath);
        fs.unlinkSync(filePath);
      } catch (e2) {
        console.error(`[communicator] 归档失败: ${e2}`);
      }
    }
  }
}

// ─── 工具函数 ─────────────────────────────────────────────

/** 解析时长字符串（如 "6h", "30m", "2d"）为秒 */
function parseDuration(duration: string): number {
  const match = duration.match(/^(\d+(?:\.\d+)?)\s*(s|sec|m|min|h|hr|hour|d|day)s?$/i);
  if (!match) return 3600; // 默认 1 小时

  const value = parseFloat(match[1]!);
  const unit = match[2]!.toLowerCase();

  switch (unit) {
    case 's': case 'sec': return Math.round(value);
    case 'm': case 'min': return Math.round(value * 60);
    case 'h': case 'hr': case 'hour': return Math.round(value * 3600);
    case 'd': case 'day': return Math.round(value * 86400);
    default: return Math.round(value * 3600);
  }
}

// ─── 类型 ─────────────────────────────────────────────────

export interface IInboxReport {
  timestamp: string;
  processed: Array<{
    file: string;
    type: string;
    from: string;
    result: string;
  }>;
  errors: Array<{
    file: string;
    error: string;
  }>;
}

interface ILessonEntry {
  title: string;
  project: string;
  file_path: string;
  tags: string[];
  applicable_when: string;
}

interface ILessonsIndex {
  lessons: ILessonEntry[];
  last_updated: string;
}
