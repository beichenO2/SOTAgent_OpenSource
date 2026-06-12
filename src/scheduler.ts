/**
 * scheduler.ts — 资源调度器
 *
 * 核心职责：
 * 1. 管理重任务队列（Whisper 转录、本地模型推理等）
 * 2. 检测系统空闲窗口，在空闲时启动/恢复低优先级任务
 * 3. 资源紧张时暂停任务
 * 4. 管理共享服务的分时复用（如本地 Gemma）
 * 5. 通知请求者任务状态和预计等待时间
 *
 * 设计原则：
 * - 重任务是"偷时间"运行的，优先级最低
 * - 永远不要抢占正在工作的 Agent 的资源
 * - 每次调度变更都通知等待者
 */

import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { nanoid } from 'nanoid';
import { SOTAgentDB, type IHeavyTaskRow, type IResourceProfileRow } from './db.js';
import type { IOutboxResponse, ISOTAgentConfig } from './types.js';
import { getPeerTailscaleIP } from './tailscale-client.js';
import type { ResourceProfiler } from './profiler.js';
import { SOTAGENT_API_PORT } from './ports.js';
import { validateCommand } from './command-guard.js';

const SOTAGENT_DIR = path.join(import.meta.dirname, '..');

// 跟踪当前管理的子进程
const managedProcesses = new Map<string, ChildProcess>();

/** 单个任务的资源预留记录 */
interface IResourceReservation {
  taskId: string;
  cpuPercent: number;
  memMb: number;
  gpuMemMb: number;
}

/** 被托管的外部进程 */
export interface IAdoptedProcess {
  pid: number;
  task_type: string;
  owner: string;
  adopted_at: string;
  state: 'running' | 'stopped' | 'dead';
}

/** 画像准入检查结果 */
export interface IAdmissionResult {
  admitted: boolean;
  reason?: string;
  estimated: {
    cpuPercent: number;
    memMb: number;
    gpuMemMb: number;
  };
  available: {
    cpuPercent: number;
    memMb: number;
    gpuMemMb: number;
  };
}

export class ResourceScheduler {
  private db: SOTAgentDB;
  private config: ISOTAgentConfig;
  private deviceId: string;
  private profiler: ResourceProfiler | null;

  /** 运行中任务的资源预留表 — 准入检查时将预留量计入已用资源 */
  private reservations = new Map<string, IResourceReservation>();

  /** 被托管的外部进程 — 压力高时 SIGSTOP，低时 SIGCONT */
  private adoptedProcesses = new Map<number, IAdoptedProcess>();

  /** 画像 confidence=low 时的安全余量系数（预估值 × 此系数） */
  private static readonly LOW_CONFIDENCE_FACTOR = 1.5;
  private static readonly MEDIUM_CONFIDENCE_FACTOR = 1.2;

  constructor(db: SOTAgentDB, config: ISOTAgentConfig, deviceId: string, profiler?: ResourceProfiler) {
    this.db = db;
    this.config = config;
    this.deviceId = deviceId;
    this.profiler = profiler ?? null;
  }

  /**
   * 检查系统是否空闲 — 优先使用 macOS 压力指标，回退到趋势分析
   *
   * 压力模式：kern.memorystatus_vm_pressure_level + loadavg/核心数
   * 回退模式：CPU% + 内存% 均值 + 趋势分析
   */
  isSystemIdle(): { idle: boolean; avgCpu: number; avgMem: number } {
    if (this.profiler) {
      const pressure = this.profiler.samplePressure(this.deviceId);
      if (pressure.mem_availability > 0) {
        return {
          idle: pressure.idle,
          avgCpu: Math.round(pressure.cpu_load_ratio * 100),
          avgMem: Math.round(100 - pressure.mem_availability),
        };
      }
      const result = this.profiler.detectIdleWindow(this.deviceId, 5);
      return {
        idle: result.idle,
        avgCpu: result.avgCpu ?? 100,
        avgMem: result.avgMem ?? 100,
      };
    }

    const snapshots = this.db.recentSnapshots(this.deviceId, 3);
    if (snapshots.length === 0) {
      return { idle: false, avgCpu: 100, avgMem: 100 };
    }

    const avgCpu = snapshots.reduce((s, r) => s + r.cpu_percent, 0) / snapshots.length;
    const avgMem = snapshots.reduce((s, r) => s + r.mem_percent, 0) / snapshots.length;

    const idle = avgCpu < this.config.resource_monitor.cpu_idle_threshold
      && avgMem < this.config.resource_monitor.mem_idle_threshold_percent;

    return { idle, avgCpu: Math.round(avgCpu * 10) / 10, avgMem: Math.round(avgMem * 10) / 10 };
  }

