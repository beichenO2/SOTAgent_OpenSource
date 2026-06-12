# Mac Studio 工作状态

> 最后更新：2026-04-14 19:20 by Agent

## 当前任务

- **项目**: SOTAgent
- **任务**: SyncEngine 激活方案设计 + 跨设备留言机制改进
- **状态**: 方案已写入

## 已完成

1. [x] 全量同步完成（23/23 Git 项目 clean）
2. [x] PolarClaw 嵌套 git repo 取消追踪（deer-flow/hermes-agent/openclaw）
3. [x] Gitee 引用全部清除（PolarisLab 已迁移到 GitHub）
4. [x] 数据库清理（残留项目注册、无效端口、过时共享服务）
5. [x] 残留进程关闭（workplace/clawd 老进程）
6. [x] gsd-2 运行时更新到最新

## 📬 给 MacBook Pro Agent 的消息

### 消息 1: SyncEngine 激活方案 (2026-04-14 19:15)

`tech_assets` / `subscriptions` / `sync_log` 全空，SyncEngine 从未运行。

**方案**：新建 `src/asset-scanner.ts`（~150 行），在每次 `backgroundScan()` 后自动扫描所有项目中的技术资产（.cursor/rules、tsconfig、eslintrc、skills、workflows 等），通过 content_hash 对比变更，注册到 `tech_assets` 表。同时根据"哪些项目有同类文件"自动建立订阅关系。

详细设计已写入 `致继任者/进度.md` 末尾的"设计方案：激活 SyncEngine 技术资产同步"章节。

**优先级建议**：可以穿插在 P0 之间做，预计 2 小时，不影响 scheduler/profiler。

### 消息 2: 跨设备留言机制需要改进 (2026-04-14 19:20)

当前问题：写了消息但对面不知道要来读。

建议在 GSD2 的 `ref-common-rules.md` 中增加：
1. Agent 启动时（session 开始）必须读 `you/<对端设备>.md` 检查是否有新消息
2. SOTAgent PeerSync 心跳检测到 `you/` 目录有变更时，在 console 日志提醒
3. 消息格式规范化：每条消息有时间戳 + 已读标记

## 下一步计划

- 等 MBP Agent 读到方案后实现 asset-scanner.ts
- 或本机直接实现也可以（代码是共享的）

## 需要 MacBook Pro 做的事

1. 拉取最新 SOTAgent（有 SyncEngine 方案 + 这个签到）
2. 评估并实现 asset-scanner.ts
3. 在 GSD2 中增加"收件箱检查"规范

## 本机环境状态

| 服务 | 端口 | 状态 |
|------|------|------|
| SOTAgent Web API | 4801 | ✅ 运行中 |
| SOTAgent Console | 4880 | ✅ 运行中 |
| PolarPrivate 后端 | 12790 | ✅ 运行中 |
| PolarPrivate 前端 | 5170 | ✅ 运行中 |
| LM Studio | 1234 | ✅ 运行中 |
| Ollama | 11434 | ✅ 运行中 |
| PolarClaw | 18790 | ✅ 运行中 |
