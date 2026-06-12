---
id: "service:digist"
type: architecture
version: 1
source: "~/Polarisor/digist"
adopted_at: "2026-04-13"
projects: ["*"]
---

# DiGist — 信息采集与消化引擎

## 能力概述

DiGist 是 AI 自进化信息消化引擎，负责从多平台采集信息、存储、加工、总结。

## 调用方式

### CLI 调用（其他 Agent 推荐方式）

```bash
cd ~/Polarisor/digist

# 采集指定平台
npx tsx src/cli.ts scrape <platform> <query>

# 支持平台: twitter, xiaohongshu, zhihu, wechat, reddit, github, glass, arxiv, bilibili, hackernews, bloomberg

# 搜索已存储内容
npx tsx src/cli.ts search <query>

# 列出内容
npx tsx src/cli.ts list [platform]

# 统计
npx tsx src/cli.ts stats
```

### 编程 API 调用

```typescript
import { crawl } from 'digist/crawl-api';
const result = await crawl('twitter', 'AI agent', { maxItems: 10 });
```

### 单条内容抓取

```typescript
import { fetchSingleItem } from 'digist/scrapers/opencli';
const item = await fetchSingleItem('twitter', '2042757589180858796');
```

## 运行依赖

- **OpenCLI**: `opencli` CLI 工具（已全局安装）
- **Chrome Browser Bridge**: OpenCLI 浏览器扩展需保持连接
- **Chrome 登录状态**: 需要在 Chrome 中登录各平台（Twitter/X, 小红书, 知乎, B站 等）

## 定时任务

| 任务 | 调度 | 说明 |
|------|------|------|
| `com.digist.daily-digest` | 06:00, 08:00, 11:00, 14:00, 17:00, 20:00, 23:00 | 多平台信息采集 |
| `com.digist.summarize` | 每次采集后 30 分钟 | LLM 总结生成摘要 |

## 数据位置

- 数据库: `~/Polarisor/digist/data/digist.sqlite`
- 每日摘要: `~/Polarisor/digist/data/daily/YYYY-MM-DD/digest.md`
- 日志: `~/Polarisor/digist/data/logs/`

## 健康检查

```bash
# 检查 OpenCLI 连通性
opencli doctor

# 检查各平台登录状态
npx tsx -e "import { runHealthCheck } from './src/scrapers/opencli-health.js'; const r = await runHealthCheck(); console.log(JSON.stringify(r, null, 2));"
```

## 注意事项

- 不需要端口占用（纯 CLI 工具 + 定时任务）
- 凭据通过 Chrome cookie 管理，不经 PolarPrivate
- 如果 Chrome 未运行或未登录，采集会静默失败（日志记录）
