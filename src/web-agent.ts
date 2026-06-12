/**
 * web-agent.ts — 并发 LLM 运维助手
 *
 * 核心变化：每个请求创建独立的 AgentSession 实例，互不干扰。
 *
 * 并发模型：
 * - 调度器请求 → 无条件新建 session → 独立 LLM 调用 → 返回结果 → session 自动回收
 * - Console UI 手动操作 → 也创建独立 session
 * - 每个 session 有自己的日志、pending actions、idle timer
 *
 * 保留向后兼容：startAgent/stopAgent/getAgentState 仍可用于全局 Agent 管理。
 */

import { execSync } from 'node:child_process';
import path from 'node:path';
import { nanoid } from 'nanoid';
import { askAgent, chatCompletion } from './llm.js';
import { scanAll, pullRepo, type IRepoStatus } from './web-scanner.js';
import type { SOTAgentDB } from './db.js';
import { validateCommand, shellEscape } from './command-guard.js';

const POLARISOR_ROOT = path.join(process.env.HOME || '~', 'Polarisor');
const IDLE_TIMEOUT_MS = 10 * 60 * 1000;
const MAX_SESSIONS = 10;

// ─── 类型 ─────────────────────────────────────────────────

export interface IAgentAction {
  action: string;
  repo?: string;
  reason?: string;
  github_name?: string;
  port?: number;
  service?: string;
  project?: string;
  command?: string;
  message?: string;
  task_type?: string;
  priority?: number;
}

export interface IAgentLog {
  timestamp: string;
  type: 'info' | 'action' | 'error' | 'llm';
  message: string;
}

export interface IAgentState {
  isRunning: boolean;
  startedAt: string | null;
  lastActiveAt: string | null;
  shutdownAt: string | null;
  logs: IAgentLog[];
  pendingActions: IAgentAction[];
}

export interface ISessionInfo {
  id: string;
  purpose: string;
  createdAt: string;
  lastActiveAt: string;
  logCount: number;
  isActive: boolean;
}

// ─── AgentSession — 独立实例 ──────────────────────────────

export class AgentSession {
  readonly id: string;
  readonly purpose: string;
  readonly createdAt: string;
  private logs: IAgentLog[] = [];
  private pendingActions: IAgentAction[] = [];
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private _active = true;
  lastActiveAt: string;

  constructor(purpose: string) {
    this.id = `ses-${nanoid(8)}`;
    this.purpose = purpose;
    this.createdAt = new Date().toISOString();
    this.lastActiveAt = this.createdAt;
    this.log('info', `Session 创建: ${purpose}`);
    this.resetIdleTimer();
  }

  private log(type: IAgentLog['type'], message: string) {
    this.logs.push({ timestamp: new Date().toISOString(), type, message });
    if (this.logs.length > 200) this.logs = this.logs.slice(-200);
    console.log(`[agent:${this.id}:${type}] ${message}`);
  }

  private resetIdleTimer() {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.lastActiveAt = new Date().toISOString();
    this.idleTimer = setTimeout(() => {
      this.log('info', `空闲超时，session 自动回收`);
      this.close();
    }, IDLE_TIMEOUT_MS);
  }

  get isActive(): boolean {
    return this._active;
  }

  getInfo(): ISessionInfo {
    return {
      id: this.id,
      purpose: this.purpose,
      createdAt: this.createdAt,
      lastActiveAt: this.lastActiveAt,
      logCount: this.logs.length,
      isActive: this._active,
    };
  }

  getLogs(): IAgentLog[] {
    return this.logs;
  }

  getPendingActions(): IAgentAction[] {
    return this.pendingActions;
  }

  close() {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
    this._active = false;
    this.log('info', 'Session 关闭');
    sessionPool.delete(this.id);
  }

