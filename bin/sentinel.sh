#!/bin/bash
# sentinel.sh — SOTAgent 哨兵进程
#
# 监听 inbox/ 目录变化，检测到新文件时启动 Node.js 处理。
# 双重保障：fswatch 实时监听 + 定时轮询兜底。
# 由 launchd 管理，崩溃自动重启。
#
# 注意：此文件是仓库源码 (~/Polarisor/SOTAgent/)。install.sh 会复制到 ~/.sotagent/。
# 请勿在 ~/.sotagent/ 中直接编辑，改动应在仓库源码中进行。

set -eo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SOTAGENT_DIR="$(dirname "$SCRIPT_DIR")"
INBOX_DIR="$HOME/.sotagent/inbox"
LOG_DIR="$SOTAGENT_DIR/data/logs"
LOCK_FILE="$SOTAGENT_DIR/data/.sentinel.lock"
CONFIG_FILE="$SOTAGENT_DIR/config.json"
TSX="$SOTAGENT_DIR/node_modules/.bin/tsx"

mkdir -p "$INBOX_DIR" "$LOG_DIR"

# ─── 设备标识 ─────────────────────────────────────────────

DEVICE_ID="${SOTAGENT_DEVICE_ID:-$(hostname -s)}"
export SOTAGENT_DEVICE_ID="$DEVICE_ID"

# ─── 防重复启动 ──────────────────────────────────────────

if [ -f "$LOCK_FILE" ]; then
  OLD_PID=$(cat "$LOCK_FILE" 2>/dev/null || echo "")
  if [ -n "$OLD_PID" ] && kill -0 "$OLD_PID" 2>/dev/null; then
    echo "[sentinel] 已有哨兵在运行 (PID $OLD_PID)，退出"
    exit 0
  fi
fi
echo $$ > "$LOCK_FILE"
trap 'rm -f "$LOCK_FILE"' EXIT INT TERM

# ─── 日志函数 ─────────────────────────────────────────────

LOG_FILE="$LOG_DIR/sentinel-$(date +%Y%m%d).log"

log() {
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] [sentinel/$DEVICE_ID] $*" | tee -a "$LOG_FILE"
}

# ─── 处理 inbox ──────────────────────────────────────────

process_inbox() {
  local found=0
  for f in "$INBOX_DIR"/*/*.json; do
    [ -f "$f" ] || continue
    found=1
    log "发现新消息: $f"
  done

  if [ "$found" -eq 1 ]; then
    log "启动 Node.js 处理 inbox..."
    cd "$SOTAGENT_DIR"
    "$TSX" src/cli.ts process-inbox 2>&1 | tee -a "$LOG_FILE" || {
      log "处理 inbox 失败 (exit $?), 将在下次轮询重试"
    }
  fi
}

# ─── GitHub 同步 ─────────────────────────────────────────
# 本地 ~/.sotagent/ 与仓库之间的 inbox/outbox 同步 (通过 git)

sync_github() {
  "$TSX" src/cli.ts github-sync 2>&1 | tee -a "$LOG_FILE" || true
}

prune_dead_agents() {
  cd "$SOTAGENT_DIR"
  "$TSX" src/cli.ts agent-prune 2>&1 | tee -a "$LOG_FILE" || true
}

# ─── 定时调度检查 ─────────────────────────────────────────

check_scheduler() {
  cd "$SOTAGENT_DIR"
  "$TSX" src/cli.ts schedule 2>&1 | tee -a "$LOG_FILE" || true
}

# ─── 读取配置 ─────────────────────────────────────────────

POLL_INTERVAL=30
USE_FSWATCH=true

if [ -f "$CONFIG_FILE" ]; then
  POLL_INTERVAL=$(python3 -c "import json; c=json.load(open('$CONFIG_FILE')); print(c.get('sentinel',{}).get('poll_interval_sec',30))" 2>/dev/null || echo 30)
  USE_FSWATCH=$(python3 -c "import json; c=json.load(open('$CONFIG_FILE')); print(str(c.get('sentinel',{}).get('use_fswatch',True)).lower())" 2>/dev/null || echo "true")
fi

log "启动哨兵 — 设备: $DEVICE_ID, 轮询间隔: ${POLL_INTERVAL}s, fswatch: $USE_FSWATCH"

# ─── 主循环 ──────────────────────────────────────────────

CYCLE=0

if [ "$USE_FSWATCH" = "true" ] && command -v fswatch >/dev/null 2>&1; then
  log "使用 fswatch 模式（实时监听 + 定时兜底）"

  fswatch -r --event Created --event Updated --event Renamed \
    --latency 2 "$INBOX_DIR" 2>/dev/null | while read -r _event; do
    log "fswatch 检测到 inbox 变化"
    process_inbox
  done &
  FSWATCH_PID=$!
  trap 'kill $FSWATCH_PID 2>/dev/null; rm -f "$LOCK_FILE"' EXIT INT TERM

  while true; do
    sleep "$POLL_INTERVAL"
    CYCLE=$((CYCLE + 1))

    sync_github
    process_inbox

    if [ $((CYCLE % 2)) -eq 0 ]; then
      check_scheduler
    fi

    if [ $((CYCLE % 2880)) -eq 0 ]; then
      find "$LOG_DIR" -name "sentinel-*.log" -mtime +7 -delete 2>/dev/null || true
    fi
  done
else
  log "使用纯轮询模式（无 fswatch）"

  while true; do
    CYCLE=$((CYCLE + 1))

    sync_github
    process_inbox

    if [ $((CYCLE % 2)) -eq 0 ]; then
      check_scheduler
    fi

    if [ $((CYCLE % 2880)) -eq 0 ]; then
      find "$LOG_DIR" -name "sentinel-*.log" -mtime +7 -delete 2>/dev/null || true
    fi

    sleep "$POLL_INTERVAL"
  done
fi