  /** 检查是否需要紧急暂停 — 优先用 macOS 内核压力级别 */
  isResourceCritical(): boolean {
    if (this.profiler) {
      const pressure = this.profiler.samplePressure(this.deviceId);
      if (pressure.mem_availability > 0) {
        return pressure.under_pressure;
      }
    }
    const snapshots = this.db.recentSnapshots(this.deviceId, 1);
    if (snapshots.length === 0) return false;
    const latest = snapshots[0]!;
    return latest.cpu_percent > this.config.scheduler.pause_on_cpu_above
      || latest.mem_percent > this.config.scheduler.pause_on_mem_above_percent;
  }

  // ─── 画像准入控制 ────────────────────────────────────────

  /**
   * 画像准入检查 — 启动任务前预估资源占用，判断是否允许启动
   *
   * 逻辑：
   * 1. 从画像获取 task_type 的预估资源占用
   * 2. 当前实际使用 + 已预留量 + 预估占用 > 阈值 → 拒绝
   * 3. confidence=low 时乘安全系数，high 时直接使用画像值
   * 4. GPU 显存也纳入检查（Apple Silicon 统一内存）
   */
  checkAdmission(task: IHeavyTaskRow): IAdmissionResult {
    const profile = this.db.getProfile(task.task_type);

    // 获取预估资源（无画像时使用保守默认值）
    const estimated = this.estimateTaskResources(profile);

    // 获取当前系统可用资源
    const available = this.getAvailableResources();

    // CPU 准入：预估 CPU + 当前已用 < 暂停阈值的 80%（留安全余量）
    const cpuLimit = this.config.scheduler.pause_on_cpu_above * 0.8;
    if (estimated.cpuPercent > available.cpuPercent) {
      return {
        admitted: false,
        reason: `CPU 不足: 预估 ${estimated.cpuPercent.toFixed(1)}% > 可用 ${available.cpuPercent.toFixed(1)}% (上限 ${cpuLimit.toFixed(0)}%)`,
        estimated,
        available,
      };
    }

    // 内存准入：预估内存 + 当前已用 < 暂停阈值的 80%
    if (estimated.memMb > available.memMb) {
      return {
        admitted: false,
        reason: `内存不足: 预估 ${estimated.memMb}MB > 可用 ${available.memMb}MB`,
        estimated,
        available,
      };
    }

    // GPU 显存准入（仅当任务需要 GPU 时检查）
    if (estimated.gpuMemMb > 0 && estimated.gpuMemMb > available.gpuMemMb) {
      return {
        admitted: false,
        reason: `GPU 显存不足: 预估 ${estimated.gpuMemMb}MB > 可用 ${available.gpuMemMb}MB`,
        estimated,
        available,
      };
    }

    return { admitted: true, estimated, available };
  }

  /**
   * 根据画像预估任务的资源需求，confidence 低时加安全系数
   */
  private estimateTaskResources(profile?: IResourceProfileRow): {
    cpuPercent: number;
    memMb: number;
    gpuMemMb: number;
  } {
    if (!profile) {
      // 无画像 → 保守估计：20% CPU, 512MB 内存, 0 GPU
      return { cpuPercent: 20, memMb: 512, gpuMemMb: 0 };
    }

    const factor = profile.confidence === 'low'
      ? ResourceScheduler.LOW_CONFIDENCE_FACTOR
      : profile.confidence === 'medium'
        ? ResourceScheduler.MEDIUM_CONFIDENCE_FACTOR
        : 1.0;

    // 使用峰值而非平均值来预估（更保守），再乘置信系数
    return {
      cpuPercent: Math.round(profile.peak_cpu_percent * factor * 10) / 10,
      memMb: Math.round(profile.peak_mem_mb * factor),
      gpuMemMb: Math.round(profile.gpu_mem_mb * factor),
    };
  }

