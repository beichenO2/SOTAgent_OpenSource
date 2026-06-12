/**
 * peer-sync.ts — 跨设备感知与同步协调
 *
 * 核心职责：
 * 1. 定时向对端 SOTAgent 发送心跳（本机所有项目的 git 状态）
 * 2. 接收对端心跳，缓存到内存
 * 3. 对比本地和对端状态，检测冲突
 * 4. 当检测到远端领先且本地无改动时，自动 pull + rebuild
 *
 * 通信通道：通过 Tailscale VPN 直连对方 SOTAgent 的 HTTP API
 * 对端 IP 来源：tailscale status --json CLI 查询
 */

import { exec } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { getPeerTailscaleIP } from './tailscale-client.js';
import { writeInboxFlag } from './inbox-flag.js';

const execAsync = promisify(exec);
import { scanAllRepos } from './git-watcher.js';
import { resolveConflict, getResolutionLog } from './conflict-resolver.js';
import { rsyncAllProjects } from './rsync-sync.js';
import type {
  ISOTAgentConfig,
  IPeerSyncConfig,
  IPeerHeartbeat,
  IPeerNotification,
  IProjectGitState,
  IConflictAlert,
} from './types.js';

import { SOTAGENT_API_PORT } from './ports.js';

export class PeerSync {
  private config: IPeerSyncConfig;
  private deviceId: string;
  private peerDeviceId: string;
  private peerSecret: string;
  private devices: Record<string, import('./types.js').IDeviceConfigEntry & { tailscale_ip: string }>;

  /** 对端最近一次心跳数据 */
  private peerState: IPeerHeartbeat | null = null;

  /** 当前活跃的冲突告警（项目名 → 告警详情） */
  private activeAlerts = new Map<string, IConflictAlert>();

  /** 通知日志（最近 100 条） */
  private notificationLog: IPeerNotification[] = [];
  private static readonly MAX_LOG = 100;

  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(params: {
    config: ISOTAgentConfig;
    deviceId: string;
  }) {
    this.config = params.config.peer_sync ?? {
      enabled: false,
      heartbeat_interval_sec: 30,
      auto_pull_on_clean: true,
      scan_root: '~/Polarisor',
      alert_on_conflict: true,
      auto_commit_and_push: true,
    };
    this.deviceId = params.deviceId;
    this.peerSecret = process.env[this.config.peer_secret_env ?? 'SOTAGENT_PEER_SECRET'] ?? '';
    this.devices = (params.config.devices ?? {}) as Record<string, import('./types.js').IDeviceConfigEntry & { tailscale_ip: string }>;

    // 确定对端设备 ID：config 中除了自己以外的那个
    const devices = Object.keys(params.config.devices ?? {});
    this.peerDeviceId = devices.find(d => d !== params.deviceId) ?? '';
  }

  /** Validate incoming peer request has correct secret */
  validatePeerSecret(headerValue: string | undefined): boolean {
    if (!this.peerSecret) return true; // no secret configured = open (backward compat)
    return headerValue === this.peerSecret;
  }

  /** 启动心跳循环 */
  start(): void {
    if (!this.config.enabled) {
      console.log('[peer-sync] 已禁用，跳过启动');
      return;
    }
    if (!this.peerDeviceId) {
      console.log('[peer-sync] 未找到对端设备，跳过启动');
      return;
    }

    const intervalMs = this.config.heartbeat_interval_sec * 1000;
    console.log(`[peer-sync] 启动心跳循环 (间隔 ${this.config.heartbeat_interval_sec}s, 对端: ${this.peerDeviceId})`);

    // 延迟 5s 后开始第一次心跳，给 Web API 启动时间
    setTimeout(() => this.sendHeartbeat(), 5000);
    this.timer = setInterval(() => this.sendHeartbeat(), intervalMs);
  }