  /** 扫描仓库 + LLM 分析 */
  async analyzeRepos(db: SOTAgentDB): Promise<IAgentAction[]> {
    this.resetIdleTimer();
    this.log('info', '开始扫描仓库状态...');
    const scan = await scanAll(db);

    const repoSummary = scan.repos.map((r: IRepoStatus) => {
      return `${r.name}: status=${r.syncStatus}, branch=${r.branch}, behind=${r.behind}, ahead=${r.ahead}, dirty=${r.dirty}, remote=${r.remote || 'NONE'}`;
    }).join('\n');

    const prompt = `当前 Polarisor 项目群的 Git 仓库状态如下：

${repoSummary}

请分析每个仓库的状态，给出操作建议：
1. 落后的且干净的仓库 → pull
2. 落后但有未提交文件的 → skip 并说明
3. 无远程仓库的 → create_remote（建议 GitHub 仓库名）
4. 已同步的 → 不需要操作
5. 最后给一条 report 总结

请严格按照 JSON 数组格式回复。`;

    this.log('llm', '正在请求 LLM 分析...');

    try {
      const response = await askAgent(prompt);
      this.log('llm', `LLM 响应: ${response.substring(0, 200)}...`);

      const jsonMatch = response.match(/\[[\s\S]*\]/);
      if (!jsonMatch) {
        this.log('error', 'LLM 响应未包含有效 JSON');
        return [{ action: 'report', message: `LLM 原始响应: ${response}` }];
      }

      const actions: IAgentAction[] = JSON.parse(jsonMatch[0]);
      this.pendingActions = actions;
      this.log('info', `分析完成，${actions.length} 个操作建议`);
      return actions;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.log('error', `LLM 分析失败: ${msg}`);
      return [{ action: 'report', message: `分析失败: ${msg}` }];
    }
  }

  /** 执行单个操作 */
  async executeAction(action: IAgentAction): Promise<string> {
    this.resetIdleTimer();
    return executeActionImpl(action, this);
  }

  /** 执行所有 pending 操作 */
  async executeAll(): Promise<{ action: IAgentAction; result: string }[]> {
    this.resetIdleTimer();
    const results: { action: IAgentAction; result: string }[] = [];
    for (const action of this.pendingActions) {
      const result = await this.executeAction(action);
      results.push({ action, result });
    }
    this.pendingActions = [];
    return results;
  }

  /** 自由对话 */
  async chat(message: string, db: SOTAgentDB): Promise<string> {
    this.resetIdleTimer();
    this.log('info', `用户消息: ${message}`);
    const scan = await scanAll(db);

    const context = `当前仓库状态概要：
- 总项目数: ${scan.repos.length}
- 已同步: ${scan.repos.filter((r: IRepoStatus) => r.syncStatus === 'synced').length}
- 落后: ${scan.repos.filter((r: IRepoStatus) => r.syncStatus === 'behind').length}
- 无远程: ${scan.repos.filter((r: IRepoStatus) => r.syncStatus === 'no_remote').length}

详细状态:
${scan.repos.map((r: IRepoStatus) => `  ${r.name}: ${r.syncStatus} (dirty:${r.dirty}, behind:${r.behind})`).join('\n')}

端口注册:
${scan.ports.map(p => `  :${p.port} → ${p.service} (${p.project})`).join('\n')}

用户请求: ${message}

请给出操作方案（JSON 数组格式），然后我会执行。`;

    try {
      const response = await askAgent(context);
      this.log('llm', `LLM 响应: ${response.substring(0, 300)}`);

      const jsonMatch = response.match(/\[[\s\S]*\]/);
      if (jsonMatch) {
        this.pendingActions = JSON.parse(jsonMatch[0]);
      }

      return response;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.log('error', `对话失败: ${msg}`);
      return `处理失败: ${msg}`;
    }
  }

  /**
   * 资源调度专用 — 分析系统状态并决定任务调度策略
   * 扩展的 system prompt 包含资源调度操作
   */
  async analyzeForScheduling(systemContext: string): Promise<IAgentAction[]> {
    this.resetIdleTimer();
    this.log('info', '开始资源调度分析...');

    const response = await chatCompletion([
      {
        role: 'system',
        content: SCHEDULER_SYSTEM_PROMPT,
      },
      { role: 'user', content: systemContext },
    ]);

    this.log('llm', `调度分析响应: ${response.substring(0, 200)}...`);

    const jsonMatch = response.match(/\[[\s\S]*\]/);
    if (!jsonMatch) {
      this.log('error', '调度分析响应未包含有效 JSON');
      return [];
    }

    try {
      const actions: IAgentAction[] = JSON.parse(jsonMatch[0]);
      this.pendingActions = actions;
      return actions;
    } catch {
      this.log('error', 'JSON 解析失败');
      return [];
    }
  }
}

