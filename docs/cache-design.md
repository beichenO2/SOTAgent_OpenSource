# SOTAgent 缓存设计

> 适用版本：2026-06-10 重构后  
> 文件：`src/api-cache.ts`、`src/web.ts`

---

## 设计目标

1. **前台页面实时**：用户正在看的页面每 ~1 分钟拉取最新数据
2. **后台零负载**：没有人请求的数据不产生任何网络请求
3. **重启快恢复**：磁盘缓存保证 SOTAgent 重启后首屏秒开
4. **磁盘写入少**：每 5 次成功拉取才写一次磁盘，减少 I/O

---

## 架构

```
前端 (Vue)                   SOTAgent 后端                    上游服务
┌──────────┐   每10s轮询    ┌──────────────┐                ┌────────────┐
│ 当前页面  │ ─────────────→ │ getOrFetch() │ ─── 60s冷却 → │ PolarPrivate│
│ (Vue组件) │ ← JSON ────── │              │ ← 数据 ─────── │ PolarPort  │
└──────────┘                │   内存缓存   │                │ PolarProcess│
                            │   ↕ 每5次    │                └────────────┘
                            │   磁盘缓存   │
                            └──────────────┘
```

### 数据流

1. **前端请求** → `GET /api/rate-limits`（或其他 API）
2. **`getOrFetch(key)`** 检查：
   - 如果冷却期（60s）已过且没有正在进行的请求 → 发起上游请求
   - 否则 → 返回内存缓存
3. **上游返回** → 更新内存缓存 → 每 5 次写磁盘
4. **无人请求** → 什么都不发生（零后台开销）

---

## 核心 API

### `registerFetcher(key, fetcher)`

注册一个数据源。不启动任何定时器。

```typescript
registerFetcher('rate-limits', () => fetchPrivPortal('/api/rate-limits/dashboard'));
```

### `getOrFetch(key): Promise<unknown | null>`

API handler 调用的主方法。行为：

1. 检查冷却期（`LIVE_FETCH_COOLDOWN_MS = 60_000`）
2. 冷却期已过 → 调用 fetcher → 更新缓存 → 返回新数据
3. 冷却期内 → 直接返回内存缓存
4. 内存为空 → 读磁盘缓存
5. 全都没有 → 返回 `null`

```typescript
app.get('/api/rate-limits', async (c) => {
  const data = await getOrFetch('rate-limits');
  return c.json(data ?? { ok: false, reason: 'unreachable' });
});
```

### `getCached(key): unknown | null`

只读取缓存（内存 → 磁盘），不触发 fetch。用于不需要实时数据的场景。

### `updateCache(key, data)`

手动更新缓存（例如从其他来源获得数据时）。内部计数，每 5 次写磁盘。

### `flushAllToDisk()`

强制将所有内存缓存写入磁盘。用于优雅关闭。

---

## 配置参数

| 参数 | 值 | 说明 |
|------|-----|------|
| `LIVE_FETCH_COOLDOWN_MS` | 60,000ms (1min) | 同一 key 连续拉取的最小间隔 |
| `DISK_WRITE_INTERVAL` | 5 | 每 N 次成功拉取写一次磁盘 |
| 前端轮询间隔 | ~10s | 由各 Vue 组件的 `setInterval` 控制 |

### 实际刷新频率

- 前端每 10s 请求后端
- 后端每 60s 才真正请求上游
- 所以实际数据延迟 ≈ 10s（前端）+ 0\~60s（后端冷却）= **最多 ~70s**
- 磁盘写入：60s × 5 = **每 5 分钟写一次磁盘**

---

## 与旧设计的对比

| 维度 | 旧设计 | 新设计 |
|------|--------|--------|
| 后台定时器 | 每个 key 一个 `setInterval` (5min) | **无**，按需拉取 |
| 上游请求 | 无条件，不管有没有人看 | **仅前端请求时** |
| 磁盘写入 | 每次拉取都写 | **每 5 次写一次** |
| 数据延迟 | 0\~5min (定时器间隔) | **0\~70s** (更实时) |
| 前台体验 | 可能等 5min 才更新 | 最多 70s |
| 后台开销 | 持续轮询所有上游 | **零** |

---

## PolarPrivate 端口发现

SOTAgent 需要知道 PolarPrivate 的端口来拉取 rate-limits 和 usage 数据。

### 发现逻辑（`discoverPPPort()`）

1. 查询 PolarPort API：`GET http://127.0.0.1:11050/api/list?all=true`
2. 找 `service_name === 'polarprivate'` 且 `status === 'active'` 的端口
3. 缓存 5 分钟（PP 端口很少变）
4. PolarPort 不可用时 → 回退到 `POLARPRIVATE_PORT` 环境变量或默认 12790

### 为什么不用固定端口

PolarPrivate 的 CLI (`privportal start`) 通过 `claim_port_sync()` 从 PolarPort 动态申请端口。实际分配到的端口（如 8005）可能与配置默认值（12790）不同。硬编码会导致连接失败。

---

## 磁盘缓存文件

位置：`~/Polarisor/SOTAgent/data/api-cache/`

```
api-cache/
├── architecture.json
├── costs.json
├── funnel-status.json
├── knowlever-status.json
├── knowlever-topics.json
├── ports.json
├── pp-health.json
├── pp-scheduler.json
├── pp-tasks.json
├── pp-watchdog.json
├── rate-limits.json
└── services-list.json
```

每个文件格式：

```json
{
  "data": { ... },
  "updatedAt": "2026-06-10T13:45:48.123Z"
}
```
