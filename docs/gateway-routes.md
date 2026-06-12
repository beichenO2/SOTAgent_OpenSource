# SOTAgent 网关路由（config.json → gateway.routes）

> 事实源：`config.json` 的 `ports` 与 `gateway.routes`。  
> 客户端应优先使用 **`http://127.0.0.1:4800/gw/<prefix>/...`**，勿硬编码各项目端口。

## 端口 SSOT（节选）

| config 键 | 端口 | 服务 |
| --- | --- | --- |
| `sotagent_api` | **4800** | SOTAgent Web API + 网关 |
| `sotagent_console` | 4880 | SOTAgent Console（Vue） |
| `digist_api` | **3800** | digist HTTP API（`src/api/server.ts`） |
| `polarclaw_web` | 3910 | PolarClaw Web |
| `polar_private` | 12790 | PolarPrivate |

## 网关路由表

| prefix | target_port | service_id | 示例 |
| --- | --- | --- | --- |
| `polarprivate` | 12790 | polarprivate-backend | `/gw/polarprivate/v1/chat/completions` |
| **`digist`** | **3800** | digist | `/gw/digist/api/items/recent?q=AI` |
| `autooffice` | 3900 | autooffice | `/gw/autooffice/...` |
| `clock` | 15550 | polarclock-backend | `/gw/clock/...` |
| `knowlever` | 18080 | knowlever-rag | `/gw/knowlever/...` |

完整列表见 `config.json` → `gateway.routes`。

## digist 特别说明（2026-06-12）

- **canonical 端口 3800**（`ports.digist_api` + `gateway.routes[digist].target_port`）
- digist-api 须与 **Node 22+** 及匹配的 `better-sqlite3` 二进制一致
- 推荐安装：`bash ~/Polarisor/digist/scripts/install-api-launchd.sh`
- PolarPort 注册名：`digist-api`（PolarPort `:11050/api/list` 可查）

### 常见错误

| 症状 | 原因 | 处理 |
| --- | --- | --- |
| `/gw/digist/...` 返回空 items 且无 `search` 字段 | 旧 digist-api 忽略 `q` 或未重启 | 拉最新 digist + 重启 `com.digist.api` |
| gateway health `db degraded` / sqlite NODE_MODULE_VERSION | Node 版本与 better-sqlite3 不匹配 | `nvm use 22 && npm rebuild better-sqlite3` 后重启 |
| 直连非 3800 端口 | 手工启动未设 `PORT=3800` | 用 launchd plist 或 `PORT=3800 npm run digist-api` |
