#!/bin/bash
# Register managed services with PolarProcess (process authority).
# Commands must NOT hardcode ports — Start/start.sh scripts claim via PolarPort.
#
# Usage: bash scripts/register-all-services.sh
#
# Preferred ports must end in 0 or 5 (PolarPort compliance). Snapshot values
# below are for registration metadata / health_endpoint only; runtime ports
# come from claim_port inside each Start script.

set -euo pipefail

POLARPROCESS_URL="${POLARPROCESS_URL:-http://127.0.0.1:11055}"
API="${POLARPROCESS_URL}/api/services"
DEVICE="${SOTAGENT_DEVICE_ID:-$(hostname -s 2>/dev/null || hostname)}"

register() {
  local resp
  resp=$(curl -s -X POST "$API" -H "Content-Type: application/json" -d "$1" 2>&1) || true
  local name
  name=$(echo "$1" | python3 -c "import sys,json; print(json.load(sys.stdin)['name'])" 2>/dev/null || echo "?")
  echo "  $name → $resp"
}

echo "=== Registering services with PolarProcess (${API}) ==="

# ─── PolarPrivate ─────────────────────────────────────
register '{
  "id": "privportal-backend",
  "name": "PolarPrivate Backend",
  "command": "bash Start/start.sh start",
  "work_dir": "~/Polarisor/PolarPrivate/backend",
  "port": 12790,
  "device_id": "'"$DEVICE"'",
  "auto_start": true,
  "restart_on_failure": true,
  "max_restarts": 10,
  "health_check_url": "http://127.0.0.1:12790/health",
  "start_script_dir": "~/Polarisor/PolarPrivate/backend/Start"
}'

register '{
  "id": "privportal-frontend",
  "name": "PolarPrivate Frontend",
  "command": "node node_modules/vite/bin/vite.js preview --host 127.0.0.1 --port ${PORT:-12795} --strictPort",
  "work_dir": "~/Polarisor/PolarPrivate/frontend",
  "port": 12795,
  "device_id": "'"$DEVICE"'",
  "auto_start": true,
  "restart_on_failure": true,
  "max_restarts": 10,
  "health_check_url": "http://127.0.0.1:12795",
  "start_script_dir": "-"
}'

# ─── PolarClaw ────────────────────────────────────────
register '{
  "id": "polarclaw",
  "name": "PolarClaw Agent",
  "command": "PORT=${PORT:-3910} npm start",
  "work_dir": "~/Polarisor/PolarClaw",
  "port": 3910,
  "device_id": "'"$DEVICE"'",
  "auto_start": true,
  "restart_on_failure": true,
  "max_restarts": 30,
  "health_check_url": "http://127.0.0.1:3910/api/health",
  "start_script_dir": "-"
}'

# ─── PolarClock ───────────────────────────────────────
register '{
  "id": "polarclock-backend",
  "name": "PolarClock Backend",
  "command": "bash Start/start.sh start",
  "work_dir": "~/Polarisor/Clock/backend",
  "port": 15550,
  "device_id": "'"$DEVICE"'",
  "auto_start": false,
  "restart_on_failure": true,
  "max_restarts": 10,
  "health_check_url": "http://127.0.0.1:15550/api/health",
  "start_script_dir": "~/Polarisor/Clock/backend/Start"
}'

register '{
  "id": "polarclock-frontend",
  "name": "PolarClock Frontend (deprecated — use :15550 only)",
  "command": "bash Start/start.sh start",
  "work_dir": "~/Polarisor/Clock/frontend",
  "port": 4555,
  "device_id": "'"$DEVICE"'",
  "auto_start": false,
  "restart_on_failure": false,
  "max_restarts": 0,
  "health_check_url": "http://127.0.0.1:4555/clock/",
  "start_script_dir": "~/Polarisor/Clock/frontend/Start"
}'

# ─── AutoOffice ─────────────────────────────────────────
register '{
  "id": "autooffice",
  "name": "AutoOffice",
  "command": "node dist/cli.js serve -p ${PORT:-3900}",
  "work_dir": "~/Polarisor/AutoOffice",
  "port": 3900,
  "device_id": "'"$DEVICE"'",
  "auto_start": true,
  "restart_on_failure": true,
  "max_restarts": 10,
  "health_check_url": "http://127.0.0.1:3900/health",
  "start_script_dir": "-"
}'

# ─── KnowLever ────────────────────────────────────────
register '{
  "id": "knowlever-rag",
  "name": "KnowLever RAG API",
  "command": "bash Start/start-rag.sh",
  "work_dir": "~/Polarisor/KnowLever",
  "port": 18080,
  "device_id": "'"$DEVICE"'",
  "auto_start": true,
  "restart_on_failure": true,
  "max_restarts": 10,
  "health_check_url": "http://127.0.0.1:18080/api/health",
  "start_script_dir": "-"
}'

register '{
  "id": "knowlever-wiki",
  "name": "KnowLever Wiki Server",
  "command": "bash Start/start-wiki.sh",
  "work_dir": "~/Polarisor/KnowLever",
  "port": 18085,
  "device_id": "'"$DEVICE"'",
  "auto_start": true,
  "restart_on_failure": true,
  "max_restarts": 10,
  "health_check_url": "http://127.0.0.1:18085",
  "start_script_dir": "-"
}'

