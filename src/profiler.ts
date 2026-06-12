/**
 * profiler.ts — 资源画像学习模块
 *
 * 通过观察系统中运行的进程，逐步积累各类任务的资源画像。
 * 画像数据包括：平均/峰值 CPU、内存、GPU 占用，以及平均运行时长。
 *
 * 学习过程：
 * 1. 初期（sample_count < 3）：confidence = low，调度器不依赖画像数据
 * 2. 中期（3-9 次）：confidence = medium，调度器参考但留余量
 * 3. 成熟（>= 10 次）：confidence = high，调度器完全信任画像
 *
 * 采集方式：
 * - 主动采集：通过 ps 命令查询指定 PID 的资源占用
 * - 被动汇总：任务完成时根据运行日志计算平均值
 * - Agent 上报：Agent 可以通过 inbox 上报自己的资源数据
 */

import os from 'node:os';
import { execSync } from 'node:child_process';
import { SOTAgentDB, type IHeavyTaskRow, type IResourceProfileRow } from './db.js';
import type { IResourceSnapshot, IPressureState } from './types.js';

export class ResourceProfiler {
  private db: SOTAgentDB;
  private _lastGpuMb: number | undefined;

  constructor(db: SOTAgentDB) {
    this.db = db;
  }

  /**
   * 采样指定 PID 的资源占用
   * macOS 的 ps 命令可以获取 %CPU 和 RSS（常驻内存）
   */
  sampleProcess(pid: number): IProcessSample | null {
    try {
      const output = execSync(
        `ps -p ${pid} -o %cpu=,rss=,vsz= 2>/dev/null`,
        { encoding: 'utf-8', timeout: 3000 },
      ).trim();

      if (!output) return null;

      const parts = output.split(/\s+/);
      if (parts.length < 2) return null;

      const cpuPercent = parseFloat(parts[0]!) || 0;
      const memMb = Math.round((parseInt(parts[1]!, 10) || 0) / 1024);

      return { pid, cpu_percent: cpuPercent, mem_mb: memMb };
    } catch {
      return null;
    }
  }

  /**
   * 采样一组进程（用于 Cursor CLI Agent 等多进程任务）
   * 通过 pgrep 查找匹配的进程树
   */
  sampleProcessTree(pid: number): IProcessSample | null {
    try {
      // 获取进程及其所有子进程
      const output = execSync(
        `pgrep -P ${pid} 2>/dev/null || echo ""`,
        { encoding: 'utf-8', timeout: 3000 },
      ).trim();

      const pids = [pid];
      if (output) {
        pids.push(...output.split('\n').map(p => parseInt(p.trim(), 10)).filter(p => !isNaN(p)));
      }

      let totalCpu = 0;
      let totalMem = 0;

      for (const p of pids) {
        const sample = this.sampleProcess(p);
        if (sample) {
          totalCpu += sample.cpu_percent;
          totalMem += sample.mem_mb;
        }
      }

      return { pid, cpu_percent: totalCpu, mem_mb: totalMem };
    } catch {
      return this.sampleProcess(pid);
    }
  }

  /**
   * 对所有运行中的重任务进行一次采样，更新画像
   */
  sampleRunningTasks(): ISamplingReport {
    const running = this.db.listTasks('running');
    const report: ISamplingReport = { sampled: [], failed: [] };

    for (const task of running) {
      if (!task.pid) continue;

      const sample = this.sampleProcessTree(task.pid);
      if (sample) {
        this.db.upsertProfile({
          task_type: task.task_type,
          cpu_percent: sample.cpu_percent,
          mem_mb: sample.mem_mb,
        });

        report.sampled.push({
          task_id: task.id,
          task_type: task.task_type,
          pid: task.pid,
          cpu_percent: sample.cpu_percent,
          mem_mb: sample.mem_mb,
        });
      } else {
        report.failed.push({ task_id: task.id, pid: task.pid });
      }
    }

    return report;
  }

