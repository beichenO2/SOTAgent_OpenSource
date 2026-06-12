#!/bin/bash
# resource-monitor.sh — 系统资源采集器
#
# 每次调用采集一次 CPU/MEM/GPU 快照，写入 resources.sqlite。
# 由 launchd 定时调用（默认每 60 秒），也可手动执行。
# 设计为"跑完就退"，不常驻内存。
#
# 注意：此文件是仓库源码 (~/Polarisor/SOTAgent/)。install.sh 会复制到 ~/.sotagent/。

set -eo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SOTAGENT_DIR="$(dirname "$SCRIPT_DIR")"
TSX="$SOTAGENT_DIR/node_modules/.bin/tsx"

DEVICE_ID="${SOTAGENT_DEVICE_ID:-$(hostname -s)}"
export SOTAGENT_DEVICE_ID="$DEVICE_ID"

cd "$SOTAGENT_DIR"
"$TSX" src/cli.ts monitor-collect 2>&1