  /**
   * 计算当前可用资源 = 系统容量 - 当前使用 - 已预留
   */
  private getAvailableResources(): {
    cpuPercent: number;
    memMb: number;
    gpuMemMb: number;
  } {
    const snapshots = this.db.recentSnapshots(this.deviceId, 1);
    const latest = snapshots[0];

    // 统计所有已预留资源
    let reservedCpu = 0;
    let reservedMem = 0;
    let reservedGpu = 0;
    for (const r of this.reservations.values()) {
      reservedCpu += r.cpuPercent;
      reservedMem += r.memMb;
      reservedGpu += r.gpuMemMb;
    }

    const cpuLimit = this.config.scheduler.pause_on_cpu_above * 0.8;
    const memLimitPercent = this.config.scheduler.pause_on_mem_above_percent * 0.8;

    if (!latest) {
      // 无快照数据 → 保守估计只有 10% 余量
      return {
        cpuPercent: Math.max(0, cpuLimit * 0.1 - reservedCpu),
        memMb: Math.max(0, 1024 - reservedMem),
        gpuMemMb: Math.max(0, 1024 - reservedGpu),
      };
    }

    const memLimitMb = latest.mem_total_mb * (memLimitPercent / 100);
    const currentGpuUsed = latest.gpu_mem_used_mb ?? 0;

    // Apple Silicon 最大 GPU 可用量：取总内存的 75%（统一内存架构下的经验值）
    const gpuCapacityMb = latest.mem_total_mb * 0.75;

    return {
      cpuPercent: Math.max(0, cpuLimit - latest.cpu_percent - reservedCpu),
      memMb: Math.max(0, memLimitMb - latest.mem_used_mb - reservedMem),
      gpuMemMb: Math.max(0, gpuCapacityMb - currentGpuUsed - reservedGpu),
    };
  }

  // ─── 资源预留 ──────────────────────────────────────────

  /** 为已启动的任务登记资源预留 */
  private reserveResources(taskId: string, profile?: IResourceProfileRow): void {
    const est = this.estimateTaskResources(profile);
    this.reservations.set(taskId, {
      taskId,
      cpuPercent: est.cpuPercent,
      memMb: est.memMb,
      gpuMemMb: est.gpuMemMb,
    });
  }

  /** 任务结束时释放资源预留 */
  private releaseResources(taskId: string): void {
    this.reservations.delete(taskId);
  }

  /** 获取当前预留摘要（调试用） */
  getReservationSummary(): { count: number; totalCpu: number; totalMem: number; totalGpu: number } {
    let totalCpu = 0;
    let totalMem = 0;
    let totalGpu = 0;
    for (const r of this.reservations.values()) {
      totalCpu += r.cpuPercent;
      totalMem += r.memMb;
      totalGpu += r.gpuMemMb;
    }
    return { count: this.reservations.size, totalCpu, totalMem, totalGpu };
  }

  // ─── 核心调度循环 ──────────────────────────────────────

