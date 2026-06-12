# SOTAgent Contracts

## 契约列表

| Schema | 用途 | 变更历史 |
|--------|------|---------|
| `http-api.schema.json` | HTTP API 接口摘要（gateway/scan/ports/capabilities/health/tasks...） | 2026-05-08 新增（260505 批次） |
| `inbox-outbox.schema.json` | inbox/outbox 文件消息格式 | 2026-05-08 新增 |
| `peer-sync.schema.json` | PeerSync 跨设备同步协议 | 2026-05-08 新增 |

## Examples

- `examples/inbox-message.example.json`

## Contract Tests

- `../tests/contracts/test_contracts.py`

## 变更历史

- 2026-05-08: 初始创建（260505 批次）
