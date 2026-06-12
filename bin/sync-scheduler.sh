#!/bin/bash
# sync-scheduler.sh — SOTAgent GitHub 同步调度器
# 由 launchd 每 30 分钟调用一次
# 先采集资源快照，再执行 GitHub 同步巡检

SOTAGENT_DIR="${SOTAGENT_DIR:-$HOME/.sotagent}"
TSX="$SOTAGENT_DIR/node_modules/.bin/tsx"
LOG_FILE="$SOTAGENT_DIR/logs/sync-scheduler.log"

mkdir -p "$(dirname "$LOG_FILE")"

log() {
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] $1" | tee -a "$LOG_FILE"
}

cd "$SOTAGENT_DIR" || { log "ERROR: $SOTAGENT_DIR 不存在"; exit 1; }

if [ ! -x "$TSX" ]; then
  log "ERROR: tsx 不存在，运行 npm install"
  npm install --silent 2>&1 | tail -3
fi

log "开始同步巡检..."

"$TSX" src/cli.ts monitor-collect 2>&1 | tee -a "$LOG_FILE" || true

"$TSX" src/cli.ts github-sync 2>&1 | tee -a "$LOG_FILE" || {
  log "同步巡检失败 (exit $?)"
}

log "同步巡检完成"
