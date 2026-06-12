# SOTAgent — 跨设备智能体守护进程 + Web 控制台

**State-Of-The-Art Agent** — 保持技术为 SOTA 的守护进程，附带 Web 可视化仪表盘。

## 核心功能

| 模块 | 职责 |
|------|------|
| **SOTA 技术同步** | 自动/建议式同步 Skills、架构、工作流到所有订阅项目 |
| **资源调度** | 重任务"偷时间"运行，共享服务分时复用 |
| **Agent 通信** | 基于文件信箱的跨设备异步通信 |
| **GitHub 同步巡检** | 定期扫描所有项目的 Git 状态，自动 pull/push |
| **Web 控制台** | Vue 3 仪表盘 — 仓库状态、端口注册、LLM 运维助手 |
| **LLM Agent** | 按需启动的智能运维助手，通过 PolarPrivate 代理调用 LLM |

> **注**: Web 控制台原为独立项目 SumSync，已于 2026-04-13 合并入 SOTAgent。

## 架构

采用**混合模式**：Shell 哨兵 + 按需 Node.js + Hono Web API。

- **哨兵** (sentinel.sh): fswatch 监听 inbox + 定时轮询兜底，launchd 管理
- **资源监控** (resource-monitor.sh): 每 60 秒采集 CPU/MEM/GPU，跑完就退
- **Web API** (web.ts): Hono HTTP 服务，为前端控制台提供数据
- **Node.js 核心**: CLI 命令 + 守护主循环

## 快速开始

```bash
# 开发模式 — 一键启动 Web API + 前端控制台
cd ~/Polarisor/SOTAgent
./start.sh

# 或分别启动
npm run web                        # Web API: http://127.0.0.1:4800
cd console && npm run dev          # 控制台: http://localhost:4880
```

## 安装（生产环境 — launchd 常驻）

```bash
cd ~/Polarisor/SOTAgent
bash bin/install.sh
```

每台设备运行一次即可。launchd 管理三个服务：
- `com.sotagent.sentinel` — 哨兵主循环
- `com.sotagent.resource-monitor` — 资源监控采样
- `com.sotagent.web` — Web API 服务器

## CLI 命令

```bash
npm run status           # 查看系统状态
npm run web              # 启动 Web API 服务器
npm run process-inbox    # 手动处理 inbox
npm run schedule         # 手动运行调度
npm run monitor          # 采样进程资源画像
```

### Agent 通信

参见 `skills/request-sotagent/SKILL.md`

## 端口分配

| 端口 | 服务 | 说明 |
|------|------|------|
| 4880 | SOTAgent Console | Web 前端控制台 |
| 4801 | SOTAgent Web API | Hono HTTP API |

## 技术栈

| 后端 | 前端 |
|------|------|
| Node.js + TypeScript | Vue 3 + TypeScript |
| Hono (HTTP API) | Vite + Tailwind CSS 4 |
| better-sqlite3 (SQLite) | Pinia + VueUse |
| tsx 运行时 | Vue Router 4 |

## 目录结构

```
SOTAgent/
├── bin/             Shell 脚本 + launchd plist + 安装脚本
├── src/             TypeScript 核心逻辑
│   ├── cli.ts         CLI 命令入口
│   ├── main.ts        守护进程主循环
│   ├── db.ts          SQLite 数据层
│   ├── communicator.ts  Agent 通信管理器
│   ├── scheduler.ts   资源调度器
│   ├── sync-engine.ts 技术同步引擎
│   ├── profiler.ts    资源画像
│   ├── web.ts         Hono Web API 服务器
│   ├── web-scanner.ts 实时 Git 扫描器
│   ├── web-agent.ts   LLM 运维助手
│   └── llm.ts         LLM 调用层 (via PolarPrivate)
├── console/         Vue 3 前端控制台
│   └── src/
│       ├── views/     页面视图
│       ├── components/ 布局和通用组件
│       ├── stores/    Pinia 状态管理
│       └── router/    Vue Router 配置
├── data/            SQLite 数据库（本地，不同步）
├── inbox/           Agent 写入请求（按设备分目录）
├── outbox/          SOTAgent 输出（按项目分目录）
├── pending-sync/    待同步变更暂存
├── processed/       已处理消息归档
├── profiles/        各设备硬件描述
├── skills/          给其他 Agent 用的通信 Skill
├── scripts/         服务注册等运维脚本
├── you/             跨设备协调工作区（每台设备一个 .md 状态文件）
└── start.sh         开发环境一键启动
```

