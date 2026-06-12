# 技术栈 SOTA 认定与同步规范

## 什么是"技术栈"

SOTAgent 语境下的"技术栈"**不是**依赖版本（Vue 3.5, Python 3.12 等），
而是指**影响工作质量和效能的方法论、架构模式、最佳实践**。

### 技术栈分类

| 类别 | 示例 | 同步方式 | 交叉影响 |
|------|------|----------|----------|
| `methodology` | Karpathy AI 工作准则、TDD 流程 | 文档推送 → Agent 自进化 | → architecture, pattern |
| `architecture` | DeerFlow 沙箱管理、Hermes 自进化架构 | 文档推送 → Agent 评估适配 | → methodology, config |
| `framework` | gsd-2 协作框架（版本化） | 版本号比对 → 自动/手动升级 | → 所有类别 |
| `pattern` | 成功的 UI 模式、API 设计范式 | 模板推送 → 项目匹配时应用 | → config |
| `config` | tsconfig 最佳实践、ESLint 规则集 | 模板文件自动覆盖 | （最底层，通常不影响其他） |

### 技术栈声明格式

每项技术栈用一个 Markdown 文件声明，存放在 SOTAgent 的 `knowledge/` 目录。

```yaml
---
id: "methodology:karpathy-ai-rules"
type: methodology
version: 1
source: "https://x.com/karpathy/status/..."
adopted_at: "2026-04-11"
projects: ["*"]  # 适用于所有项目，或指定 ["gsd-2", "PolarPrivate"]
---

# Karpathy AI 工作准则

1. Think before coding — 先说假设再动手
2. Simplicity first — 50 行能解决的不用 200 行
...
```

## SOTA 认定机制

"SOTA"的定义：**在某个实践领域，当前已知的最优方法**。

### 认定流程

1. **用户认定**：用户在某个项目中引入新的方法/架构，显式声明为 SOTA
   - 方式：写入 `knowledge/` 或通过 inbox 发送 `sync_request`
2. **项目沉淀**：SOTAgent 的 `crystallize` Skill（见下文）扫描项目，
   从成功实践中提取可复用模式
3. **版本递进**：同类技术栈的新版本自动取代旧版本
   - 例：gsd-2 v2.1 取代 v2.0

### 不进行的判断

SOTAgent **不判断**某项技术是否真的是 SOTA。
用户说它是 SOTA，它就是 SOTA。SOTAgent 只负责推送和同步。

## 项目经验复用（Crystallize 机制）

当用户认为某个项目的某种实践值得复用时，可以"结晶化"它。

### crystallize Skill

```bash
# 用户对 Agent 说：
# "把这个知识展示网站的风格结晶化，以后同类项目都用这个模式"
```

结晶化流程：
1. Agent 扫描指定项目目录
2. 提取关键特征：UI 组件结构、样式规范、交互模式、API 设计
3. 生成结晶文件（`crystal-{name}.md`）包含：
   - 适用场景描述（什么类型的项目应该沿用）
   - 关键文件和目录结构模板
   - 核心设计决策和原因
   - 代码片段和配置模板
4. 以特定格式命名，创建为 GitHub private 仓库
5. 注册到 SOTAgent 的 `tech_assets` 表

### 结晶文件格式

```yaml
---
id: "pattern:knowledge-showcase-ui"
type: pattern
version: 1
source_project: "KnowledgeVault"
match_criteria:
  keywords: ["知识展示", "文档", "教程", "博客"]
  project_type: ["web-app", "static-site"]
  tags: ["content-display", "readable"]
---

# 知识展示网站 UI 模式

## 适用场景
需要展示结构化知识/文档的 Web 项目。

## 设计决策
- 极简导航：左侧目录树 + 右侧内容
- 排版优先：大段文字用衬线字体...
- 代码高亮：使用 Shiki + 自定义主题

## 目录结构模板
```
src/
  components/
    layout/    # 布局组件
    content/   # 内容渲染组件
  styles/
    typography.scss
    code-theme.scss
```

## 核心代码片段
...
```

### 项目匹配

当新项目创建时，SOTAgent 检查现有 pattern 结晶的 `match_criteria`：
- 关键词匹配项目描述
- 项目类型匹配
- 标签匹配

