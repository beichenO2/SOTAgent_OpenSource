#!/bin/bash
# SOTAgent 一键启动脚本 — 同时启动 守护进程 + Web API + 前端控制台
# 用于开发环境，生产环境使用 bin/install.sh 注册 launchd 服务

set -eo pipefail

DIR="$(cd "$(dirname "$0")" && pwd)"

echo "========================================"
echo "  SOTAgent — 启动所有服务"
echo "========================================"

if [ ! -d "$DIR/node_modules" ]; then
  echo "  → 安装后端依赖..."
  cd "$DIR" && npm install --silent
fi

if [ ! -d "$DIR/console/node_modules" ]; then
  echo "  → 安装前端依赖..."
  cd "$DIR/console" && npm install --silent
fi

PORTS_FILE="$HOME/.sotagent/ports.json"
CONFIG_FILE="$DIR/config.json"

if command -v python3 &>/dev/null; then
  API_PORT=$(python3 -c "import json; print(json.load(open('$CONFIG_FILE'))['ports']['sotagent_api'])" 2>/dev/null || echo 4800)
  CONSOLE_PORT=$(python3 -c "import json; print(json.load(open('$CONFIG_FILE'))['ports']['sotagent_console'])" 2>/dev/null || echo 4805)
else
  API_PORT=4800
  CONSOLE_PORT=4805
fi

# Kill existing SOTAgent web.ts processes to prevent zombie accumulation
EXISTING_PIDS=$(lsof -ti:$API_PORT 2>/dev/null || true)
if [ -n "$EXISTING_PIDS" ]; then
  echo "  → 停止旧进程 (port $API_PORT): $EXISTING_PIDS"
  echo "$EXISTING_PIDS" | xargs kill -9 2>/dev/null || true
  sleep 1
fi

echo "  → 启动 Web API (port $API_PORT)..."
cd "$DIR" && npx tsx src/web.ts &
WEB_PID=$!
sleep 1

echo "  → 启动前端控制台 (port $CONSOLE_PORT)..."
cd "$DIR/console" && npx vite preview --port "$CONSOLE_PORT" --host 0.0.0.0 --strictPort &
UI_PID=$!

echo ""
echo "  Web 控制台: http://localhost:$CONSOLE_PORT"
echo "  Web API:    http://127.0.0.1:$API_PORT"
echo ""
echo "  按 Ctrl+C 停止所有服务"

trap "kill $WEB_PID $UI_PID 2>/dev/null; echo '已停止'" EXIT
wait
