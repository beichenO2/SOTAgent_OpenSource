# SOTAgent

> **Polarisor 生态的状态中枢（Single Source of Truth Agent）** — 在 Mac 本地多项目、多设备、多 Agent 并行开发时，统一回答「哪些服务在跑、端口谁占用、API 是否健康、SSoT 是否漂移」。

Polarisor 有 20+ 微服务各自监听端口、各自维护 `polaris.json`，缺少一个可观测、可自愈的运行时根节点。SOTAgent 填补这一空白：它是 SSoT Dashboard 的数据后端，也是全生态服务发现、进程守护、Git 同步与 API 网关的统一入口。

**GitHub:** [beichenO2/SOTAgent](https://github.com/beichenO2/SOTAgent)

---

## 安装

### Polarisor 生态（推荐）

```bash
git clone https://github.com/beichenO2/Polarisor.git
cd Polarisor
./install.sh infra    # 安装 SOTAgent 及基础设施依赖
```

### 独立安装

```bash
git clone https://github.com/beichenO2/SOTAgent.git
cd SOTAgent
npm install
cd console && npm install && cd ..
```

**环境要求：** Node.js ≥ 22

---

## 设计思考

### 为什么用 launchd + 原生进程，而不是 Docker？

Polarisor 是本地优先的 macOS 开发环境。SOTAgent 直接 `spawn` 子进程并做 HTTP 健康探针，配合 launchd 常驻 3 个守护单元（sentinel / resource-monitor / web），内存占用远低于容器运行时，且与 macOS 原生工具链（`lsof`、launchd）无缝集成。

### 为什么用按需拉取缓存，而不是后台定时轮询？

旧设计为每个数据源维护 5 分钟 `setInterval`，无人访问也持续打上游。现改为 **前端 10s 轮询 → 后端 60s 冷却 → 每 5 次成功拉取写一次磁盘**：有人看才拉、重启后磁盘缓存秒开、后台零负载。详见 [`docs/cache-design.md`](docs/cache-design.md)。

### 为什么用 2 小时静默重启窗口，而不是代码变更即重启？

开发期文件频繁保存。`notify-update` 标记待重启后，仅当 **连续 2 小时无新改动** 才触发重启（`silent_restart_window_sec: 7200`），避免打断正在进行的 Agent 会话。

### 为什么用 Tailscale PeerSync，而不是独立同步服务？

MacBook Pro 与 Mac Studio 已通过 Tailscale VPN 互联。PeerSync 每 **30s** 心跳交换 Git 状态，远端领先且本地 clean 时自动 pull，文件无重叠时自动 commit+push——复用现有网络，无需额外部署同步中间件。

---

## 核心亮点

| 维度 | 数据 |
|------|------|
| **托管服务** | 10 个内建服务（AutoOffice、PolarClaw、KnowLever RAG/Wiki、PolarMemory、PolarPilot 等） |
| **端口治理** | 27 个预注册端口 + 心跳自愈（released/stale → active 自动复活） |
| **API 网关** | 8 条 `/gw/*` 路由（PolarPrivate、**DiGist :3800**、AutoOffice、KnowLever 等）— 详见 [`docs/gateway-routes.md`](docs/gateway-routes.md) |
| **能力注册** | 11 个 HTTP capability，一行 `call()` 跨服务调用 |
| **SSoT 监控** | 实时监听 3 类文件（`polaris.json` / `PolarSoul.md` / `capabilities.json`），500ms 防抖 + 60s 兜底轮询 |
| **健康巡检** | 进程探针每 **120s**；Sentinel 主循环每 **30s**；PeerSync 心跳每 **30s** |
| **控制台** | Vue 3 仪表盘 **11 个功能页**（端口、服务、架构拓扑、Funnel、成本、LLM 限速等） |
| **自动化测试** | **26** 个测试文件，覆盖 R1–R5 五大需求域 |
| **下游依赖** | **8** 个项目直接依赖 SOTAgent（PolarCopilot、PolarClaw、KnowLever、AutoOffice 等） |

---

## 页面预览

![SSoT 状态总览](screenshots/sotagent-ssot.png)

> 控制台默认入口：`http://127.0.0.1:4880` — 端口注册、服务管理、架构拓扑 D3 力导向图、Funnel 路由、LLM 成本透明等。

---

## 架构

```
SOTAgent/
├── src/                    # 后端核心（TypeScript + Hono）
│   ├── web.ts              # HTTP API 主入口（4800）
│   ├── main.ts             # Sentinel 守护主循环
│   ├── db.ts               # SQLite 持久化（端口/服务/任务）
│   ├── gateway.ts          # /gw/* API 网关
│   ├── peer-sync.ts        # 跨设备 Git 同步（Tailscale）
│   ├── ssot-watcher.ts     # SSoT 实时变更检测
│   ├── scheduler.ts        # 重任务资源调度
│   ├── api-cache.ts        # 按需拉取 + 磁盘缓存
│   ├── knowlever-monitor.ts
│   ├── digist-monitor.ts
│   └── facade/             # PolarPort / PolarProcess 桥接
├── console/                # Vue 3 控制台（4880）
│   └── src/views/          # 11 个功能页
├── config.json             # 端口表、内建服务、网关路由
├── polaris.json            # SSoT 需求定义（R1–R5，33 项 feature）
├── capabilities.json       # 能力注册表
├── contracts/              # HTTP / PeerSync / Inbox JSON Schema
├── tests/                  # R1–R5 分域测试（26 文件）
├── bin/                    # launchd 安装 + sotctl CLI
├── start.sh                # 开发环境一键启动
├── docs/                   # 设计文档
└── screenshots/            # README 截图
```

**运行时数据流：**

```
各微服务 ──heartbeat──▶ SOTAgent API (:4800)
                              │
         ┌────────────────────┼────────────────────┐
         ▼                    ▼                    ▼
    SQLite DB          Vue Console (:4880)    SSoT Watcher
    (端口/进程)         (11 功能页)            (polaris.json 变更)
         │                    │                    │
         └─────────── PeerSync (Tailscale 30s) ────┘
```

---

## 快速开始

### 开发环境

```bash
# 一键启动 API + 控制台
./start.sh

# 或分别启动
npm run web                        # API:  http://127.0.0.1:4800
cd console && npm run dev          # 控制台: http://127.0.0.1:4880
```

### 生产环境（launchd 常驻）

```bash
bash bin/install.sh                # 注册 sentinel + resource-monitor + web
bash bin/install.sh uninstall      # 卸载
```

### 常用 CLI

```bash
npm run status           # 系统状态摘要
npm run schedule         # 手动运行资源调度
npm run process-inbox    # 处理 Agent 信箱
npm test                 # 运行 26 个自动化测试
```

### 关键 API

| 端点 | 说明 |
|------|------|
| `GET /api/status` | 设备/资源/任务状态摘要 |
| `GET /api/ports` | 端口注册列表 |
| `GET /api/services` | 托管服务列表 |
| `GET /api/architecture` | 生态拓扑（nodes + edges） |
| `POST /api/services/:id/notify-update` | 标记静默重启 |
| `POST /api/lobster/events` | 龙虾事件总线写入 |

---

## 生态依赖

| 项目 | 角色 | 必须 |
|------|------|:----:|
| [PolarPort](https://github.com/beichenO2/PolarPort) | 端口分配 SSOT（11050），SOTAgent facade 透明转发 | 推荐 |
| [PolarProcess](https://github.com/beichenO2/PolarProcess) | 进程生命周期管理（11055） | 推荐 |
| [PolarPrivate](https://github.com/beichenO2/PolarPrivate) | LLM 运维代理 + 限速/成本数据 | 可选 |
| [Agent_core](https://github.com/beichenO2/Agent_core) | 设计规则、SSoT 审计脚本、通信协议 | 推荐 |
| [PolarCopilot](https://github.com/beichenO2/PolarCopilot) | Hub Agent，转发 checkup-event | 可选 |
| [PolarClaw](https://github.com/beichenO2/PolarClaw) | 消费 lobster 事件总线 | 可选 |
| [KnowLever](https://github.com/beichenO2/KnowLever) | 知识库 RAG + Wiki（监控桥接） | 可选 |
| [digist](https://github.com/beichenO2/digist) | 摘要服务（监控桥接 + 定时 digest） | 可选 |

> SOTAgent 本身是依赖树的根节点——无上游硬依赖，但被生态内 8 个项目直接引用。

---

## License

MIT