如果匹配度高（≥2 个维度命中），SOTAgent 推送建议：
"检测到类似项目 `{source_project}` 的成功模式，是否沿用？"

## 同步策略

| 类别 | 同步触发 | 同步方式 | 用户参与 |
|------|----------|----------|----------|
| `methodology` | 用户更新声明 | 推送文档到所有订阅项目 | Agent 自进化或请求用户 |
| `architecture` | 用户更新声明 | 推送到相关项目的 Agent | Agent 评估并报告 |
| `framework` | 新版本发布 | 版本号比对 → 通知升级 | 用户决定升级时机 |
| `pattern` | 新项目匹配 | 推送结晶模板 | 用户确认是否沿用 |
| `config` | 用户更新模板 | 自动覆盖到订阅项目 | 无需参与 |

## 与 GitHub 的关系

- 每个结晶化的经验创建为独立的 GitHub private 仓库
- 仓库命名：`crystal-{pattern-name}`
- 包含：结晶文档、模板文件、示例配置
- SOTAgent 通过 GitHub API 检查仓库是否有更新（新 commit）
- 多设备通过 GitHub 同步结晶内容（而不是 iCloud）

---

## 动态集成框架："集百家之长"

### 问题背景

开源社区持续产出先进的 AI 工作方法论、架构模式（如 Hermes 自进化框架、DeerFlow 沙箱管理等）。
如何系统性地将这些最佳实践集成到我们的 Agent 体系中？

### 集成流程

```
1. 发现 → 2. 分类 → 3. 提炼 → 4. Skill 化 → 5. 装载 → 6. 同步
```

#### 步骤 1: 发现

来源：
- 用户主动引入（"我看到了 Karpathy 的这个准则，觉得很好"）
- SOTAgent 定期扫描（未来：GitHub trending、论文、技术博客）
- Agent 在执行中发现（"这个项目的做法比我们现在的更好"）

#### 步骤 2: 分类

根据技术栈分类矩阵归类。关键判断：

```
这个先进实践影响的是什么？
  ├── 影响 Agent 的"思考方式" → methodology
  ├── 影响系统的"组织结构" → architecture
  ├── 影响代码的"设计模式" → pattern
  ├── 影响构建的"配置参数" → config
  └── 影响工作流的"整体框架" → framework
```

一个实践可能横跨多个类别（标记 `related_categories`）。

#### 步骤 3: 提炼

将原始材料（论文、博文、代码仓库）提炼为结构化的知识文件：

```yaml
---
id: "architecture:hermes-self-evolution"
type: architecture
version: 1
source: "https://github.com/xxx/hermes"
adopted_at: "2026-04-12"
related_categories: ["methodology", "pattern"]
projects: ["*"]
---

# Hermes 自进化架构

## 核心理念
Agent 应具备自我评估和改进能力...

## 可执行规则
1. 每次任务完成后进行效能自评（耗时、质量、返工率）
2. 自评结果写入 profiling 数据
3. 达到阈值时触发自进化流程...

## 在 gsd-2 中的落地方式
- worker 模板增加"自评"步骤
- Hub 增加 profiling 数据采集接口
- SOTAgent 汇总 profiling 数据并识别改进点
```

#### 步骤 4: 载体选择

**不是所有先进实践都适合做成 Skill。** 根据实践的性质选择合适的载体：

| 实践性质 | 适合的载体 | 原因 |
|----------|-----------|------|
| 独立的操作流程（如"如何申请端口"） | **Skill** | 自包含、可触发、不侵入项目 |
| 行为准则/方法论（如 Karpathy 准则） | **gsd-2 模板** | 需要嵌入到 Agent prompt 中 |
| 架构模式（如 Hermes 自进化、DeerFlow 沙箱） | **知识文档 + 用户反馈** | 需要深度嵌入项目，Agent 无法自动完成 |
| 配置模板（如 tsconfig、ESLint 规则） | **Skill（自动部署）** | 文件级操作，可自动化 |
| 设计模式（如 UI 组件结构） | **结晶文件（crystal）** | 项目匹配时推荐 |

##### Skill 能承载的（✅）