// ─── Session 池 ───────────────────────────────────────────

const sessionPool = new Map<string, AgentSession>();

/** 创建新 session（每个请求独立） */
export function createSession(purpose: string): AgentSession {
  if (sessionPool.size >= MAX_SESSIONS) {
    const oldest = [...sessionPool.values()]
      .sort((a, b) => a.lastActiveAt.localeCompare(b.lastActiveAt))[0];
    if (oldest) {
      console.log(`[agent] session 数达上限 ${MAX_SESSIONS}，回收最老的 ${oldest.id}`);
      oldest.close();
    }
  }

  const session = new AgentSession(purpose);
  sessionPool.set(session.id, session);
  return session;
}

export function getSession(id: string): AgentSession | undefined {
  return sessionPool.get(id);
}

export function listSessions(): ISessionInfo[] {
  return [...sessionPool.values()].map(s => s.getInfo());
}

export function closeSession(id: string): boolean {
  const session = sessionPool.get(id);
  if (!session) return false;
  session.close();
  return true;
}

// ─── 向后兼容的全局 Agent API ──────────────────────────────
// Console UI 的启动/停止按钮仍然走这个入口

let globalSession: AgentSession | null = null;

export function startAgent(): IAgentState {
  if (globalSession?.isActive) return getAgentState();
  globalSession = createSession('global-console');
  return getAgentState();
}

export function stopAgent(): IAgentState {
  if (globalSession) {
    globalSession.close();
    globalSession = null;
  }
  return getAgentState();
}

export function getAgentState(): IAgentState {
  if (globalSession?.isActive) {
    return {
      isRunning: true,
      startedAt: globalSession.createdAt,
      lastActiveAt: globalSession.lastActiveAt,
      shutdownAt: null,
      logs: globalSession.getLogs(),
      pendingActions: globalSession.getPendingActions(),
    };
  }
  return {
    isRunning: false,
    startedAt: null,
    lastActiveAt: null,
    shutdownAt: new Date().toISOString(),
    logs: globalSession?.getLogs() ?? [],
    pendingActions: [],
  };
}

/** 向后兼容：用全局 session 分析仓库 */
export async function analyzeRepos(db: SOTAgentDB): Promise<IAgentAction[]> {
  if (!globalSession?.isActive) throw new Error('Agent 未启动');
  return globalSession.analyzeRepos(db);
}

/** 向后兼容：用全局 session 执行操作 */
export async function executeAction(action: IAgentAction): Promise<string> {
  if (!globalSession?.isActive) throw new Error('Agent 未启动');
  return globalSession.executeAction(action);
}

/** 向后兼容：用全局 session 执行所有 */
export async function executeAll(): Promise<{ action: IAgentAction; result: string }[]> {
  if (!globalSession?.isActive) throw new Error('Agent 未启动');
  return globalSession.executeAll();
}

/** 向后兼容：用全局 session 对话 */
export async function chat(message: string, db: SOTAgentDB): Promise<string> {
  if (!globalSession?.isActive) throw new Error('Agent 未启动');
  return globalSession.chat(message, db);
}

// ─── 操作执行逻辑（session 无关） ─────────────────────────