  /**
   * 核心调度循环（由 sentinel 定时调用）
   *
   * 决策逻辑：
   * 1. 资源紧张 → 暂停所有运行中的重任务
   * 2. 系统空闲 + 有排队任务 + 准入通过 → 启动下一个任务
   * 3. 检查运行中任务的进程是否还活着
   * 4. 画像准入控制拦截资源不足的启动请求
   */
  async runScheduleCycle(): Promise<IScheduleReport> {
    const report: IScheduleReport = {
      timestamp: new Date().toISOString(),
      device_id: this.deviceId,
      actions: [],
    };

    // 1. 清理死进程（同时释放资源预留）
    this.cleanupDeadTasks(report);

    // 2. 检查资源状态
    const critical = this.isResourceCritical();
    if (critical) {
      this.pauseAllRunning(report);
      return report;
    }

    const { idle, avgCpu, avgMem } = this.isSystemIdle();
    report.system_status = { idle, avgCpu, avgMem };

    // 3. 空闲且有余量 → 尝试启动任务（或转发到计算设备）
    if (idle) {
      const running = this.db.runningTaskCount();
      const maxConcurrent = this.config.scheduler.max_concurrent_heavy_tasks;

      if (running < maxConcurrent) {
        const nextTask = this.db.nextQueuedTask();
        if (nextTask) {
          if (this.shouldForwardToCompute(nextTask)) {
            await this.forwardToComputeDevice(nextTask, report);
          } else {
            // 画像准入控制 — 资源不足时拒绝启动并通知请求者
            const admission = this.checkAdmission(nextTask);
            if (admission.admitted) {
              this.startTask(nextTask, report);
            } else {
              console.log(`[scheduler] 准入拒绝 ${nextTask.id} (${nextTask.task_type}): ${admission.reason}`);

              this.notifyRequester(nextTask.requester, {
                type: 'resource_update',
                payload: {
                  task_id: nextTask.id,
                  status: 'queued',
                  message: `资源不足，暂缓启动: ${admission.reason}`,
                  admission,
                },
              });

              report.actions.push({
                action: 'admission_denied',
                task_id: nextTask.id,
                task_type: nextTask.task_type,
                reason: admission.reason,
              });
            }
          }
        }
      }
    }

    // 4. 管理被托管的外部进程（压力驱动 SIGSTOP/SIGCONT）
    this.manageAdoptedProcesses();

    // 5. 更新所有排队任务的 ETA（使用画像驱动的时长估算）
    this.updateQueueEtas(report);

    return report;
  }

  /** 启动一个重任务，同时登记资源预留 */
  private startTask(task: IHeavyTaskRow, report: IScheduleReport): void {
    console.log(`[scheduler] 启动重任务: ${task.id} (${task.task_type})`);

    const cmdCheck = validateCommand(task.command);
    if (!cmdCheck.ok) {
      console.error(`[scheduler] ⛔ 拒绝执行任务 ${task.id}: ${cmdCheck.reason}`);
      this.db.updateTaskStatus(task.id, 'failed');
      report.actions.push({ task_id: task.id, action: 'rejected', reason: `command blocked: ${cmdCheck.reason}` });
      return;
    }

    try {
      const logDir = path.join(SOTAGENT_DIR, 'data', 'logs');
      if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });
      const logFile = path.join(logDir, `task-${task.id}.log`);

      const logStream = fs.createWriteStream(logFile, { flags: 'a' });
      const child = spawn('bash', ['-c', task.command], {
        detached: true,
        stdio: ['ignore', logStream, logStream],
        cwd: SOTAGENT_DIR,
      });

      child.unref();
      managedProcesses.set(task.id, child);

      this.db.updateTaskStatus(task.id, 'running', { pid: child.pid });

      // 登记资源预留 — 后续任务准入时会将预留量计入已用资源
      const profile = this.db.getProfile(task.task_type);
      this.reserveResources(task.id, profile);

      this.notifyRequester(task.requester, {
        type: 'resource_update',
        payload: {
          task_id: task.id,
          status: 'running',
          message: `任务已启动 (PID: ${child.pid})`,
        },
      });

