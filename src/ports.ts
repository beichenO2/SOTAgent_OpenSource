/**
 * ports.ts — 端口中心化管理
 *
 * 所有端口常量从 config.json 的 ports 段读取。
 * 修改端口只需改 config.json 一处，重启 SOTAgent 后全局生效。
 *
 * 启动时会写入 ~/.sotagent/ports.json，供其他项目和 shell 脚本读取。
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const SOTAGENT_DIR = path.join(import.meta.dirname, '..');
const CONFIG_PATH = path.join(SOTAGENT_DIR, 'config.json');

interface IPortsConfig {
  sotagent_api: number;
  sotagent_console: number;
  polar_private: number;
  [key: string]: number;
}

function loadPorts(): IPortsConfig {
  const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
  const ports = raw.ports as IPortsConfig | undefined;
  if (!ports || typeof ports.sotagent_api !== 'number') {
    throw new Error('config.json 缺少 ports 段或 ports.sotagent_api 未定义');
  }
  return ports;
}

const _ports = loadPorts();

export const SOTAGENT_API_PORT = _ports.sotagent_api;
export const SOTAGENT_CONSOLE_PORT = _ports.sotagent_console;
export const POLAR_PRIVATE_PORT = _ports.polar_private;
/** Polarisor registry — AutoOffice HTTP API (see REQUIREMENTS R2). */
export const AUTOOFFICE_PORT = typeof _ports.autooffice === 'number' ? _ports.autooffice : 3900;
/** InfoForge REST API — default 3901 to avoid clashing with AutoOffice :3900. */
export const INFOFORGE_API_PORT = typeof _ports.infoforge_api === 'number' ? _ports.infoforge_api : 3901;
export const INFOFORGE_SSE_PORT = typeof _ports.infoforge_sse === 'number' ? _ports.infoforge_sse : 3902;
export const ALL_PORTS = { ..._ports };

/**
 * 将端口配置写入 ~/.sotagent/ports.json，供 shell 脚本和其他项目读取。
 * SOTAgent 启动时调用一次。
 */
export function publishPortsFile(): void {
  const dir = path.join(os.homedir(), '.sotagent');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const gatewayConfig = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8')).gateway ?? {};
  const gwEnabled = gatewayConfig.enabled === true;
  const gwBase = gatewayConfig.base_path ?? '/gw';

  const payload = {
    ..._ports,
    _source: 'SOTAgent/config.json',
    _updated_at: new Date().toISOString(),
    _api_base: `http://127.0.0.1:${_ports.sotagent_api}`,
    _gateway: gwEnabled ? {
      enabled: true,
      base_url: `http://127.0.0.1:${_ports.sotagent_api}${gwBase}`,
      routes: (gatewayConfig.routes ?? []).map((r: any) => ({
        prefix: r.prefix,
        url: `http://127.0.0.1:${_ports.sotagent_api}${gwBase}/${r.prefix}`,
      })),
    } : { enabled: false },
    _governance: {
      rule: '所有端口必须以 0 或 5 结尾',
      allocate_api: `http://127.0.0.1:${_ports.sotagent_api}/api/ports/allocate`,
      release_api: `http://127.0.0.1:${_ports.sotagent_api}/api/ports/release`,
      list_api: `http://127.0.0.1:${_ports.sotagent_api}/api/ports`,
    },
  };

  fs.writeFileSync(
    path.join(dir, 'ports.json'),
    JSON.stringify(payload, null, 2),
    'utf-8',
  );
}
