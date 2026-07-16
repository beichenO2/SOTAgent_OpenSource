#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
PROJECT_DIR=$(cd "$SCRIPT_DIR/.." && pwd)
POLARPORT_URL=${POLARPORT_URL:-http://127.0.0.1:11050}
PREFERRED_PORT=4880

if [ "$#" -ne 0 ]; then
  echo "SOTAgent Console lifecycle is managed by PolarProcess; do not pass lifecycle arguments" >&2
  exit 2
fi

if [ -z "${NODE_BIN:-}" ] && [ -d "$HOME/.nvm/versions/node" ]; then
  NODE_DIR=$(ls -d "$HOME"/.nvm/versions/node/v22* 2>/dev/null | sort -V | tail -1 || true)
  if [ -n "$NODE_DIR" ] && [ -x "$NODE_DIR/bin/node" ]; then
    NODE_BIN="$NODE_DIR/bin/node"
  fi
fi
NODE_BIN=${NODE_BIN:-node}
VITE_BIN="$PROJECT_DIR/console/node_modules/vite/bin/vite.js"
if ! command -v "$NODE_BIN" >/dev/null 2>&1; then
  echo "Node executable not found: $NODE_BIN" >&2
  exit 1
fi
if [ ! -f "$PROJECT_DIR/console/dist/index.html" ] || [ ! -f "$VITE_BIN" ]; then
  echo "SOTAgent Console is not built; install dependencies and build console before starting" >&2
  exit 1
fi

if ! curl -fsS --max-time 3 "$POLARPORT_URL/api/health" >/dev/null; then
  echo "PolarPort is unavailable; refusing preferred-port fallback" >&2
  exit 1
fi

source "$HOME/Polarisor/Agent_core/scripts/port-claim.sh"
PORT=$(claim_port "sotagent-console" "SOTAgent" 4880)
if [ "$PORT" -ne "$PREFERRED_PORT" ]; then
  release_port "$PORT"
  echo "PolarPort returned $PORT, but SOTAgent Console SSoT requires preferred port $PREFERRED_PORT" >&2
  exit 1
fi

SOTAGENT_API_PORT=$(curl -fsS --max-time 3 "$POLARPORT_URL/api/list" | python3 -c '
import json, sys
ports = json.load(sys.stdin)
matches = [p["port"] for p in ports if p.get("service_name") == "sotagent" and p.get("project") == "SOTAgent" and p.get("status") == "active"]
if len(matches) != 1:
    raise SystemExit(1)
print(matches[0])
') || {
  release_port "$PORT"
  echo "SOTAgent API has no unique active PolarPort record; refusing an unmanaged proxy target" >&2
  exit 1
}

cd "$PROJECT_DIR/console"
export SOTAGENT_API_PORT
exec "$NODE_BIN" "$VITE_BIN" preview --host 127.0.0.1 --port "$PORT" --strictPort

