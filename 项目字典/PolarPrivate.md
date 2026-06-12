# PolarPrivate (PrivPortal)

> 最后更新: 2026-05-06

## 身份

| 字段 | 值 |
|------|-----|
| **项目名** | PolarPrivate (PrivPortal) |
| **路径** | `~/Polarisor/PolarPrivate/` |
| **角色** | 隐私代理 + 凭证管理中心 — 所有 LLM 调用的必经之路 |
| **GitHub** | beichenO2/PolarPrivate (private) |
| **技术栈** | Python (FastAPI, SQLAlchemy, SQLite), React 18 + Vite + Tailwind |

## 职责

- 加密 Secret 存储（API Key、Token — Fernet AES-128-CBC + HMAC-SHA256）
- 加密 Identity 存储（PII 信息同样加密）
- Binding 代理（自动注入 Auth 头到上游 API 请求）
- Sanitize SDK（文本脱敏/还原，供 Agent 调用）
- 跨设备同步（加密备份通过 GitHub 安全同步）
- Dashboard（待填写入口，内联编辑）

## 对外接口

| 接口 | 地址 | 说明 |
|------|------|------|
| 后端 API | `http://127.0.0.1:12790` | FastAPI（Proxy + Secret/Identity CRUD） |
| 前端 UI | `http://127.0.0.1:5170` | React Dashboard |
| Proxy | `http://127.0.0.1:12790/proxy/*` | LLM 请求代理转发 |
| Sanitize SDK | `from privportal_sdk import PrivPortalMiddleware` | Python 包 |

## 与其他项目的关系

| 项目 | 关系 |
|------|------|
| SOTAgent | 进程管理托管（backend + frontend），定时 Vault 备份，LLM Agent 请求通过此处转发 |
| PolarClaw | LLM Proxy 提供者 + Sanitize SDK 脱敏 |
| KnowLever | LLM Proxy 提供者（enrich.py, compile.js） |
| Clock | 无直接依赖 |
| 所有项目 | **生态中唯一持有 API Key 的项目**，其他项目一律通过 Proxy 访问 LLM |

## 当前状态

核心功能全部完成：加密存储、Proxy 转发、Sanitize SDK、跨设备同步、Dashboard。
由 SOTAgent 统一管理进程生命周期。Vault 解锁后所有服务可用。

## LLM Proxy 接入渠道

| service_name | 上游 | base_url | 主力模型 |
|---|---|---|---|
| `llm.aliyun.codingplan` | 阿里云 DashScope CodingPlan | `https://coding.dashscope.aliyuncs.com/v1` | qwen3-coder-plus, qwen3.6-plus, qwen3-max, kimi-k2.5 |
| `llm.ctyun.codingplan` | 天翼云息壤 CodingPlan | `https://wishub-x6.ctyun.cn/coding/v1` | GLM-5.1, GLM-5, GLM-5-Turbo |
| `llm.minimax` | MiniMax 官方 | (binding 内配置) | MiniMax-M2.7-highspeed |

> 天翼云 codingPlan 限制：编码套餐额度仅在 AI 编程工具中生效，禁止用于 API 自动化脚本/后端服务。
