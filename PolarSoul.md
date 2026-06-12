# SOTAgent — PolarSoul

## 设计哲学

SOTAgent 是 Polarisor 的基础设施守护进程，负责服务发现、进程管理、Git 同步和 API 网关，是整个生态的运行时根基。

- **进程守护而非容器**: 直接进程管理（spawn + 健康检查 + 自动重启），比 Docker 更轻量
- **自愈能力**: 过期/释放的端口在进程实际监听时自动重新激活
- **跨设备感知**: 通过 Tailscale VPN 实现 PeerSync 多设备协调
- **静默重启**: 最后代码变更后 2 小时窗口内不自动重启，避免开发时干扰
- **沙箱支持**: 资源受限的进程执行（nice/ulimit/输出监控）

## 功能介绍

- **生态位**: SSoT 守护进程，Polarisor 的单一事实源和基础设施根节点
- **承担功能**:
  - R1: 服务发现与端口管理（端口发现 + 自动修复、port-sdk 提供 claimPort/heartbeat、端口自愈、健康检查、API 控制台、架构拓扑 D3.js、接口变更预警、Funnel Dashboard、成本透明仪表盘）
  - R2: 进程生命周期管理（进程启停重启 + Start/ 脚本编排、静默重启窗口、Start 脚本自托管、Watchdog、孤儿端口清理、外部进程收养、进程沙箱 + 资源限制）
  - R3: Git 仓库同步与数据管理（仓库扫描、PeerSync via Tailscale VPN、冲突解决、SyncEngine）
  - R4: 网关与能力注册（API 网关 /gw/*、能力注册表、任务 API、port-sdk call() API）
  - R5: 辅助服务与集成（KnowLever 监控、DiGist 监控、资产扫描、Crystallize、lobster 事件总线、LLM Web Agent、checkup-event 聚合）

## 与其他项目的关系

- **基础设施根节点**: 所有项目依赖 SOTAgent 的端口分配和进程守护
- 无上游依赖（依赖树的根）
- 管理: PolarPrivate、PolarClaw、PolarCopilot Hub、KnowLever、digist、Clock 等所有服务进程
- 提供: 端口发现（port-sdk）、服务 CRUD、Git 同步、lobster 事件总线、Funnel 管理

## 关键设计决策

- Why launchd not Docker: macOS 原生进程管理更轻量，无需额外运行时
- Why not Docker: 本地优先架构不需要容器化隔离，直接进程管理更简单高效
- Why silent restart window: 避免开发时频繁代码变更触发服务重启
- Why PeerSync via Tailscale: 利用现有 VPN 基础设施，无需额外同步服务

## 依赖与被依赖

- **依赖**: PolarPrivate（LLM ops assistant 代理）
- **被依赖**: PolarPort、所有 Polarisor 项目

## 服务生命周期规范

SOTAgent 是 Polarisor 生态的服务生命周期权威。所有托管服务的启/停/重启必须通过 SOTAgent API（P27 强制规范，见 `Agent_core/principles/ADVANCED.md`）：

```bash
POST http://127.0.0.1:4800/api/services/:id/stop   # 停止（优雅）
POST http://127.0.0.1:4800/api/services/:id/start   # 启动
POST http://127.0.0.1:4800/api/services/:id/restart  # 重启
```

**禁止直接 `kill`/`pkill` 托管服务进程**——直接杀进程会绕过 SOTAgent 状态记录，导致 Watchdog 误判、双重拉起、`restart_count` 配额错误消耗。

auto_start 服务由 Watchdog 自动管理（15 分钟稳定运行清零 `restart_count` 配额），正常情况不需人工干预。
