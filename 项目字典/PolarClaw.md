# PolarClaw

> 最后更新: 2026-05-01

## 身份

| 字段 | 值 |
|------|-----|
| **项目名** | PolarClaw (龙虾) |
| **路径** | `~/Polarisor/PolarClaw/` |
| **角色** | AI Agent 融合平台 — 多通道多轮对话 + 自学习 |
| **GitHub** | beichenO2/PolarClaw (private) |
| **技术栈** | TypeScript, Node.js, SQLite (better-sqlite3) |

## 职责

- 端口-适配器（六边形）架构的 AI Agent 核心
- 多轮对话（SQLite 持久化对话历史）
- 多通道支持（CLI、飞书 WebSocket）
- 隐私优先（Channel Privacy Gateway 强制脱敏）
- 自学习系统（使用追踪 → 模式检测 → 技能生成 → 工作流组合）
- 技能热加载（文件监听自动加载新 Skill）
- LLM 路由器（意图检测 + Fallback + 熔断器）

## 对外接口

| 接口 | 说明 |
|------|------|
| CLI | 终端直接对话（`POLARCLAW_CLI=1`） |
| 飞书通道 | WebSocket + Webhook（需配置 App 凭证） |

## 与其他项目的关系

| 项目 | 关系 |
|------|------|
| PolarPrivate | LLM 请求经 Proxy 转发（`http://127.0.0.1:12790/proxy/llm.aliyun.codingplan`），隐私脱敏 SDK |
| AutoOffice | 报告生成（API :3900） |
| Clock | clock-integration 技能（6 个工具操作番茄钟，需 Clock 后端 :15550） |
| KnowLever | subprocess 调用 Python RAG 检索 |
| SOTAgent | 进程管理托管 |

## 当前状态

核心架构完成：Agent 循环、多通道、隐私网关、自学习系统均已实现。
从旧版 OpenClaw+DeerFlow+Hermes 完全重写为 TypeScript。
