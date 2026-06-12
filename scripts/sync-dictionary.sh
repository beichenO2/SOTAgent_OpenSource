#!/usr/bin/env bash
# sync-dictionary.sh — 从各项目的致继任者/提取信息，更新项目字典/_index.json 的时间戳
#
# 用法:
#   bash ~/Polarisor/SOTAgent/scripts/sync-dictionary.sh
#   bash ~/Polarisor/SOTAgent/scripts/sync-dictionary.sh --register <项目名> <路径> <角色描述>
#
# 功能:
#   1. 无参数: 更新 _index.json 的 last_updated 时间戳，检查各项目致继任者是否有变更
#   2. --register: 注册新项目到字典（创建 .md + 更新 _index.json）
#   3. --ensure-links: 确保所有已注册项目都有到字典的软链接

set -euo pipefail

DICT_DIR="$HOME/Polarisor/SOTAgent/项目字典"
INDEX_FILE="$DICT_DIR/_index.json"
POLARISOR="$HOME/Polarisor"

update_timestamp() {
  local tmp
  tmp=$(mktemp)
  if command -v python3 &>/dev/null; then
    python3 -c "
import json, sys
from datetime import datetime
with open('$INDEX_FILE', 'r') as f:
    data = json.load(f)
data['_meta']['last_updated'] = datetime.now().strftime('%Y-%m-%d')
with open('$tmp', 'w') as f:
    json.dump(data, f, indent=2, ensure_ascii=False)
"
    mv "$tmp" "$INDEX_FILE"
    echo "✅ _index.json 时间戳已更新"
  else
    echo "⚠️ python3 不可用，跳过时间戳更新"
  fi
}

register_project() {
  local name="$1" path="$2" role="$3"
  local md_file="$DICT_DIR/$name.md"

  if [ -f "$md_file" ]; then
    echo "⚠️ $name.md 已存在，跳过创建（手动编辑更新内容）"
  else
    cat > "$md_file" << HEREDOC
# $name

> 最后更新: $(date +%Y-%m-%d)

## 身份

| 字段 | 值 |
|------|-----|
| **项目名** | $name |
| **路径** | \`$path\` |
| **角色** | $role |
| **技术栈** | (待填写) |

## 职责

(待填写 — 请参考项目的致继任者/接手文档.md)

## 与其他项目的关系

(待填写)

## 当前状态

新注册，待补充详情。
HEREDOC
    echo "✅ 已创建 $md_file"
  fi

  # 更新 _index.json
  if command -v python3 &>/dev/null; then
    python3 -c "
import json
with open('$INDEX_FILE', 'r') as f:
    data = json.load(f)
if '$name' not in data['projects']:
    data['projects']['$name'] = {
        'path': '$path',
        'role': '$role',
        'ports': [],
        'tech': [],
        'status': 'active',
        'depends_on': [],
        'depended_by': []
    }
    from datetime import datetime
    data['_meta']['last_updated'] = datetime.now().strftime('%Y-%m-%d')
    with open('$INDEX_FILE', 'w') as f:
        json.dump(data, f, indent=2, ensure_ascii=False)
    print('✅ _index.json 已添加 $name')
else:
    print('ℹ️  $name 已在 _index.json 中')
"
  fi
}

ensure_links() {
  if ! command -v python3 &>/dev/null; then
    echo "⚠️ python3 不可用"
    return
  fi

  local projects
  projects=$(python3 -c "
import json
with open('$INDEX_FILE', 'r') as f:
    data = json.load(f)
for name, info in data['projects'].items():
    path = info['path'].replace('~/', '$HOME/')
    print(f'{name}|{path}')
")

  while IFS='|' read -r name path; do
    [ -z "$name" ] && continue
    local link_target="$path/项目字典"
    # 跳过 SOTAgent 自身（字典就在自己目录下）
    if [ "$name" = "SOTAgent" ]; then continue; fi
    # 跳过 gsd-2（运行时在 ~/.gsd2/core，源码在 Polarisor）
    if [ "$name" = "gsd-2" ]; then
      link_target="$POLARISOR/gsd-2/项目字典"
    fi

    if [ -L "$link_target" ]; then
      echo "✅ $name: 软链接已存在"
    elif [ -d "$link_target" ]; then
      echo "⚠️ $name: $link_target 是实际目录而非软链接，跳过"
    else
      ln -sf "$DICT_DIR" "$link_target"
      echo "🔗 $name: 创建软链接 $link_target → $DICT_DIR"
    fi
  done <<< "$projects"
}

case "${1:-}" in
  --register)
    [ $# -lt 4 ] && { echo "用法: $0 --register <名称> <路径> <角色>"; exit 1; }
    register_project "$2" "$3" "$4"
    ;;
  --ensure-links)
    ensure_links
    ;;
  *)
    echo "=== 项目字典同步 ==="
    update_timestamp
    ensure_links
    echo "=== 完成 ==="
    ;;
esac