  /**
   * 任务完成时的最终画像更新
   * 计入运行时长等最终数据
   */
  finalizeTaskProfile(task: IHeavyTaskRow): void {
    if (!task.actual_start || !task.actual_end) return;

    const start = new Date(task.actual_start).getTime();
    const end = new Date(task.actual_end).getTime();
    const durationSec = Math.round((end - start) / 1000);

    // 获取最后一次采样值作为代表（如果有的话）
    const existing = this.db.getProfile(task.task_type);
    if (existing) {
      this.db.upsertProfile({
        task_type: task.task_type,
        cpu_percent: existing.avg_cpu_percent,
        mem_mb: existing.avg_mem_mb,
        duration_sec: durationSec,
      });
    }
  }

  /**
   * 扫描系统中已知的进程类型，被动学习资源画像
   * 用于尚未通过 inbox 注册的进程（如手动启动的 cursor agent）
   */
  scanKnownProcessTypes(): IScanResult {
    const knownPatterns: Array<{ type: string; pattern: string }> = [
      { type: 'cursor-cli-agent', pattern: 'cursor.*agent' },
      { type: 'node-process', pattern: 'node' },
      { type: 'python-process', pattern: 'python3?' },
      { type: 'whisper', pattern: 'whisper' },
      { type: 'llama-server', pattern: 'llama-server\\|llama\\.cpp' },
    ];

    const result: IScanResult = { found: [] };

    for (const { type, pattern } of knownPatterns) {
      try {
        const output = execSync(
          `pgrep -f "${pattern}" 2>/dev/null || echo ""`,
          { encoding: 'utf-8', timeout: 3000 },
        ).trim();

        if (!output) continue;

        const pids = output.split('\n').map(p => parseInt(p.trim(), 10)).filter(p => !isNaN(p));

        let totalCpu = 0;
        let totalMem = 0;
        let count = 0;

        for (const pid of pids) {
          // 排除自己
          if (pid === process.pid) continue;
          const sample = this.sampleProcess(pid);
          if (sample) {
            totalCpu += sample.cpu_percent;
            totalMem += sample.mem_mb;
            count++;
          }
        }

        if (count > 0) {
          // 记录单个实例的平均值
          this.db.upsertProfile({
            task_type: type,
            cpu_percent: totalCpu / count,
            mem_mb: totalMem / count,
          });

          result.found.push({
            type,
            instance_count: count,
            total_cpu: Math.round(totalCpu * 10) / 10,
            total_mem: Math.round(totalMem),
          });
        }
      } catch {
        // 忽略单个模式的错误
      }
    }

    return result;
  }

