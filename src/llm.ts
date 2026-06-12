/**
 * LLM 客户端 — 通过 PolarPrivate /v1/ 统一网关调用
 * 只需指定 model 名称，PolarPrivate 自动路由到正确的上游服务并注入 API Key
 */

import { POLAR_PRIVATE_PORT } from './ports.js';

const V1_BASE = `http://127.0.0.1:${POLAR_PRIVATE_PORT}/v1`;

interface IChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

interface IChatResponse {
  choices: { message: { content: string } }[];
}

export async function chatCompletion(messages: IChatMessage[], model = 'qwen3-coder-plus'): Promise<string> {
  const res = await fetch(`${V1_BASE}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, messages, temperature: 0.3, max_tokens: 2048 }),
    signal: AbortSignal.timeout(300_000),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`LLM 请求失败 (${res.status}): ${text}`);
  }

  const data = (await res.json()) as IChatResponse;
  return data.choices[0]?.message?.content || '';
}

export async function askAgent(prompt: string): Promise<string> {
  return chatCompletion([
    {
      role: 'system',
      content: `你是 SOTAgent 控制台的智能运维助手。
你的职责：
1. 分析 Git 仓库状态并决定操作（pull、commit、stash 等）
2. 注册端口到 SOTAgent
3. 执行简单的 shell 命令来完成运维任务

回复格式为 JSON 数组，每个元素是一个操作：
[
  {"action": "pull", "repo": "仓库名", "reason": "原因"},
  {"action": "commit_and_push", "repo": "仓库名", "message": "commit 消息", "reason": "原因"},
  {"action": "stash_pull_pop", "repo": "仓库名", "reason": "原因"},
  {"action": "create_remote", "repo": "仓库名", "github_name": "建议的GitHub仓库名"},
  {"action": "register_port", "port": 端口号, "service": "服务名", "project": "项目名"},
  {"action": "shell", "command": "要执行的命令", "reason": "原因"},
  {"action": "skip", "repo": "仓库名", "reason": "跳过原因"},
  {"action": "report", "message": "汇报信息"}
]

操作选择指南：
- 有未提交文件且版本落后 → stash_pull_pop（stash→pull→pop，自动保留本地改动）
- 有未提交文件但版本不落后 → commit_and_push（提交并推送）
- 干净但版本落后 → pull
- 无远程仓库 → create_remote（github_name 用 beichenO2 组织下的名字）
- commit_and_push 的 message 格式："chore: 同步本地改动 — [简述改动]"
- 谨慎执行 shell 命令，只做必要操作`,
    },
    { role: 'user', content: prompt },
  ]);
}
