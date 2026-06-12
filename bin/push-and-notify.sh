#!/usr/bin/env bash
# push-and-notify.sh — git push + PeerSync 自动通知对端
#
# 用法:
#   push-and-notify.sh [project_name]
#
#   project_name: 可选，默认从 git remote 推断
#
# 流程:
#   1. git push origin HEAD
#   2. POST /api/peer/notify-push → 通知对端 SOTAgent 立即 auto-pull
#
# 可以在任何 Polarisor 子项目目录中运行。

set -euo pipefail

PORTS_FILE="$HOME/.sotagent/ports.json"
if [ -f "$PORTS_FILE" ] && command -v python3 &>/dev/null; then
  _PORT=$(python3 -c "import json; print(json.load(open('$PORTS_FILE'))['sotagent_api'])" 2>/dev/null || echo 4800)
else
  _PORT=4800
fi
SOTAGENT_API="http://127.0.0.1:${_PORT}"

# 推断项目名称
if [ -n "${1:-}" ]; then
  PROJECT="$1"
else
  # 从 git remote URL 提取仓库名
  REMOTE_URL=$(git remote get-url origin 2>/dev/null || echo "")
  if [ -z "$REMOTE_URL" ]; then
    echo "❌ 当前目录不是 git 仓库或没有 origin remote"
    exit 1
  fi
  PROJECT=$(basename "$REMOTE_URL" .git)
fi

echo "📤 正在推送 $PROJECT..."

# Step 1: git push
if git push origin HEAD 2>&1; then
  echo "✅ git push 成功"
else
  echo "❌ git push 失败"
  exit 1
fi

# Step 2: 通知对端
echo "📡 正在通知对端 SOTAgent..."
RESP=$(curl -sf -X POST "$SOTAGENT_API/api/peer/notify-push" \
  -H 'Content-Type: application/json' \
  -d "{\"project\":\"$PROJECT\"}" 2>/dev/null || echo '{"ok":false,"message":"SOTAgent 不可达"}')

OK=$(echo "$RESP" | python3 -c "import json,sys; print(json.load(sys.stdin).get('ok', False))" 2>/dev/null || echo "False")
MSG=$(echo "$RESP" | python3 -c "import json,sys; print(json.load(sys.stdin).get('message', '未知'))" 2>/dev/null || echo "解析失败")

if [ "$OK" = "True" ]; then
  echo "✅ 对端已通知: $MSG"
else
  echo "⚠️ 对端通知失败: $MSG (push 已完成，对端会在下次心跳时自动拉取)"
fi