      report.actions.push({
        action: 'started',
        task_id: task.id,
        task_type: task.task_type,
        pid: child.pid,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[scheduler] 启动任务失败: ${msg}`);
      this.db.updateTaskStatus(task.id, 'failed');

      this.notifyRequester(task.requester, {
        type: 'resource_update',
        payload: {
          task_id: task.id,
          status: 'failed',
          message: `启动失败: ${msg}`,
        },
      });

      report.actions.push({
        action: 'start_failed',
        task_id: task.id,
        error: msg,
      });
    }
  }

  /** 暂停所有运行中的重任务，释放对应的资源预留 */
  private pauseAllRunning(report: IScheduleReport): void {
    const running = this.db.listTasks('running');
    for (const task of running) {
      if (task.pid) {
        try {
          process.kill(task.pid, 'SIGSTOP');
          this.db.updateTaskStatus(task.id, 'paused');
          this.releaseResources(task.id);

          this.notifyRequester(task.requester, {
            type: 'resource_update',
            payload: {
              task_id: task.id,
              status: 'paused',
              message: '系统资源紧张，任务已暂停，空闲后自动恢复',
            },
          });

          report.actions.push({ action: 'paused', task_id: task.id, reason: 'resource_critical' });
          console.log(`[scheduler] 暂停任务 ${task.id} (PID: ${task.pid})`);
        } catch {
          this.db.updateTaskStatus(task.id, 'failed');
          this.releaseResources(task.id);
        }
      }
    }
  }

  /** 恢复暂停的任务，重新登记资源预留 */
  private resumePausedTask(task: IHeavyTaskRow, report: IScheduleReport): void {
    if (!task.pid) return;
    try {
      process.kill(task.pid, 'SIGCONT');
      this.db.updateTaskStatus(task.id, 'running');

      const profile = this.db.getProfile(task.task_type);
      this.reserveResources(task.id, profile);

      this.notifyRequester(task.requester, {
        type: 'resource_update',
        payload: {
          task_id: task.id,
          status: 'running',
          message: '系统空闲，任务已恢复运行',
        },
      });

      report.actions.push({ action: 'resumed', task_id: task.id });
      console.log(`[scheduler] 恢复任务 ${task.id} (PID: ${task.pid})`);
    } catch {
      this.db.updateTaskStatus(task.id, 'failed');
    }
  }

  /** 清理已死亡的进程，同时释放对应的资源预留 */
  private cleanupDeadTasks(report: IScheduleReport): void {
    const running = this.db.listTasks('running');
    for (const task of running) {
      if (!task.pid) continue;
      try {
        process.kill(task.pid, 0);
      } catch {
        const logFile = path.join(SOTAGENT_DIR, 'data', 'logs', `task-${task.id}.log`);
        const hasLog = fs.existsSync(logFile);
        const status: 'done' | 'failed' = hasLog && fs.statSync(logFile).size > 100 ? 'done' : 'failed';

        this.db.updateTaskStatus(task.id, status);
        managedProcesses.delete(task.id);
        this.releaseResources(task.id);

        this.notifyRequester(task.requester, {
          type: 'resource_update',
          payload: {
            task_id: task.id,
            status,
            message: status === 'done' ? '任务已完成' : '任务进程已终止（可能失败）',
          },
        });

        if (task.callback_url) {
          this.invokeCallback(task, status);
        }

        report.actions.push({ action: 'cleanup', task_id: task.id, status });
        console.log(`[scheduler] 清理死进程 ${task.id} (PID: ${task.pid}) → ${status}`);
      }
    }
  }

  /** Fire-and-forget callback to the task's callback_url */
  private invokeCallback(task: IHeavyTaskRow, status: 'done' | 'failed'): void {
    if (!task.callback_url) return;
    fetch(task.callback_url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        task_id: task.id,
        task_type: task.task_type,
        status,
        source_path: task.source_path,
        output_dir: task.output_dir,
      }),
      signal: AbortSignal.timeout(10000),
    }).catch(err => {
      console.error(`[scheduler] callback 调用失败 (${task.callback_url}): ${err}`);
    });
  }

  // ─── 计算任务转发 ────────────────────────────────────

  /** GPU / LLM / Whisper 等任务类型在 dev 设备上应转发到计算设备 */
  private static readonly COMPUTE_TASK_TYPES = new Set([
    'whisper', 'vlm', 'llm-local', 'gpu', 'training', 'embedding', 'tts',
  ]);

  /** 判断任务是否应该转发到计算设备 */
  private shouldForwardToCompute(task: IHeavyTaskRow): boolean {
    const localDevice = this.db.getDevice(this.deviceId);
    if (!localDevice || localDevice.role === 'compute' || localDevice.role === 'both') {
      return false;
    }
    // 按任务类型判断
    if (ResourceScheduler.COMPUTE_TASK_TYPES.has(task.task_type)) return true;
    // GPU 内存要求 > 0 也应该转发
    const profile = this.db.getProfile(task.task_type);
    if (profile && profile.gpu_mem_mb > 0) return true;
    return false;
  }

  /** 将任务转发到远程计算设备 */
  private async forwardToComputeDevice(task: IHeavyTaskRow, report: IScheduleReport): Promise<void> {
    const computeDevice = this.db.getComputeDevice(task.task_type);
    if (!computeDevice) {
      console.log(`[scheduler] 无可用计算设备，任务 ${task.id} 保留在本地队列`);
      return;
    }

    const ip = getPeerTailscaleIP(computeDevice.device_id);
    if (!ip) {
      console.log(`[scheduler] 无法获取 ${computeDevice.display_name} 的 Tailscale 地址，任务保留在本地`);
      return;
    }

    try {
      const resp = await fetch(
        `http://${ip}:${SOTAGENT_API_PORT}/api/tasks/forward`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            id: task.id,
            requester: task.requester,
            task_type: task.task_type,
            command: task.command,
            priority: task.priority,
            estimated_duration_sec: task.estimated_duration_sec,
            checkpoint_path: task.checkpoint_path,
          }),
          signal: AbortSignal.timeout(10000),
        },
      );

      if (resp.ok) {
        this.db.updateTaskStatus(task.id, 'running');
        this.notifyRequester(task.requester, {
          type: 'resource_update',
          payload: {
            task_id: task.id,
            status: 'forwarded',
            message: `任务已转发到 ${computeDevice.display_name}`,
            device: computeDevice.device_id,
          },
        });
        report.actions.push({
          action: 'forwarded',
          task_id: task.id,
          task_type: task.task_type,
        });
        console.log(`[scheduler] 任务 ${task.id} 已转发到 ${computeDevice.display_name}`);
      } else {
        console.log(`[scheduler] 转发到 ${computeDevice.display_name} 失败 (HTTP ${resp.status})，保留在本地`);
      }
    } catch (err) {
      console.log(`[scheduler] 转发失败: ${err}，保留在本地队列`);
    }
  }

  /**
   * 更新排队任务的 ETA — 优先使用画像学到的 avg_duration_sec，
   * 画像 confidence=low 时回退到请求方提供的静态值
   */
  private updateQueueEtas(report: IScheduleReport): void {
    const queued = this.db.listTasks('queued');
    const running = this.db.listTasks('running');

    if (queued.length === 0) return;

    let cumulativeWait = 0;

    // 运行中任务的剩余时间（同样优先用画像 ETA）
    for (const r of running) {
      const profileDuration = this.getProfileDuration(r.task_type);
      const estimatedSec = profileDuration ?? r.estimated_duration_sec ?? 3600;

      if (r.actual_start) {
        const elapsed = (Date.now() - new Date(r.actual_start).getTime()) / 1000;
        const remaining = Math.max(0, estimatedSec - elapsed);
        cumulativeWait += remaining;
      }
    }

    for (const task of queued) {
      const eta = new Date(Date.now() + cumulativeWait * 1000).toISOString();
      this.db.updateTaskStatus(task.id, 'queued', { notified_eta: eta });

      const profileDuration = this.getProfileDuration(task.task_type);
      cumulativeWait += profileDuration ?? task.estimated_duration_sec ?? 3600;
    }
  }

  /**
   * 从画像获取可信的 avg_duration_sec，confidence=low 时返回 null（回退到静态值）
   */
  private getProfileDuration(taskType: string): number | null {
    const profile = this.db.getProfile(taskType);
    if (!profile || profile.confidence === 'low' || profile.avg_duration_sec <= 0) return null;
    return profile.avg_duration_sec;
  }

  /** 通知请求者 */
  private notifyRequester(
    requester: string,
    notification: { type: string; payload: Record<string, unknown> },
  ): void {
    // 写入 outbox — 用 requester 中的项目信息
    // requester 格式通常是 "project-agent-id"
    const project = requester.split('-')[0] || requester;
    const outboxDir = path.join(SOTAGENT_DIR, 'outbox', project);
    if (!fs.existsSync(outboxDir)) fs.mkdirSync(outboxDir, { recursive: true });

    const response: IOutboxResponse = {
      id: `notify-${nanoid(10)}`,
      type: notification.type as IOutboxResponse['type'],
      to_project: project,
      to_agent: requester,
      timestamp: new Date().toISOString(),
      payload: notification.payload,
    };

    const filePath = path.join(outboxDir, `notify-${Date.now()}.json`);
    fs.writeFileSync(filePath, JSON.stringify(response, null, 2), 'utf-8');
  }

  // ─── 外部进程托管 ─────────────────────────────────────

  /**
   * 接管外部进程 — 其他项目通过 SDK 提交 PID，SOTAgent 根据压力 SIGSTOP/SIGCONT
   *
   * 调用方保持进程运行，SOTAgent 只负责在资源紧张时暂停、空闲时恢复。
   * 进程死亡后自动清理。
   */
  adoptProcess(pid: number, taskType: string, owner: string): { ok: boolean; message: string } {
    try {
      process.kill(pid, 0);
    } catch {
      return { ok: false, message: `PID ${pid} 不存在或无权限` };
    }

    if (this.adoptedProcesses.has(pid)) {
      return { ok: false, message: `PID ${pid} 已在托管中` };
    }

    this.adoptedProcesses.set(pid, {
      pid,
      task_type: taskType,
      owner,
      adopted_at: new Date().toISOString(),
      state: 'running',
    });

    console.log(`[scheduler] 托管进程 PID=${pid} type=${taskType} owner=${owner}`);
    return { ok: true, message: `PID ${pid} 已纳入资源调度托管` };
  }

  /** 释放托管 — 确保进程恢复运行后移除 */
  releaseProcess(pid: number): { ok: boolean; message: string } {
    const proc = this.adoptedProcesses.get(pid);
    if (!proc) {
      return { ok: false, message: `PID ${pid} 不在托管中` };
    }

    if (proc.state === 'stopped') {
      try {
        process.kill(pid, 'SIGCONT');
      } catch { /* process may be dead */ }
    }

    this.adoptedProcesses.delete(pid);
    console.log(`[scheduler] 释放托管 PID=${pid}`);
    return { ok: true, message: `PID ${pid} 已释放` };
  }

  /** 列出所有被托管的进程 */
  listAdoptedProcesses(): IAdoptedProcess[] {
    return Array.from(this.adoptedProcesses.values());
  }

  /**
   * 管理被托管进程 — 由调度循环定期调用
   *
   * 1. 清理已死亡的进程
   * 2. 压力高时 SIGSTOP running 进程
   * 3. 压力低时 SIGCONT stopped 进程
   */
  manageAdoptedProcesses(): void {
    if (this.adoptedProcesses.size === 0) return;

    const critical = this.isResourceCritical();
    const { idle } = this.isSystemIdle();

    for (const [pid, proc] of this.adoptedProcesses) {
      try {
        process.kill(pid, 0);
      } catch {
        console.log(`[scheduler] 托管进程 PID=${pid} 已死亡，移除`);
        this.adoptedProcesses.delete(pid);
        continue;
      }

      if (critical && proc.state === 'running') {
        try {
          process.kill(pid, 'SIGSTOP');
          proc.state = 'stopped';
          console.log(`[scheduler] 压力高，暂停托管进程 PID=${pid}`);
        } catch { /* ignore */ }
      } else if (idle && proc.state === 'stopped') {
        try {
          process.kill(pid, 'SIGCONT');
          proc.state = 'running';
          console.log(`[scheduler] 系统空闲，恢复托管进程 PID=${pid}`);
        } catch { /* ignore */ }
      }
    }
  }
}

// ─── 类型 ─────────────────────────────────────────────────

export interface IScheduleReport {
  timestamp: string;
  device_id: string;
  system_status?: { idle: boolean; avgCpu: number; avgMem: number };
  actions: Array<{
    action: string;
    task_id: string;
    task_type?: string;
    pid?: number;
    status?: string;
    reason?: string;
    error?: string;
  }>;
}