# ─── DiGist API ───────────────────────────────────────
register '{
  "id": "digist",
  "name": "DiGist API",
  "command": "bash Start/start.sh start",
  "work_dir": "~/Polarisor/digist",
  "port": 3800,
  "device_id": "'"$DEVICE"'",
  "auto_start": true,
  "restart_on_failure": true,
  "max_restarts": 10,
  "health_check_url": "http://127.0.0.1:3800/api/health",
  "start_script_dir": "~/Polarisor/digist/Start"
}'

# ─── DiGist Engine (no HTTP port) ─────────────────────
register '{
  "id": "digist-engine",
  "name": "DiGist Engine",
  "command": "npm run start",
  "work_dir": "~/Polarisor/digist",
  "device_id": "'"$DEVICE"'",
  "auto_start": true,
  "restart_on_failure": true,
  "max_restarts": 5,
  "start_script_dir": "-"
}'

# ─── SOTAgent Console ─────────────────────────────────
register '{
  "id": "sotagent-console",
  "name": "SOTAgent Console",
  "command": "node node_modules/vite/bin/vite.js preview --port ${PORT:-4880} --host 127.0.0.1 --strictPort",
  "work_dir": "~/Polarisor/SOTAgent/console",
  "port": 4880,
  "device_id": "'"$DEVICE"'",
  "auto_start": true,
  "restart_on_failure": true,
  "max_restarts": 5,
  "start_script_dir": "-"
}'

# ─── TqSdk Data Collector ─────────────────────────────
register '{
  "id": "tqsdk-data-collector",
  "name": "TqSdk Data Collector",
  "command": "bash Start/start.sh start",
  "work_dir": "~/Polarisor/tqsdk",
  "port": 18900,
  "device_id": "'"$DEVICE"'",
  "auto_start": true,
  "restart_on_failure": true,
  "max_restarts": 10,
  "health_check_url": "http://127.0.0.1:18900/health",
  "start_script_dir": "~/Polarisor/tqsdk/Start"
}'

# ─── TqSdk Gateway (preferred 12890 — was 12891, non-compliant) ─
register '{
  "id": "tqsdk-gateway",
  "name": "TqSdk Gateway",
  "command": "bash Start/start.sh start",
  "work_dir": "~/Polarisor/tqsdk/tqsdk-gateway",
  "port": 12890,
  "device_id": "'"$DEVICE"'",
  "auto_start": false,
  "restart_on_failure": true,
  "max_restarts": 5,
  "health_check_url": "http://127.0.0.1:12890/health",
  "start_script_dir": "~/Polarisor/tqsdk/tqsdk-gateway/Start"
}'

# ─── PolarFlow ────────────────────────────────────────
register '{
  "id": "polarflow-api",
  "name": "PolarFlow API",
  "command": "env POLARFLOW_EDITOR_ROOT=examples npm run server",
  "work_dir": "~/Polarisor/PolarFlow",
  "port": 8120,
  "device_id": "'"$DEVICE"'",
  "auto_start": true,
  "restart_on_failure": true,
  "max_restarts": 10,
  "health_check_url": "http://127.0.0.1:8120/api/llm/health",
  "start_script_dir": "-"
}'

register '{
  "id": "polarflow-editor",
  "name": "PolarFlow Editor",
  "command": "npx vite --host 127.0.0.1 --port 8125 --strictPort",
  "work_dir": "~/Polarisor/PolarFlow/editor",
  "port": 8125,
  "device_id": "'"$DEVICE"'",
  "auto_start": true,
  "restart_on_failure": true,
  "max_restarts": 10,
  "health_check_url": "http://127.0.0.1:8125",
  "start_script_dir": "-"
}'

# ─── PolarTrade ───────────────────────────────────────
register '{
  "id": "polartrade-api",
  "name": "PolarTrade API",
  "command": ".venv/bin/python -m uvicorn app.main:app --host 127.0.0.1 --port ${PORT:-8000}",
  "work_dir": "~/Polarisor/tqsdk/trading-platform/apps/api",
  "port": 8000,
  "device_id": "'"$DEVICE"'",
  "auto_start": true,
  "restart_on_failure": true,
  "max_restarts": 5,
  "health_check_url": "http://127.0.0.1:8000/healthz",
  "start_script_dir": "-"
}'

register '{
  "id": "polartrade-web",
  "name": "PolarTrade Web",
  "command": "node node_modules/.bin/vite preview --host 127.0.0.1 --port ${PORT:-6130} --strictPort",
  "work_dir": "~/Polarisor/tqsdk/trading-platform/apps/web",
  "port": 6130,
  "device_id": "'"$DEVICE"'",
  "auto_start": true,
  "restart_on_failure": true,
  "max_restarts": 5,
  "health_check_url": "http://127.0.0.1:6130",
  "start_script_dir": "-"
}'

echo ""
echo "=== Done. Verify with: curl -s ${POLARPROCESS_URL}/api/services | python3 -m json.tool ==="