  /**
   * 采样整机资源状态（CPU + 内存 + GPU）
   *
   * macOS 下：
   * - CPU: `top -l 1` 获取真实 user+sys 使用率（与活动监视器一致），
   *        失败时回退到 loadavg 估算
   * - 内存: `vm_stat` 解析 active+wired 页面（与活动监视器一致），
   *         失败时回退到 os.totalmem()-os.freemem()
   * - GPU: `ioreg` 查 Apple Silicon GPU 显存
   */
  sampleSystem(deviceId: string): IResourceSnapshot {
    const totalMem = os.totalmem();
    const totalMemMb = Math.round(totalMem / (1024 * 1024));

    // ── 内存：vm_stat 精确采样（与活动监视器一致） ──
    let usedMemMb: number;
    let memPercent: number;
    try {
      const vmOutput = execSync('vm_stat 2>/dev/null', { encoding: 'utf-8', timeout: 3000 }).trim();
      const pageSize = parseInt(vmOutput.match(/page size of (\d+)/)?.[1] ?? '16384', 10);
      const parse = (label: string): number => {
        const m = vmOutput.match(new RegExp(`${label}:\\s+(\\d+)`));
        return m?.[1] ? parseInt(m[1], 10) : 0;
      };
      const activePages = parse('Pages active');
      const wiredPages = parse('Pages wired down');
      const compressedPages = parse('Pages occupied by compressor');
      // 与活动监视器一致：已使用 = active + wired + compressed
      const usedBytes = (activePages + wiredPages + compressedPages) * pageSize;
      usedMemMb = Math.round(usedBytes / (1024 * 1024));
      memPercent = (usedBytes / totalMem) * 100;
    } catch {
      const freeMem = os.freemem();
      usedMemMb = Math.round((totalMem - freeMem) / (1024 * 1024));
      memPercent = ((totalMem - freeMem) / totalMem) * 100;
    }

    // ── CPU：top 精确采样（与活动监视器一致） ──
    let cpuPercent: number;
    try {
      const topOutput = execSync(
        'top -l 1 -n 0 -s 0 2>/dev/null | grep "CPU usage"',
        { encoding: 'utf-8', timeout: 8000 },
      ).trim();
      const idleMatch = topOutput.match(/([\d.]+)%\s*idle/);
      if (idleMatch?.[1]) {
        cpuPercent = Math.round((100 - parseFloat(idleMatch[1])) * 10) / 10;
      } else {
        throw new Error('idle not found');
      }
    } catch {
      const cpuCount = os.cpus().length;
      const load1m = os.loadavg()[0] ?? 0;
      cpuPercent = Math.min(100, Math.round((load1m / cpuCount) * 1000) / 10);
    }

    // ── GPU 显存 ──
    let gpuMemUsed: number | undefined;
    try {
      const output = execSync(
        'ioreg -r -d 1 -c IOAccelerator 2>/dev/null | grep "In use system memory" || echo ""',
        { encoding: 'utf-8', timeout: 8000 },
      ).trim();
      if (output) {
        const match = output.match(/"In use system memory"=(\d+)/);
        if (match?.[1]) {
          gpuMemUsed = Math.round(parseInt(match[1], 10) / (1024 * 1024));
          this._lastGpuMb = gpuMemUsed;
        }
      }
    } catch {
      gpuMemUsed = this._lastGpuMb;
    }

    // ── 资源压力指标（macOS 特有）──
    const pressure = this.samplePressureRaw();

    return {
      timestamp: new Date().toISOString(),
      device_id: deviceId,
      cpu_percent: cpuPercent,
      mem_used_mb: usedMemMb,
      mem_total_mb: totalMemMb,
      mem_percent: Math.round(memPercent * 10) / 10,
      gpu_mem_used_mb: gpuMemUsed,
      mem_pressure_level: pressure.mem_pressure_level,
      mem_availability: pressure.mem_availability,
      cpu_load_ratio: pressure.cpu_load_ratio,
    };
  }

  /**
   * macOS 资源压力原始采样
   *
   * - kern.memorystatus_vm_pressure_level: 1=NORMAL, 2=WARN, 4=CRITICAL
   *   XNU 内核内部 5 级映射到用户空间 3 级，稳定自 macOS 10.9+
   * - kern.memorystatus_level: 0-100 可用内存百分比
   * - CPU 压力: loadavg / 核心数，>1.0 表示有进程在排队等 CPU
   */
  private samplePressureRaw(): {
    mem_pressure_level?: 1 | 2 | 4;
    mem_availability?: number;
    cpu_load_ratio: number;
  } {
    let mem_pressure_level: 1 | 2 | 4 | undefined;
    let mem_availability: number | undefined;

    try {
      const output = execSync(
        '/usr/sbin/sysctl -n kern.memorystatus_vm_pressure_level kern.memorystatus_level 2>/dev/null',
        { encoding: 'utf-8', timeout: 3000 },
      ).trim();
      const lines = output.split('\n');
      if (lines[0]) {
        const raw = parseInt(lines[0], 10);
        if (raw === 1 || raw === 2 || raw === 4) mem_pressure_level = raw;
      }
      if (lines[1]) {
        mem_availability = parseInt(lines[1], 10);
      }
    } catch { /* sysctl unavailable */ }

    const cpuCount = os.cpus().length;
    const load1m = os.loadavg()[0] ?? 0;
    const cpu_load_ratio = Math.round((load1m / cpuCount) * 100) / 100;

    return { mem_pressure_level, mem_availability, cpu_load_ratio };
  }