function run(cmd: string, cwd?: string): string {
  try {
    return execSync(cmd, {
      cwd: cwd || POLARISOR_ROOT,
      timeout: 30_000,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
  } catch (e) {
    return `ERROR: ${e instanceof Error ? e.message : String(e)}`;
  }
}

function executeActionImpl(action: IAgentAction, session: AgentSession): string {
  switch (action.action) {
    case 'pull': {
      if (!action.repo) return 'ERROR: 缺少 repo 参数';
      try {
        pullRepo(action.repo);
        return `${action.repo} pull 成功`;
      } catch (e) {
        return `${action.repo} pull 失败: ${e instanceof Error ? e.message : String(e)}`;
      }
    }

    case 'commit_and_push': {
      if (!action.repo) return 'ERROR: 缺少 repo 参数';
      const commitMsg = action.message || 'chore: 同步本地改动';
      const repoDir = path.join(POLARISOR_ROOT, action.repo);
      const addResult = run('git add -A', repoDir);
      if (addResult.startsWith('ERROR')) return addResult;
      const commitResult = run(`git commit -m ${shellEscape(commitMsg)}`, repoDir);
      if (commitResult.startsWith('ERROR') || commitResult.includes('nothing to commit')) return commitResult;
      const pushResult = run('git push origin HEAD', repoDir);
      return `${action.repo} commit+push 完成: ${pushResult.substring(0, 200)}`;
    }

    case 'stash_pull_pop': {
      if (!action.repo) return 'ERROR: 缺少 repo 参数';
      const stashDir = path.join(POLARISOR_ROOT, action.repo);
      const stashResult = run(`git stash push -m "auto-stash-${Date.now()}"`, stashDir);
      if (stashResult.startsWith('ERROR')) return stashResult;
      const pullResult = run('git pull --ff-only', stashDir);
      if (pullResult.startsWith('ERROR')) {
        run('git stash pop', stashDir);
        return `${action.repo} pull 失败: ${pullResult}`;
      }
      const popResult = run('git stash pop', stashDir);
      if (popResult.startsWith('ERROR') || popResult.includes('CONFLICT')) {
        return `${action.repo} stash pop 冲突，需手动处理`;
      }
      return `${action.repo} 已同步（stash→pull→pop）`;
    }

    case 'create_remote': {
      if (!action.repo || !action.github_name) return 'ERROR: 缺少参数';
      if (!/^[a-zA-Z0-9_\-]+$/.test(action.github_name)) return 'ERROR: github_name 包含非法字符';
      const repoPath = path.join(POLARISOR_ROOT, action.repo);
      return run(`gh repo create beichenO2/${action.github_name} --private --source=. --remote=origin --push`, repoPath);
    }

    case 'register_port': {
      if (!action.port || !action.service || !action.project) return 'ERROR: 缺少参数';
      return run(
        `cd ~/Polarisor/SOTAgent && npx tsx src/cli.ts register-port ${Number(action.port)} ${shellEscape(action.service)} ${shellEscape(action.project)}`,
        POLARISOR_ROOT,
      );
    }

    case 'shell': {
      if (!action.command) return 'ERROR: 缺少 command';
      const cmdCheck = validateCommand(action.command);
      if (!cmdCheck.ok) return `ERROR: 命令被安全策略拒绝: ${cmdCheck.reason}`;
      return run(action.command, POLARISOR_ROOT);
    }

    case 'submit_task': {
      if (!action.task_type || !action.command) return 'ERROR: 缺少 task_type 或 command';
      return `TASK_SUBMIT:${JSON.stringify({ task_type: action.task_type, command: action.command, priority: action.priority ?? 0 })}`;
    }

    case 'skip':
      return `已跳过: ${action.reason}`;

    case 'report':
      return action.message || '';

    default:
      return `未知操作: ${action.action}`;
  }
}

// ─── 资源调度 System Prompt ───────────────────────────────

const SCHEDULER_SYSTEM_PROMPT = `你是 SOTAgent 的资源调度智能体。你的职责是分析系统资源状态，做出调度决策。

你可以执行以下操作：
[
  {"action": "submit_task", "task_type": "类型", "command": "命令", "priority": 0-2, "reason": "原因"},
  {"action": "pull", "repo": "仓库名", "reason": "原因"},
  {"action": "commit_and_push", "repo": "仓库名", "message": "提交消息"},
  {"action": "stash_pull_pop", "repo": "仓库名", "reason": "原因"},
  {"action": "shell", "command": "命令", "reason": "原因"},
  {"action": "skip", "reason": "跳过原因"},
  {"action": "report", "message": "汇报信息"}
]

调度原则：
- 重任务在系统空闲时启动，永远不抢占正在工作的 Agent
- GPU 任务优先发到 compute 设备（Mac Studio）
- 优先级：high(2) > normal(1) > low(0)
- 资源紧张时暂停低优先级任务
- submit_task 提交新的重计算任务到队列

请根据提供的系统状态，给出 JSON 数组格式的操作建议。`;
