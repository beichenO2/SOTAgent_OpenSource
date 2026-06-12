# 项目字典 — Polarisor 生态注册中心

> **维护者**: SOTAgent（自动 + 手动更新）
> **位置**: `~/Polarisor/SOTAgent/项目字典/`
> **访问方式**: 各项目通过软链接 `项目字典 → ~/Polarisor/SOTAgent/项目字典/` 只读访问

## 用途

每个项目的 Agent 在启动时读取本目录，了解整个生态中所有项目的职责、状态和协作方式。
这样任何 Agent 在处理跨项目任务时，都知道"谁是谁、谁干什么、怎么联系"。

## 文件结构

每个已注册项目对应一个 `{项目名}.md` 文件：

```
项目字典/
├── README.md          # 本文件（索引说明）
├── _index.json        # 机器可读索引（项目名 → 摘要）
├── SOTAgent.md        # SOTAgent 注册信息
├── Clock.md           # Clock 注册信息
├── KnowLever.md       # KnowLever 注册信息
├── PolarClaw.md       # PolarClaw 注册信息
├── PolarPrivate.md    # PolarPrivate 注册信息
└── ...                # 新项目在备案时自动创建
```

## 注册/更新规范

1. **SOTAgent 负责维护** — 其他项目只读，不直接修改字典文件
2. **备案时机** — 项目完成阶段性工作后，通过 SOTAgent API 或致继任者同步触发更新
3. **自动同步** — `scripts/sync-dictionary.sh` 从各项目的 `致继任者/` 提取最新信息
4. **新项目注册** — 在 SOTAgent 的 `致继任者/相关项目.md` 中登记后，运行同步脚本

## 各项目访问方式

各项目根目录下有软链接：
```bash
~/Polarisor/Clock/项目字典       → ~/Polarisor/SOTAgent/项目字典/
~/Polarisor/KnowLever/项目字典   → ~/Polarisor/SOTAgent/项目字典/
~/Polarisor/PolarClaw/项目字典   → ~/Polarisor/SOTAgent/项目字典/
~/Polarisor/PolarPrivate/项目字典 → ~/Polarisor/SOTAgent/项目字典/
```

Agent 启动时只需 `cat 项目字典/_index.json` 即可快速了解全局。