  /**
   * 高级压力状态判定 — 供 scheduler 直接使用
   *
   * idle: 系统完全空闲，适合启动重任务
   * under_pressure: 系统资源紧张，应暂停非必要任务
   */
  samplePressure(deviceId: string): IPressureState {
    const raw = this.samplePressureRaw();

    const mem_pressure: IPressureState['mem_pressure'] =
      raw.mem_pressure_level === 4 ? 'critical' :
      raw.mem_pressure_level === 2 ? 'warn' : 'normal';

    const memAvail = raw.mem_availability ?? 100;

    const under_pressure =
      mem_pressure === 'critical' ||
      raw.cpu_load_ratio > 2.0 ||
      (mem_pressure === 'warn' && raw.cpu_load_ratio > 1.0);

    const idle =
      mem_pressure === 'normal' &&
      memAvail > 50 &&
      raw.cpu_load_ratio < 0.5;

    return {
      mem_pressure,
      mem_availability: memAvail,
      cpu_load_ratio: raw.cpu_load_ratio,
      under_pressure,
      idle,
    };
  }

  /**
   * 采样整机并写入数据库（供定时器直接调用的便捷方法）
   */
  sampleAndRecord(deviceId: string): IResourceSnapshot {
    const snapshot = this.sampleSystem(deviceId);
    this.db.recordSnapshot(snapshot);
    return snapshot;
  }

  /**
   * 趋势感知空闲窗口检测 — 不仅看当前均值，还看资源变化趋势
   *
   * 与简单平均值判断的区别：
   * - CPU 正在上升（趋势为 rising）时，即使当前 < 40% 也不算空闲
   * - 内存正在上升且预测将超过 70% 时，也不算空闲
   * - 趋势数据不足（< 3 条快照）时回退到传统均值判断
   */
  detectIdleWindow(deviceId: string, windowSize = 5): IIdleWindowResult {
    const snapshots = this.db.recentSnapshots(deviceId, windowSize);
    if (snapshots.length < 2) {
      return { idle: false, reason: 'not_enough_data', snapshots: snapshots.length };
    }

    const avgCpu = snapshots.reduce((s, r) => s + r.cpu_percent, 0) / snapshots.length;
    const avgMem = snapshots.reduce((s, r) => s + r.mem_percent, 0) / snapshots.length;
    const maxCpu = Math.max(...snapshots.map(r => r.cpu_percent));

    const oldest = new Date(snapshots[snapshots.length - 1]!.timestamp).getTime();
    const newest = new Date(snapshots[0]!.timestamp).getTime();
    const spanSec = Math.round((newest - oldest) / 1000);

    // 基础条件：CPU < 40% 且 内存 < 70% 且 最大 CPU 尖峰 < 60%
    const basicIdle = avgCpu < 40 && avgMem < 70 && maxCpu < 60;

    // 趋势感知：如果数据足够（>= 3 条），检查趋势方向
    let trendVeto = false;
    let trendReason: IIdleWindowResult['reason'] | null = null;

    if (snapshots.length >= 3) {
      const trend = this.analyzeTrend(deviceId, windowSize);

      // CPU 正在上升 → 否决空闲判定
      if (trend.cpu.direction === 'rising') {
        trendVeto = true;
        trendReason = 'cpu_rising';
      }
      // 内存正在上升且预测将超过 70% → 否决空闲判定
      if (trend.mem.direction === 'rising' && trend.mem.predicted > 70) {
        trendVeto = true;
        trendReason = trendReason ? 'cpu_rising' : 'mem_rising';
      }
    }

    const idle = basicIdle && !trendVeto;

    let reason: IIdleWindowResult['reason'];
    if (idle) {
      reason = 'system_idle';
    } else if (trendReason) {
      reason = trendReason;
    } else if (avgCpu >= 40) {
      reason = 'cpu_busy';
    } else if (avgMem >= 70) {
      reason = 'mem_pressure';
    } else {
      reason = 'cpu_spikes';
    }

    return {
      idle,
      avgCpu: Math.round(avgCpu * 10) / 10,
      avgMem: Math.round(avgMem * 10) / 10,
      maxCpu: Math.round(maxCpu * 10) / 10,
      spanSec,
      snapshots: snapshots.length,
      reason,
    };
  }

