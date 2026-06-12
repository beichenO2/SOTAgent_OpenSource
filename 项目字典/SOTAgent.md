# SOTAgent

> 最后更新: 2026-04-16

## 身份

| 字段 | 值 |
|------|-----|
| **项目名** | SOTAgent |
| **路径** | `~/Polarisor/SOTAgent/` |
| **角色** | SOTA 协调器 — 结晶化 + 项目监控 + 生态字典 |
| **GitHub** | beichenO2/SOTAgent (private) |
| **技术栈** | TypeScript, Node.js, Hono, SQLite, Vue 3 |

## 职责（SOTA 协调器 — 单一职责）

核心职责：
- 结晶化（从成功项目提取可复用模式）
- 项目监控（KnowLever / digist 等子系统健康与 SOTA 状态追踪）
- **项目字典维护**（本目录）
- 检修事件聚合（checkup-events.jsonl，供 SOTA 趋势分析）

外围职责（将外包到独立项目，详见 260505 批次后续任务包，待用户决策外围项目命名）：
- 统一进程管理（启动/停止/健康检查/熔断）→ 待外包
- 端口统一注册与冲突检测 → 待外包
- 跨设备感知（PeerSync 心跳、git pull、冲突解决）→ 待外包
- 计算资源调度（GPU 转发）→ 待外包
- inbox/outbox 通信 → 待外包
- Web 控制台可视化 → 待外包
- LLM Agent 运维助手 → 待外包
- 命令安全防护 → 待外包

## 对外接口

| 接口 | 地址 | 说明 |
|------|------|------|
| Web API | `http://127.0.0.1:4800` | Hono HTTP API（服务管理、调度、PeerSync） |
| Console | `http://127.0.0.1:4880` | Vue 3 仪表盘 |
| inbox/ | 文件系统 | Agent 异步消息写入 |
| outbox/ | 文件系统 | SOTAgent 输出（按项目分目录） |

## 与其他项目的关系

| 项目 | 关系 |
|------|------|
| PolarPrivate | LLM Proxy 提供者，Vault 备份目标 |
| Clock | 进程管理托管（backend + frontend） |
| PolarClaw | 进程管理托管，LLM 请求经 PolarPrivate 转发 |
| KnowLever | 进程管理托管，LLM 编译经 PolarPrivate 转发 |
| gsd-2 | Agent 通信中枢（Hub），Skill 源码仓库 |

## 当前状态

资源调度 + 画像 + 进程管理 + PeerSync + 结晶化 + Web 控制台均已上线。
