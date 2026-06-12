---
id: "service:polarprivate-llm-proxy"
type: architecture
version: 3
source: "~/Polarisor/PolarPrivate"
adopted_at: "2026-04-27"
projects: ["*"]
---

# PolarPrivate — 服务能力与接入方式

## 服务地址

- **Base URL**: `http://127.0.0.1:12790`
- **健康检查**: `GET /health`

---

## ✅ 推荐接入方式（v1 统一网关）

> **Agent 优先使用这个方式。** 只需指定模型名，不需要知道 Provider 是谁。

```bash
# 1. 查看所有可用模型
curl http://127.0.0.1:12790/v1/models

# 2. 发起对话（填任意模型 ID 即可）
curl -X POST http://127.0.0.1:12790/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model": "MiniMax-M2.7-highspeed", "messages": [{"role": "user", "content": "hello"}]}'
```

**编程集成（OpenAI SDK，任意语言）：**

```python
from openai import OpenAI

client = OpenAI(
    base_url="http://127.0.0.1:12790/v1",
    api_key="local",  # 任意字符串，Proxy 自动注入真实 key
)
response = client.chat.completions.create(
    model="MiniMax-M2.7-highspeed",  # 或 "qwen3-coder-plus" 等
    messages=[{"role": "user", "content": "hello"}],
)
```

```typescript
// 直接 fetch
const resp = await fetch("http://127.0.0.1:12790/v1/chat/completions", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ model: "qwen3-coder-plus", messages: [...] }),
});
```

### 当前可用模型

| 模型 ID | Provider | 适用场景 |
|---------|----------|---------|
| `MiniMax-M2.7-highspeed` | MiniMax | 快速响应，支持 thinking |
| `MiniMax-M2.7` | MiniMax | 标准版 |
| `qwen3-coder-plus` | 阿里云 | 编程专用 |
| `qwen3.6-plus` | 阿里云 | 通用高质量 |

> 调用 `GET /v1/models` 获取实时列表（仅展示 binding 已配置且 enabled 的模型）。

### 未知模型的报错

如果传入不认识的模型，会返回：
```json
{
  "code": "UNKNOWN_MODEL",
  "available_models": ["MiniMax-M2.7-highspeed", "qwen3-coder-plus", ...],
  "hint": "Call GET /v1/models for the full list."
}
```

---

## 旧接入方式（仍然有效，按 Provider 路由）

> 旧代码无需修改，`/proxy/*` 路由完全保留。

```bash
# 按 service_name 发现所有 binding
curl http://127.0.0.1:12790/proxy/

# 直接指定 provider 路由
curl -X POST http://127.0.0.1:12790/proxy/llm.aliyun.codingplan/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model": "qwen3-coder-plus", "messages": [...]}'
```

---

## 关键规则

1. **永远不要直接访问上游 URL**（`coding.dashscope.aliyuncs.com`、`api.minimax.chat` 等）— 用 Proxy
2. Proxy 自动注入 `Authorization: Bearer <key>`，请求中不需要带 key
3. 支持 streaming（SSE）和非 streaming 模式
4. 新代码用 `/v1`，旧代码保持 `/proxy/` 不变

## Binding API

```bash
# 查看所有 binding（含 proxy_url 字段）
curl http://127.0.0.1:12790/api/bindings
```

## Sanitize SDK（文本脱敏）

```python
from privportal_sdk import PrivPortalMiddleware
mw = PrivPortalMiddleware("http://127.0.0.1:12790")
mw.load_mappings()
safe = mw.sanitize("你好，我是张三")    # → "你好，我是[[identity.student.name]]"
real = mw.resolve("[[identity.student.name]]你好")  # → "张三你好"
```

## 添加新模型 / Provider

1. 在 PolarPrivate 创建 Secret（保存 API Key）
2. 创建 Binding（`POST /api/bindings`），关联 secret
3. 在 `PolarPrivate/backend/app/core/model_routing.py` 加前缀映射
4. 在 `PolarPrivate/backend/app/core/model_catalog.py` 加模型条目
5. 重启 PolarPrivate Backend
