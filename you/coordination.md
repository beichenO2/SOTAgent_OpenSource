# 跨设备协调信息

> 最后更新：2026-04-15 17:15

## 协调规则

1. **Agent 启动时**：读取 `you/<对端设备>.md`，检查 📬 消息章节是否有新内容
2. **任务完成后**：更新自己设备的 `.md` 文件，提交并推送
3. **冲突处理**：如果两端同时在同一个项目工作，在此文件的"冲突与协商"节记录
4. **PeerSync 自动同步**：SOTAgent 的 PeerSync 会在心跳时自动 pull 对端更新

### 消息格式规范

```markdown
### 消息 N: 标题 (YYYY-MM-DD HH:MM)

内容...

**状态**: 未读 / 已读 / 已处理
```

## 共享决策

| 日期 | 决策 | 原因 |
|------|------|------|
| 2026-04-14 | PolarPrivate 端口统一为 12790（PolarPort SDK 动态分配） | Mac Studio 和 MacBook 使用相同配置 |
| 2026-04-14 | SOTAgent Web API 端口固定 4800 | 两台设备统一（注意：从 4801 改为 4800） |
| 2026-04-14 | Gitee 废弃，全部迁移到 GitHub | 统一 remote 管理 |
| 2026-04-14 | SyncEngine 需要 asset-scanner 激活 | tech_assets 表空 |
| 2026-04-15 | LLM 访问统一走 PolarPrivate Proxy | Agent 不接触明文 API Key |
| 2026-04-27 | 新增 `/v1` 统一 LLM 网关（按 model 名路由，无需知道 Provider）| 旧 `/proxy/` 路由保留兼容 |

## LLM 接入规范

**Agent 需要 LLM 时，优先使用 `/v1` 统一网关：**
- **统一入口（推荐）**: `base_url = http://127.0.0.1:12790/v1`，传 `model` 名即可
- **模型发现**: `GET http://127.0.0.1:12790/v1/models`
- **不要** 直接访问 `coding.dashscope.aliyuncs.com`、`api.minimax.chat` 等上游地址
- Proxy 自动注入 API Key，请求中无需携带密钥
- 旧写法 `/proxy/llm.aliyun.codingplan` 仍然有效，无需迁移
- 详见 `knowledge/service-polarprivate-proxy.md`

## 冲突与协商

### 当前冲突

无（22/22 项目已全部 clean）

## 待办交接

- [ ] asset-scanner.ts 实现（方案见 mac-studio.md 消息 1，优先级低，已推迟）
- [x] GSD2 增加"收件箱检查"规范（已写入 ref-common-rules.md 1.8 节）
- [ ] MacBook 需要完成 PolarPrivate vault 恢复
