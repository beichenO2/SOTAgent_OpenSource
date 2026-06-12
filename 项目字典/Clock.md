# Clock (PolarClock)

> 最后更新: 2026-04-16

## 身份

| 字段 | 值 |
|------|-----|
| **项目名** | Clock (PolarClock) |
| **路径** | `~/Polarisor/Clock/` |
| **角色** | 番茄钟时间管理系统 |
| **GitHub** | beichenO2/PolarClock (private) |
| **技术栈** | React 18 + Vite + TailwindCSS + Zustand (前端), FastAPI + Python (后端) |

## 职责

- 番茄钟计时（45min 工作 + 10min 休息 + 15min 休闲 + 运动提醒）
- 任务管理 + 甘特图（无限嵌套子任务、拖拽、优先级）
- 二象限 "Last Thing to Do" 整数排序
- Deadline 48h 自动优先级提升
- 日程编排（三餐、课程 Block）
- 健康管理（运动计时、洗澡提醒）
- 多用户支持 + 浏览器通知

## 对外接口

| 接口 | 地址 | 说明 |
|------|------|------|
| 前端 | `http://localhost:4555/clock/login` | React UI |
| 后端 API | `http://localhost:15550` | FastAPI REST |

## 与其他项目的关系

| 项目 | 关系 |
|------|------|
| SOTAgent | 进程管理托管（backend + frontend 均由 SOTAgent 管理） |
| PolarClaw | PolarClaw 有 Clock 集成技能（clock-integration），可通过 Agent 操作番茄钟 |
| PolarPrivate | 无直接依赖 |

## 当前状态

MVP 全部完成。所有核心功能已实现并可用。
