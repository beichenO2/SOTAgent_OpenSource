# KnowLever

> 最后更新: 2026-04-16

## 身份

| 字段 | 值 |
|------|-----|
| **项目名** | KnowLever |
| **路径** | `~/Polarisor/KnowLever/` |
| **角色** | 知识编译引擎 — 将杂乱原始信息 LLM 编译为结构化 Wiki |
| **GitHub** | beichenO2/KnowLever (private) |
| **技术栈** | Node.js (wiki-engine, build.js), Python (enrich.py, RAG), Zod |
| **端口** | 8801 (embedding server) |

## 职责

- 6 层知识处理管道: Raw → Normalize → LLM Compile → Wiki → Retrieval → Website
- 原始数据摄入（论文、推文、课件、网页）
- LLM 语义增强（实体/关系提取）
- 知识编译（raw → 结构化互链 wiki 页面）
- RAG 混合检索（向量 + BM25）
- Skill 蒸馏（从知识图谱提取可执行 Skill）
- Standard + Enhanced 双模式静态网站生成

## 对外接口

| 接口 | 说明 |
|------|------|
| CLI (`node scripts/topic-manager.js`) | Topic 管理 |
| CLI (`node wiki-engine/build.js`) | Wiki 构建 |
| CLI (`python3 scripts/query-topic.py`) | RAG 检索 |

## 与其他项目的关系

| 项目 | 关系 |
|------|------|
| PolarPrivate | LLM 调用经 PolarPrivate Proxy 转发（enrich.py, compile.js），端口 :12790 |
| SOTAgent | 进程管理托管 + OCR 任务分发 (API :4800) |
| digist | 数据源（通过 DIGIST_ROOT + SQLite 读取采集数据） |
| wiki-core | 共享编译管线（file:../wiki-core npm link） |
| PolarClaw | PolarClaw 通过 subprocess 调用 RAG 查询 |
| AutoOffice | AutoOffice 通过 execFile 调用 RAG 增强报告 |

## 当前状态

85 commits，6 层管道全部实现。compile.js 核心编译通过真实数据验证。
被 4 个项目依赖（SOTAgent, InfoForge, PolarClaw, AutoOffice），是知识处理层核心。