  /** 停止心跳循环 */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
      console.log('[peer-sync] 心跳循环已停止');
    }
  }

  /** 确保心跳正在运行（Agent 挂号时调用） */
  ensureHeartbeatRunning(): void {
    if (this.timer) return;
    if (!this.config.enabled || !this.peerDeviceId) return;

    const intervalMs = (this.config.heartbeat_interval_sec || 60) * 1000;
    console.log(`[peer-sync] Agent 已活跃，恢复心跳 (间隔 ${this.config.heartbeat_interval_sec}s)`);
    setTimeout(() => this.sendHeartbeat(), 2000);
    this.timer = setInterval(() => this.sendHeartbeat(), intervalMs);
  }

  /** 暂停心跳（所有 Agent 销号后调用） */
  pauseHeartbeat(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
    console.log('[peer-sync] 所有 Agent 已销号，暂停心跳');
  }

  private syncingProjects = new Set<string>();

  private async autoSyncLocal(project: IProjectGitState): Promise<void> {
    if (!project.hasUncommitted && project.unpushedCount === 0) return;
    if (this.activeAlerts.has(project.project)) return;
    if (this.syncingProjects.has(project.project)) return;

    this.syncingProjects.add(project.project);
    try {
      console.log(`[peer-sync] 🚀 自动同步 (Commit/Push) [${project.project}]...`);
      
      if (project.hasUncommitted) {
        await execAsync('git add -A', { cwd: project.path, timeout: 10_000 });
        await execAsync(
          `git commit -m "auto: sync from ${this.deviceId} at ${new Date().toLocaleString()}"`,
          { cwd: project.path, timeout: 10_000 },
        );
      }

      await execAsync('git pull origin HEAD --rebase --quiet', { cwd: project.path, timeout: 30_000 });
      await execAsync('git push origin HEAD --quiet', { cwd: project.path, timeout: 30_000 });
      await this.notifyPeerPushCompleted(project.project);
      
      console.log(`[peer-sync] ✅ [${project.project}] 自动同步完成`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`[peer-sync] ❌ [${project.project}] 自动同步失败 (可能冲突): ${msg}`);
    } finally {
      this.syncingProjects.delete(project.project);
    }
  }

  /** 发送心跳到对端 */
  private async sendHeartbeat(): Promise<void> {
    try {
      const peerIp = getPeerTailscaleIP(this.peerDeviceId);
      if (!peerIp) {
        return;
      }

      const projects = await scanAllRepos(this.config.scan_root, this.config.global_ignore ?? [], this.config.project_whitelist ?? []);

      if (this.config.auto_commit_and_push !== false) {
        for (const p of projects) {
          if (p.hasUncommitted || p.unpushedCount > 0) {
            this.autoSyncLocal(p).catch(console.error);
          }
        }
      }

      const heartbeat: IPeerHeartbeat = {
        deviceId: this.deviceId,
        timestamp: new Date().toISOString(),
        projects,
      };

      const url = `http://${peerIp}:${SOTAGENT_API_PORT}/api/peer/heartbeat`;
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (this.peerSecret) headers['X-Peer-Secret'] = this.peerSecret;
      const resp = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(heartbeat),
        signal: AbortSignal.timeout(5000),
      });

      if (!resp.ok) {
        console.log(`[peer-sync] 心跳发送失败: HTTP ${resp.status}`);
      }
    } catch {
      // 对端不在线或网络不通，静默忽略
    }
  }

  /**
   * 接收并处理对端心跳
   * 由 web.ts 的 POST /api/peer/heartbeat 调用
   */
  async receiveHeartbeat(heartbeat: IPeerHeartbeat): Promise<{ alerts: IConflictAlert[] }> {
    this.peerState = heartbeat;

    // 扫描本地状态做对比
    const localProjects = await scanAllRepos(this.config.scan_root, this.config.global_ignore ?? [], this.config.project_whitelist ?? []);
    const localMap = new Map(localProjects.map(p => [p.project, p]));
    const newAlerts: IConflictAlert[] = [];

    for (const peerProject of heartbeat.projects) {
      const local = localMap.get(peerProject.project);
      if (!local) continue;

      const alert = this.detectConflict(local, peerProject);
      if (alert) {
        newAlerts.push(alert);
        this.activeAlerts.set(alert.project, alert);

        // L2: 文件无重叠时自动 commit+push+通知对端 pull
        if (alert.fileOverlap && !alert.fileOverlap.hasOverlap) {
          console.log(`[peer-sync] 📂 [${alert.project}] 文件无重叠 (本端 ${alert.fileOverlap.localOnlyFiles.length} 个, 对端 ${alert.fileOverlap.peerOnlyFiles.length} 个)`);
          const resolved = await this.autoResolveNoOverlap(alert);
          if (resolved) continue;
        }

        console.warn(`[peer-sync] ⚠️ 冲突检测 [${alert.project}]: ${alert.type}${alert.fileOverlap?.hasOverlap ? ` (${alert.fileOverlap.overlappingFiles.length} 文件重叠)` : ''}`);

        // 回退到已有的冲突解决器
        const resolution = await resolveConflict(alert);
        if (resolution.action === 'auto_resolved') {
          this.activeAlerts.delete(alert.project);
        }
      } else {
        this.activeAlerts.delete(peerProject.project);
      }

      // 自动 pull：远端领先且本地无改动
      if (this.config.auto_pull_on_clean && peerProject.unpushedCount > 0 && !local.hasUncommitted && local.remoteAhead > 0) {
        this.autoPull(local);
      }
    }

    return { alerts: newAlerts };
  }

  /**
   * 接收推送完成通知
   * 由 web.ts 的 POST /api/peer/notify 调用
   */
  async receiveNotification(notification: IPeerNotification): Promise<void> {
    this.notificationLog.push(notification);
    if (this.notificationLog.length > PeerSync.MAX_LOG) {
      this.notificationLog.shift();
    }

    console.log(`[peer-sync] 收到通知: ${notification.type} — ${notification.project} (来自 ${notification.deviceId})`);

    writeInboxFlag('peer_notification', {
      project: notification.project,
      detail: `${notification.type} from ${notification.deviceId}`,
    });

    if (notification.type === 'push_completed' && this.config.auto_pull_on_clean) {
      const localProjects = await scanAllRepos(this.config.scan_root, this.config.global_ignore ?? [], this.config.project_whitelist ?? []);
      const local = localProjects.find(p => p.project === notification.project);
      if (local && !local.hasUncommitted) {
        this.autoPull(local);
      }
    }
  }

  /** 检测两端同一项目是否存在冲突（含文件级分析） */
  private detectConflict(local: IProjectGitState, peer: IProjectGitState): IConflictAlert | null {
    if (local.hasUncommitted && peer.hasUncommitted) {
      const localFiles = new Set(local.uncommittedFiles ?? []);
      const peerFiles = new Set(peer.uncommittedFiles ?? []);
      const overlapping = [...localFiles].filter(f => peerFiles.has(f));
      const localOnly = [...localFiles].filter(f => !peerFiles.has(f));
      const peerOnly = [...peerFiles].filter(f => !localFiles.has(f));

      return {
        project: local.project,
        type: 'both_uncommitted',
        localState: local,
        peerState: peer,
        detectedAt: new Date().toISOString(),
        fileOverlap: {
          hasOverlap: overlapping.length > 0,
          overlappingFiles: overlapping,
          localOnlyFiles: localOnly,
          peerOnlyFiles: peerOnly,
        },
      };
    }

    if (local.remoteAhead > 0 && local.hasUncommitted) {
      return {
        project: local.project,
        type: 'local_behind_with_changes',
        localState: local,
        peerState: peer,
        detectedAt: new Date().toISOString(),
      };
    }

    // diverged + dirty: uncommitted changes on a diverged branch
    if (local.unpushedCount > 0 && local.remoteAhead > 0 && local.hasUncommitted) {
      return {
        project: local.project,
        type: 'diverged_with_changes',
        localState: local,
        peerState: peer,
        detectedAt: new Date().toISOString(),
      };
    }

    // diverged + clean: local has unpushed commits AND remote has commits we don't have
    if (local.unpushedCount > 0 && local.remoteAhead > 0) {
      return {
        project: local.project,
        type: 'diverged',
        localState: local,
        peerState: peer,
        detectedAt: new Date().toISOString(),
      };
    }

    return null;
  }

  /**
   * L2: 无冲突自动处理
   * 当两端都有 uncommitted 但修改文件无重叠时：
   * 本端 commit+push，然后通知对端 pull
   */
  private async autoResolveNoOverlap(alert: IConflictAlert): Promise<boolean> {
    if (alert.type !== 'both_uncommitted') return false;
    if (!alert.fileOverlap || alert.fileOverlap.hasOverlap) return false;
    if (alert.fileOverlap.localOnlyFiles.length === 0) return false;

    const projectPath = alert.localState.path;
    const projectName = alert.project;

    try {
      console.log(`[peer-sync] 🔀 ${projectName}: 文件无重叠，本端自动 commit+push...`);

      await execAsync('git add -A', { cwd: projectPath, timeout: 10_000 });
      await execAsync(
        `git commit -m "auto: sync uncommitted changes (no overlap with peer)"`,
        { cwd: projectPath, timeout: 10_000 },
      );
      await execAsync('git push origin HEAD --quiet', { cwd: projectPath, timeout: 30_000 });

      // 通知对端 pull
      await this.notifyPeerPushCompleted(projectName);

      console.log(`[peer-sync] ✅ ${projectName}: 自动同步完成，已通知对端 pull`);
      this.activeAlerts.delete(projectName);
      return true;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`[peer-sync] ❌ ${projectName}: 自动同步失败: ${msg}`);
      return false;
    }
  }

  /** 自动 pull + 检测是否需要 rebuild */
  private async autoPull(project: IProjectGitState): Promise<void> {
    try {
      console.log(`[peer-sync] 🔄 自动拉取 ${project.project}...`);

      const beforeHash = project.headHash;
      await execAsync('git pull --ff-only --quiet', {
        cwd: project.path,
        timeout: 30_000,
      });

      const { stdout: diffFiles } = await execAsync(
        `git diff ${beforeHash}..HEAD --name-only`,
        { cwd: project.path, timeout: 5000 },
      );

      await this.postPullRebuild(project.project, project.path, diffFiles);

      if (project.project === 'SOTAgent' && diffFiles.split('\n').some(f => f.startsWith('you/'))) {
        writeInboxFlag('you_changed', {
          changedFiles: diffFiles.split('\n').filter(f => f.startsWith('you/')),
        });
        console.log('[peer-sync] 📬 收到跨设备消息，已写入标记');
      }

      console.log(`[peer-sync] ✅ ${project.project} 已同步到最新`);

      // 触发 rsync：从对端拉取大文件（git 不追踪的文件）
      const rsyncCfg = this.config.rsync_large_files;
      const peerDevice = this.devices[this.peerDeviceId];
      if (rsyncCfg?.enabled && peerDevice) {
        rsyncAllProjects(
          this.config.scan_root,
          this.config.project_whitelist ?? [],
          peerDevice,
          rsyncCfg,
          'pull',
        ).catch(err => console.error('[peer-sync] rsync pull 失败:', err));
      }
    } catch (err) {
      console.error(`[peer-sync] 自动拉取失败 [${project.project}]:`, err);
    }
  }

  /**
   * pull 后检测依赖文件变更，自动重建（npm install / pip install）。
   * 编译产物和依赖不通过 git 同步，到本地重建即可。
   */
  private async postPullRebuild(projectName: string, projectPath: string, diffFiles: string): Promise<void> {
    try {
      if (diffFiles.includes('package.json') || diffFiles.includes('package-lock.json')) {
        console.log(`[peer-sync] 📦 ${projectName}: package.json 变更，npm install...`);
        await execAsync('npm install --silent', { cwd: projectPath, timeout: 120_000 });
      }
      if (diffFiles.includes('requirements.txt')) {
        console.log(`[peer-sync] 🐍 ${projectName}: requirements.txt 变更，pip install...`);
        const venvPython = `${projectPath}/venv/bin/python`;
        const pip = (await execAsync(`test -f "${venvPython}" && echo "${venvPython} -m pip" || echo "pip3"`, { cwd: projectPath }).then(r => r.stdout.trim()));
        await execAsync(`${pip} install -r requirements.txt --quiet`, { cwd: projectPath, timeout: 120_000 });
      }
      if (diffFiles.includes('pnpm-lock.yaml')) {
        console.log(`[peer-sync] 📦 ${projectName}: pnpm-lock.yaml 变更，pnpm install...`);
        await execAsync('pnpm install --silent', { cwd: projectPath, timeout: 120_000 }).catch(() => {
          console.log(`[peer-sync] pnpm 未安装，回退到 npm install`);
          return execAsync('npm install --silent', { cwd: projectPath, timeout: 120_000 });
        });
      }
    } catch (err) {
      console.error(`[peer-sync] ${projectName} 依赖重建失败（不影响同步）:`, err);
    }
  }

  /**
   * 通知对端发生端口冲突或熔断事件 — 关键服务异常时对端需要知道
   */
  async notifyPeerPortConflict(params: {
    serviceName: string;
    port: number;
    reason: string;
    occupantPid?: number;
    occupantCommand?: string;
  }): Promise<boolean> {
    const detail = [
      `服务: ${params.serviceName}`,
      `端口: ${params.port}`,
      `原因: ${params.reason}`,
      params.occupantPid ? `占用进程: pid=${params.occupantPid} cmd=${params.occupantCommand ?? 'unknown'}` : '',
    ].filter(Boolean).join(' | ');

    return this.sendNotification({
      type: 'port_conflict',
      deviceId: this.deviceId,
      project: 'SOTAgent',
      timestamp: new Date().toISOString(),
      detail,
    });
  }

  /**
   * 通知对端某个服务熔断器跳闸
   */
  async notifyPeerCircuitBreakerTripped(serviceName: string, reason: string): Promise<boolean> {
    return this.sendNotification({
      type: 'circuit_breaker_tripped',
      deviceId: this.deviceId,
      project: 'SOTAgent',
      timestamp: new Date().toISOString(),
      detail: `服务 ${serviceName} 熔断: ${reason}`,
    });
  }

  /** 通用通知发送 */
  private async sendNotification(notification: IPeerNotification): Promise<boolean> {
    try {
      const peerIp = await getPeerTailscaleIP(this.peerDeviceId);
      if (!peerIp) return false;

      const url = `http://${peerIp}:${SOTAGENT_API_PORT}/api/peer/notify`;
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (this.peerSecret) headers['X-Peer-Secret'] = this.peerSecret;
      const resp = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(notification),
        signal: AbortSignal.timeout(15000),
      });
      return resp.ok;
    } catch {
      return false;
    }
  }

  /**
   * 主动通知对端某个项目已 push — 让对端立即 auto-pull 而不用等下次心跳
   */
  async notifyPeerPushCompleted(project: string): Promise<boolean> {
    const result = await this.sendNotification({
      type: 'push_completed',
      deviceId: this.deviceId,
      project,
      timestamp: new Date().toISOString(),
    });

    // 触发 rsync：将本机大文件同步到对端（push 方向）
    const rsyncCfg = this.config.rsync_large_files;
    const peerDevice = this.devices[this.peerDeviceId];
    if (rsyncCfg?.enabled && peerDevice) {
      rsyncAllProjects(
        this.config.scan_root,
        this.config.project_whitelist ?? [],
        peerDevice,
        rsyncCfg,
        'push',
      ).catch(err => console.error('[peer-sync] rsync push 失败:', err));
    }

    return result;
  }

  // ─── 状态查询 API ──────────────────────────────────

  getPeerState(): IPeerHeartbeat | null {
    return this.peerState;
  }

  getActiveAlerts(): IConflictAlert[] {
    return Array.from(this.activeAlerts.values());
  }

  getNotificationLog(): IPeerNotification[] {
    return this.notificationLog;
  }

  isEnabled(): boolean {
    return this.config.enabled;
  }
}