  // ─── 趋势分析 ─────────────────────────────────────────

  /**
   * 滑动窗口趋势分析 — 基于最近 N 条快照做线性回归和指数平滑预测
   *
   * 返回 CPU/内存的趋势方向（rising/falling/stable）以及未来 5 分钟的预测值。
   * scheduler 可据此做前瞻性调度决策（如 CPU 正在上升时不启动新任务）。
   *
   * @param deviceId 设备 ID
   * @param windowSize 滑动窗口大小（快照条数），默认 10
   */
  analyzeTrend(deviceId: string, windowSize = 10): ITrendAnalysis {
    const snapshots = this.db.recentSnapshots(deviceId, windowSize);
    if (snapshots.length < 3) {
      return {
        cpu: { direction: 'stable', current: 0, predicted: 0, confidence: 'low', slope: 0 },
        mem: { direction: 'stable', current: 0, predicted: 0, confidence: 'low', slope: 0 },
        data_points: snapshots.length,
        window_span_sec: 0,
      };
    }

    // 快照按 timestamp DESC 返回，翻转为时间正序
    const ordered = [...snapshots].reverse();

    // 用秒为单位的时间轴（以第一条快照为 t=0）
    const t0 = new Date(ordered[0]!.timestamp).getTime();
    const timeAxis = ordered.map(s => (new Date(s.timestamp).getTime() - t0) / 1000);
    const windowSpanSec = timeAxis[timeAxis.length - 1]! - timeAxis[0]!;

    // 预测目标：未来 5 分钟 (300 秒)
    const forecastHorizon = 300;
    const tForecast = timeAxis[timeAxis.length - 1]! + forecastHorizon;

    const cpuValues = ordered.map(s => s.cpu_percent);
    const memValues = ordered.map(s => s.mem_percent);

    const cpuTrend = this.computeTrend(timeAxis, cpuValues, tForecast);
    const memTrend = this.computeTrend(timeAxis, memValues, tForecast);

    // 置信度取决于数据量
    const confidence: ITrendMetric['confidence'] =
      snapshots.length >= 8 ? 'high' : snapshots.length >= 5 ? 'medium' : 'low';
    cpuTrend.confidence = confidence;
    memTrend.confidence = confidence;

    return {
      cpu: cpuTrend,
      mem: memTrend,
      data_points: snapshots.length,
      window_span_sec: Math.round(windowSpanSec),
    };
  }