## 统一服务管理 (ProcessManager)

SOTAgent 是所有自定义服务的统一管理器。项目只负责写代码，SOTAgent 负责运行。

### 当前管理的服务

| 服务 | 端口 | 类型 | auto_start |
|------|------|------|-----------|
| PolarPrivate Backend | 12790 | 常驻 | ✓ |
| PolarPrivate Frontend | 5170 | 常驻 | ✓ |
| AI Daily Digest | 8785 | 常驻 | ✓ |
| Claude Code Visualizer | 19120 | 常驻 | ✓ |
| GSD2 Hub | 8765 | 常驻 | ✓ |
| Tailscale Funnel Monitor | - | 常驻 | ✓ |
| Vault Backup | - | cron (每小时) | - |
| Digist Scrape | - | cron (7次/天) | - |
| Digist Summarize | - | cron (7次/天) | - |

### 服务管理 API

```bash
# 查看所有服务状态
curl http://127.0.0.1:4800/api/services

# 启动/停止/重启
curl -X POST http://127.0.0.1:4800/api/services/{id}/start
curl -X POST http://127.0.0.1:4800/api/services/{id}/stop
curl -X POST http://127.0.0.1:4800/api/services/{id}/restart

# 代码更新后通知重启
curl -X POST http://127.0.0.1:4800/api/services/{id}/notify-update \
  -H "Content-Type: application/json" \
  -d '{"strategy": "restart"}'

# 端口冲突检测
curl http://127.0.0.1:4800/api/services/port-conflicts
```

### 代码更新后的重启规范

项目代码更新后，需要通知 SOTAgent 重启对应服务。

#### 后端服务（Python / Node.js）

```bash
# 通用方式：直接调 restart API
curl -X POST http://127.0.0.1:4800/api/services/privportal-backend/notify-update \
  -H "Content-Type: application/json" \
  -d '{"strategy": "restart"}'
```

#### 前端服务（Vite）

Vite 的 HMR 能处理大部分改动，但以下情况需要完整重启：
- `vite.config.ts` 变更
- `package.json` 依赖变更（需先 `npm install`）
- `.env` 文件变更
- Tailwind 配置变更

```bash
# Vite 完整重启（先停后启，确保端口释放）
curl -X POST http://127.0.0.1:4800/api/services/privportal-frontend/restart
```

> **注意**：Vite dev server 的 `--strictPort` 参数确保它不会自动换端口。
> SOTAgent 的端口冲突检测会在启动前清理残留进程。

#### 注册新服务

```bash
curl -X POST http://127.0.0.1:4800/api/services \
  -H "Content-Type: application/json" \
  -d '{
    "id": "my-service",
    "name": "My Service",
    "command": "/path/to/binary start",
    "work_dir": "~/path/to/project",
    "port": 3000,
    "device_id": "Mac-Studio",
    "auto_start": true,
    "restart_on_failure": true,
    "max_restarts": 5,
    "health_check_url": "http://127.0.0.1:3000/health"
  }'
```

#### 注册 cron 定时任务

注册后在数据库中设置 cron_schedule：

```sql
-- cron 格式：minute hour day month weekday
-- 支持: *, 数字, 逗号分隔
sqlite3 ~/Polarisor/SOTAgent/data/resources.sqlite \
  "UPDATE shared_services SET cron_schedule = '0 * * * *' WHERE id = 'my-cron-job';"
```

### 端口冲突处理

启动服务前自动检测端口占用：
- **自家残留进程**（command 匹配注册的 work_dir）→ 自动 kill
- **第三方进程** → 报错，需手动处理

### launchd 架构

```
macOS launchd
  └── com.sotagent.web (KeepAlive=true, RunAtLoad=true)
        └── SOTAgent Web API (:4800)
              ├── ProcessManager → 常驻服务 (spawn + 健康检查 + 自动重启)
              ├── CronScheduler  → 定时任务 (每分钟检查 cron 表达式)
              └── PeerSync       → 跨设备感知
```

所有其他服务的 launchd plist 已移除，统一由 SOTAgent 管理。
备份位置：`~/Desktop/ClawBin/2026-04-14/launchd-backup/`