- 触发式操作流程（用户说一句话 → Agent 按步骤执行）
- 配置文件的生成/部署
- 代码模板的脚手架（scaffold）
- 工具调用的封装（如 SOTAgent 通信协议）

##### Skill 不能承载的（❌）

- **架构级重构**：如"引入沙箱隔离机制"，需要改动项目的目录结构、进程模型、通信方式
- **深度嵌入的模式**：如"自进化架构"，需要改动 Agent 的核心循环逻辑
- **跨文件/跨模块的设计变更**：如"将所有 API 改为事件驱动"

##### 架构级改动的处理方式

当 SOTAgent 检测到某个先进实践属于"架构级"（`type: architecture` 且 `requires_deep_integration: true`），
不尝试自动部署，而是生成**改动建议报告**推送给用户：

```json
{
  "type": "sync_notification",
  "payload": {
    "action": "architecture_recommendation",
    "asset_id": "architecture:hermes-self-evolution",
    "target_projects": ["PolarPrivate", "ai-daily-digest"],
    "recommendation": {
      "summary": "Hermes 自进化架构可提升 Agent 的自我改进能力",
      "changes_required": [
        "在 Agent 主循环中增加'效能自评'步骤",
        "创建 profiling 数据存储层",
        "增加自进化触发阈值检测"
      ],
      "affected_files": ["src/agent-loop.ts", "src/profiling/", "config.json"],
      "effort_estimate": "中等（2-4 小时）",
      "priority": "建议",
      "how_to_apply": "在目标项目中用 IDE Agent（$gsd2-ide-solo）逐项实施"
    }
  }
}
```

用户收到报告后，可以在具体项目中用 IDE 进行修改。

#### 步骤 5: 装载

三种装载方式（根据步骤 4 的载体选择）：

**自动装载**（Skill 和 config 类型）：
- SOTAgent 检测到新的 config/skill 类型 tech_asset → 直接部署到目标项目
- 部署方式：创建软链接或复制文件到 `~/.codex/skills/` 或项目的 `.cursor/skills/`

**模板更新**（methodology 类型）：
- 修改 gsd-2 的模板文件（如 worker-prompt.template.md 的行为准则段落）
- 提交到 gsd-2 仓库 → 各项目下次 `git pull` 时自动生效

**用户反馈**（architecture 和需要深度集成的 pattern 类型）：
- SOTAgent 生成改动建议报告到 outbox
- 用户在 IDE 中查看报告，决定是否实施
- 实施时使用 `$gsd2-ide-solo` 在具体项目中执行

#### 步骤 6: 同步

更新后的联动同步（防止"更新这个忘了那个"）：

```json
{
  "type": "sync_request",
  "payload": {
    "asset_id": "methodology:karpathy-rules",
    "version": 2,
    "change_summary": "新增 Surgical Changes 准则",
    "related_categories": ["architecture", "pattern"],
    "cross_update_hints": [
      {
        "category": "architecture",
        "hint": "检查项目目录结构是否允许精确修改（模块化是否足够）"
      },
      {
        "category": "pattern",
        "hint": "代码模式是否遵循最小修改原则（函数粒度是否合适）"
      }
    ]
  }
}
```

SOTAgent 收到后：
1. 同步主资产到所有订阅项目
2. 扫描 `related_categories` 中的现有资产
3. 将 `cross_update_hints` 推送给对应类别的资产维护者
4. 在 outbox 中生成联动更新建议

### 实践索引（当前已集成）

| ID | 类别 | 名称 | 版本 | 来源 |
|----|------|------|------|------|
| `methodology:karpathy-ai-rules` | methodology | Karpathy AI 工作准则 | 1 | Twitter/X |
| `framework:gsd2` | framework | gsd-2 多 Agent 协作 | 2.x | 自研 |
| `architecture:sotagent-daemon` | architecture | SOTAgent 守护进程架构 | 1 | 自研 |

### 未来集成候选

| 来源 | 类别 | 待提炼内容 |
|------|------|-----------|
| Hermes | architecture | 自进化架构、Agent 自评估 |
| DeerFlow | architecture | 沙箱管理、隔离执行 |
| Claude/Cursor Best Practices | methodology | 长 context 管理、工具调用优化 |
| Agentic Coding Patterns | pattern | Agent 代码生成的最佳实践 |
