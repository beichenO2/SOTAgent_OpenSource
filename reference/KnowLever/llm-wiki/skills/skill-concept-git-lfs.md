---
title: "Skill: Git LFS"
type: skill
tags: 
date: 2026-05-03
status: draft
confidence: 0.4
source_ids:
  - concept-git-lfs
evidence_pages:
  - concept-git-lfs
---

# Skill: Git LFS

> Distilled from: [[concept-git-lfs]]

## Prerequisites

- Understanding of git lfs fundamentals
- Familiarity with related concepts

## Core Competencies

- **仓库体积膨胀**：每次文件修改都会在 Git 历史中创建一个完整副本，导致仓库体积快速增长
- **克隆和拉取缓慢**：新成员克隆仓库或团队成员拉取更新时，需要下载完整的 Git 历史
- **磁盘空间浪费**：本地仓库副本占用大量磁盘空间
- **网络带宽消耗**：频繁的推送和拉取操作消耗大量网络带宽
- **性能下降**：Git 的压缩和打包操作在大文件场景下效率显著降低
- `version`：LFS 规范版本号，标识指针文件格式
- `oid sha256:<hash>`：大文件内容的 SHA-256 哈希值，用于内容寻址和去重
- `size`：文件的原始字节大小
- 相同内容的文件只存储一份（去重）
- 便于快速查找和验证文件完整性

## Evidence

This skill was distilled from the following sources:
- `src-20260502-readme`

## Verification

- [ ] Skill prerequisites validated
- [ ] Core competencies tested
- [ ] Anti-patterns confirmed with examples
