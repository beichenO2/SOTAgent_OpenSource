# Knowledge Tree

- project: SOTAgent
- generated_at: 2026-05-02T17:44:27.900Z

## 关键设计

- reference/ (`readme`)
- 项目参考资料的目录组织规范 (`src-20260502-readme`)
  - reference 目录用于集中存放只读的参考项目、SOTA 对标材料和外部技术文档，与项目源代码分离管理。其中可包含开源项目、论文、技术博客摘录等内容；对于大文件建议使用 Git LFS 存储或仅保留外部链接以节省仓库空间。
- reference 目录 (`entity-reference-directory`)
  - 项目仓库中用于集中存放只读参考资料的专用目录，可收纳开源项目、论文、技术博客等外部学习材料，与源代码分离管理。
- Git LFS (`concept-git-lfs`)
  - Git LFS 是 Git 的扩展工具，通过将大文件内容存储在远程服务器上，只在仓库中保留指针文件，从而高效管理大型二进制文件，避免仓库体积膨胀。
- 参考资料管理规范 (`concept-reference-mgmt`)
  - 通过独立目录隔离只读参考资料与源代码的项目组织方式，以提升仓库可维护性和团队协作效率。

## 总体设计

- 总体设计/concept (`overall-concept`)
  - 由 3 个关键设计节点抽象而来
- 总体设计/source (`overall-source`)
  - 由 1 个关键设计节点抽象而来
- 总体设计/entity (`overall-entity`)
  - 由 1 个关键设计节点抽象而来

## 一般逻辑

- 这类项目的一般逻辑 (`general-logic-core`)
  - 从多个总体设计层抽象出的通用逻辑骨架
  - 从 source/concept/entity 页面抽取可复用结构
  - 按问题-方法-约束组织知识层次
  - 优先沉淀可被 Agent 复用的设计规则