  /**
   * 对单一指标执行线性回归 + 指数平滑，取两者加权平均作为预测
   *
   * 线性回归捕捉整体趋势；指数平滑对近期变化更敏感。
   * 最终预测 = 0.4 × 线性回归预测 + 0.6 × 指数平滑预测
   */
  private computeTrend(timeAxis: number[], values: number[], tForecast: number): ITrendMetric {
    const current = values[values.length - 1]!;

    // ── 线性回归（最小二乘法）──
    const n = timeAxis.length;
    let sumT = 0, sumV = 0, sumTV = 0, sumTT = 0;
    for (let i = 0; i < n; i++) {
      const t = timeAxis[i]!;
      const v = values[i]!;
      sumT += t;
      sumV += v;
      sumTV += t * v;
      sumTT += t * t;
    }
    const denom = n * sumTT - sumT * sumT;
    const slope = denom !== 0 ? (n * sumTV - sumT * sumV) / denom : 0;
    const intercept = denom !== 0 ? (sumV - slope * sumT) / n : current;
    const lrPredicted = intercept! + slope * tForecast;

    const alpha = 0.3;
    let smoothed = values[0]!;
    for (let i = 1; i < values.length; i++) {
      smoothed = alpha * values[i]! + (1 - alpha) * smoothed;
    }
    const esPredicted = smoothed! + slope * (tForecast - timeAxis[timeAxis.length - 1]!);

    // 加权平均
    const predicted = Math.max(0, Math.min(100, 0.4 * lrPredicted + 0.6 * esPredicted));

    // 趋势方向判定：slope 阈值 = 0.01%/秒（即 0.6%/分钟）
    const direction: ITrendMetric['direction'] =
      slope > 0.01 ? 'rising' : slope < -0.01 ? 'falling' : 'stable';

    return {
      direction,
      current: Math.round(current * 10) / 10,
      predicted: Math.round(predicted * 10) / 10,
      confidence: 'low', // 由调用方覆盖
      slope: Math.round(slope * 10000) / 10000,
    };
  }

  /** 获取画像摘要（用于显示） */
  getProfileSummary(): IProfileSummary[] {
    const profiles = this.db.listProfiles();
    return profiles.map(p => ({
      task_type: p.task_type,
      avg_cpu: `${Math.round(p.avg_cpu_percent)}%`,
      peak_cpu: `${Math.round(p.peak_cpu_percent)}%`,
      avg_mem: `${Math.round(p.avg_mem_mb)}MB`,
      peak_mem: `${Math.round(p.peak_mem_mb)}MB`,
      gpu_mem: p.gpu_mem_mb > 0 ? `${Math.round(p.gpu_mem_mb)}MB` : '-',
      samples: p.sample_count,
      confidence: p.confidence,
    }));
  }
}

// ─── 类型 ─────────────────────────────────────────────────

export interface IProcessSample {
  pid: number;
  cpu_percent: number;
  mem_mb: number;
}

export interface ISamplingReport {
  sampled: Array<{
    task_id: string;
    task_type: string;
    pid: number;
    cpu_percent: number;
    mem_mb: number;
  }>;
  failed: Array<{ task_id: string; pid: number }>;
}

export interface IScanResult {
  found: Array<{
    type: string;
    instance_count: number;
    total_cpu: number;
    total_mem: number;
  }>;
}

export interface IProfileSummary {
  task_type: string;
  avg_cpu: string;
  peak_cpu: string;
  avg_mem: string;
  peak_mem: string;
  gpu_mem: string;
  samples: number;
  confidence: string;
}

export interface IIdleWindowResult {
  idle: boolean;
  avgCpu?: number;
  avgMem?: number;
  maxCpu?: number;
  spanSec?: number;
  snapshots: number;
  reason: 'not_enough_data' | 'system_idle' | 'cpu_busy' | 'mem_pressure' | 'cpu_spikes' | 'cpu_rising' | 'mem_rising';
}

/** 单一指标的趋势分析结果 */
export interface ITrendMetric {
  /** 趋势方向 */
  direction: 'rising' | 'falling' | 'stable';
  /** 当前值 (%) */
  current: number;
  /** 未来 5 分钟预测值 (%) */
  predicted: number;
  /** 预测置信度 */
  confidence: 'low' | 'medium' | 'high';
  /** 线性回归斜率（%/秒），正值表示上升 */
  slope: number;
}

/** 趋势分析结果（CPU + 内存） */
export interface ITrendAnalysis {
  cpu: ITrendMetric;
  mem: ITrendMetric;
  /** 参与分析的数据点数 */
  data_points: number;
  /** 滑动窗口时间跨度（秒） */
  window_span_sec: number;
}
