/**
 * main.ts — SOTAgent 完整启动模式
 *
 * 在需要持续运行时使用（比如手动调试或特殊场景）。
 * 正常生产环境使用 sentinel.sh + cli.ts 的混合模式。
 *
 * 启动后会：
 * 1. 初始化数据库
 * 2. 写入设备描述文件
 * 3. 进入循环：处理 inbox → 调度 → 画像采样 → sleep
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { SOTAgentDB } from './db.js';
import { Communicator } from './communicator.js';
import { ResourceScheduler } from './scheduler.js';
import { ResourceProfiler } from './profiler.js';
import { startVaultSyncTimer, stopVaultSyncTimer } from './vault-sync-timer.js';
import type { ISOTAgentConfig, IDeviceProfile } from './types.js';

const SOTAGENT_DIR = path.join(import.meta.dirname, '..');
const CONFIG_PATH = path.join(SOTAGENT_DIR, 'config.json');

function loadConfig(): ISOTAgentConfig {
  return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8')) as ISOTAgentConfig;
}

/**
 * 获取稳定设备 ID
 * 优先级：环境变量 > config.json 中匹配的设备 > hostname
 *
 * hostname 可能受热点/tethering 影响返回不稳定值，
 * 所以当 hostname 不匹配 config 中任何设备时，自动回退到 config 中标记为本机角色的设备。
 */
function getDeviceId(config: ISOTAgentConfig): string {
  if (process.env['SOTAGENT_DEVICE_ID']) return process.env['SOTAGENT_DEVICE_ID'];

  const hostnameRaw = (os.hostname().split('.')[0] ?? os.hostname()).toLowerCase();
  const devices = config.devices ?? {};

  // hostname 能匹配到 config 中的某个设备
  if (devices[hostnameRaw]) return hostnameRaw;

  // hostname 不在 config 中（可能被热点/tethering 改掉了），
  // 尝试根据 hostname 关键词模糊匹配
  for (const [id] of Object.entries(devices)) {
    if (hostnameRaw.includes(id.replace('-', '')) || id.includes(hostnameRaw.replace('-', ''))) {
      return id;
    }
  }

  // 都匹配不上，返回 config 中第一个 dev/both 角色的设备
  for (const [id, d] of Object.entries(devices)) {
    if (d.role === 'dev' || d.role === 'both') return id;
  }

  return hostnameRaw;
}

/** 写入设备描述文件，让其他设备知道我们的硬件信息 */
function writeDeviceProfile(deviceId: string): void {
  const profileDir = path.join(SOTAGENT_DIR, 'profiles');
  if (!fs.existsSync(profileDir)) fs.mkdirSync(profileDir, { recursive: true });

  const profile: IDeviceProfile = {
    device_id: deviceId,
    hostname: os.hostname(),
    chip: os.cpus()[0]?.model || 'unknown',
    total_mem_gb: Math.round(os.totalmem() / 1073741824),
    os_version: `${os.platform()} ${os.release()}`,
    last_seen: new Date().toISOString(),
  };

  fs.writeFileSync(
    path.join(profileDir, `${deviceId}.json`),
    JSON.stringify(profile, null, 2),
    'utf-8',
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function main(): Promise<void> {
  const config = loadConfig();
  const deviceId = getDeviceId(config);
  const db = new SOTAgentDB();

  console.log(`[SOTAgent] 启动 — 设备: ${deviceId}, 内存: ${Math.round(os.totalmem() / 1073741824)}GB`);

  writeDeviceProfile(deviceId);

  const profiler = new ResourceProfiler(db);
  const communicator = new Communicator({ db, config, deviceId });
  const scheduler = new ResourceScheduler(db, config, deviceId, profiler);

  const intervalMs = config.sentinel.poll_interval_sec * 1000;
  let cycle = 0;

  // 启动 PolarPrivate vault 定时同步
  startVaultSyncTimer(config);

  // 优雅退出
  const shutdown = (): void => {
    console.log('\n[SOTAgent] 正在关闭...');
    stopVaultSyncTimer();
    db.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  console.log(`[SOTAgent] 进入主循环 (间隔 ${config.sentinel.poll_interval_sec}s)`);

  while (true) {
    cycle++;

    try {
      // 1. 处理 inbox
      const inboxReport = await communicator.processInbox();
      if (inboxReport.processed.length > 0) {
        console.log(`[cycle ${cycle}] 处理了 ${inboxReport.processed.length} 条消息`);
      }

      // 2. 调度检查（每 2 个周期）
      if (cycle % 2 === 0) {
        const scheduleReport = await scheduler.runScheduleCycle();
        if (scheduleReport.actions.length > 0) {
          console.log(`[cycle ${cycle}] 调度: ${scheduleReport.actions.map(a => a.action).join(', ')}`);
        }
      }

      // 3. 资源画像采样（每 5 个周期）
      if (cycle % 5 === 0) {
        profiler.sampleRunningTasks();
        profiler.scanKnownProcessTypes();
      }

      // 4. 更新设备描述（每 60 个周期 ≈ 30 分钟）
      if (cycle % 60 === 0) {
        writeDeviceProfile(deviceId);
      }
    } catch (err) {
      console.error(`[cycle ${cycle}] 错误:`, err);
    }

    await sleep(intervalMs);
  }
}

main().catch(err => {
  console.error('[SOTAgent] 致命错误:', err);
  process.exit(1);
});
