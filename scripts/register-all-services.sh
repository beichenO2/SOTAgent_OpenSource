#!/bin/bash
# Register all managed services with SOTAgent ProcessManager.
# Run after SOTAgent restart to populate the shared_services table.
#
# Usage: bash scripts/register-all-services.sh

CONFIG_FILE="$(cd "$(dirname "$0")/.." && pwd)/config.json"
if command -v python3 &>/dev/null; then
  API_PORT=$(python3 -c "import json; print(json.load(open('$CONFIG_FILE'))['ports']['sotagent_api'])" 2>/dev/null || echo 4800)
  CONSOLE_PORT=$(python3 -c "import json; print(json.load(open('$CONFIG_FILE'))['ports']['sotagent_console'])" 2>/dev/null || echo 4880)
else
  API_PORT=4800
  CONSOLE_PORT=4880
fi
API="http://127.0.0.1:${API_PORT}/api/services"
DEVICE="Mac-Studio"

register() {
  local resp
  resp=$(curl -s -X POST "$API" -H "Content-Type: application/json" -d "$1" 2>&1)
  local name
  name=$(echo "$1" | python3 -c "import sys,json; print(json.load(sys.stdin)['name'])" 2>/dev/null)
  echo "  $name → $resp"
}

echo "=== Registering services with SOTAgent ==="

# ─── PolarPrivate ─────────────────────────────────────
register '{
  "id": "privportal-backend",
  "name": "PolarPrivate Backend",
  "command": "PRIVPORTAL_API_PORT=12790 PRIVPORTAL_API_HOST=127.0.0.1 .venv/bin/privportal start",
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
  "command": "node node_modules/vite/bin/vite.js preview --host 127.0.0.1 --port 12795 --strictPort",
  "work_dir": "~/Polarisor/PolarPrivate/frontend",
  "port": 12795,
  "device_id": "'"$DEVICE"'",
  "auto_start": true,
  "restart_on_failure": true,
  "max_restarts": 10,
  "health_check_url": "http://127.0.0.1:12795",
  "start_script_dir": "-"
}'

# ─── PolarClaw (龙虾) ────────────────────────────────────
register '{
  "id": "polarclaw",
  "name": "PolarClaw Agent",
  "command": "bash Start/start.sh start",
  "work_dir": "~/Polarisor/PolarClaw",
  "port": 3910,
  "device_id": "'"$DEVICE"'",
  "auto_start": true,
  "restart_on_failure": true,
  "max_restarts": 30,
  "health_check_url": "http://127.0.0.1:3910/api/status",
  "start_script_dir": "~/Polarisor/PolarClaw/Start"
}'

# ─── AI Daily Digest ──────────────────────────────────
register '{
  "id": "ai-daily-digest",
  "name": "AI Daily Digest Server",
  "command": "/opt/homebrew/bin/node ~/clawd/ai-daily-digest/server/index.js --port 8785 --basePath /Tech_daily --dir ~/clawd/ai-daily-digest/output",
  "work_dir": "~/clawd/ai-daily-digest",
  "port": 8785,
  "device_id": "'"$DEVICE"'",
  "auto_start": true,
  "restart_on_failure": true,
  "max_restarts": 10,
  "health_check_url": "http://127.0.0.1:8785/health"
}'

# ─── PolarClock ───────────────────────────────────────
register '{
  "id": "polarclock-backend",
  "name": "PolarClock Backend",
  "command": "/opt/homebrew/Caskroom/miniforge/base/bin/python3 main.py --port 15550",
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
  "command": "node node_modules/.bin/vite preview --port 4555 --host 0.0.0.0 --strictPort",
  "work_dir": "~/Polarisor/Clock/frontend",
  "port": 4555,
  "device_id": "'"$DEVICE"'",
  "auto_start": false,
  "restart_on_failure": false,
  "max_restarts": 0,
  "health_check_url": "http://127.0.0.1:4555/clock/",
  "start_script_dir": "~/Polarisor/Clock/frontend/Start"
}'

# ─── GSD2 Hub ─────────────────────────────────────────
register '{
  "id": "gsd2-hub",
  "name": "GSD2 Hub",
  "command": "GSD_HUB_PORT=8765 GSD_HUB_DB=~/.gsd2/hub.sqlite /bin/bash ~/.gsd2/start-hub.sh",
  "work_dir": "~/.gsd2/runtime",
  "port": 8765,
  "device_id": "'"$DEVICE"'",
  "auto_start": true,
  "restart_on_failure": true,
  "max_restarts": 10,
  "health_check_url": "http://127.0.0.1:8765/health"
}'

# ─── Claude Code Vis ──────────────────────────────────
register '{
  "id": "claude-code-vis",
  "name": "Claude Code Visualizer",
  "command": "/usr/bin/python3 serve.py ~/workplace/claude-code-vis-server/site",
  "work_dir": "~/workplace/claude-code-vis-server",
  "port": 19120,
  "device_id": "'"$DEVICE"'",
  "auto_start": true,
  "restart_on_failure": true,
  "max_restarts": 10,
  "health_check_url": "http://127.0.0.1:19120"
}'

register '{

# ─── AutoOffice ─────────────────────────────────────────
register '{
  "id": "autooffice",
  "name": "AutoOffice",
  "command": "node dist/cli.js serve -p 3900",
  "work_dir": "~/Polarisor/AutoOffice",
  "port": 3900,
  "device_id": "'"$DEVICE"'",
  "auto_start": true,
  "restart_on_failure": true,
  "max_restarts": 10,
  "health_check_url": "http://127.0.0.1:3900/health"
}'

# ─── KnowLever RAG API ───────────────────────────────
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

# ─── DiGist API (HTTP server, port 3800, PolarPort SSOT) ─
register '{
  "id": "digist",
  "name": "DiGist API",
  "command": "npm run digist-api",
  "work_dir": "~/Polarisor/digist",
  "port": 3800,
  "device_id": "'"$DEVICE"'",
  "auto_start": true,
  "restart_on_failure": true,
  "max_restarts": 10,
  "health_check_url": "http://127.0.0.1:3800/api/health",
  "start_script_dir": "~/Polarisor/digist/Start"
}'

# ─── DiGist Engine (scheduler + evolution; command mode, NOT Start/start.sh) ─
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
  "command": "~/.nvm/versions/node/v20.20.2/bin/node node_modules/vite/bin/vite.js preview --port '"${CONSOLE_PORT}"' --host 127.0.0.1 --strictPort",
  "work_dir": "~/Polarisor/SOTAgent/console",
  "port": '"${CONSOLE_PORT}"',
  "device_id": "'"$DEVICE"'",
  "auto_start": true,
  "restart_on_failure": true,
  "max_restarts": 5
}'

# ─── TqSdk Data Collector ─────────────────────────────
register '{
  "id": "tqsdk-data-collector",
  "name": "TqSdk Data Collector",
  "command": "/opt/homebrew/Caskroom/miniforge/base/bin/python main.py",
  "work_dir": "~/Polarisor/tqsdk/data-collector",
  "port": 18900,
  "device_id": "'"$DEVICE"'",
  "auto_start": true,
  "restart_on_failure": true,
  "max_restarts": 10,
  "health_check_url": "http://127.0.0.1:18900/health"
}'

# ─── PolarTrade (量化交易) ────────────────────────────
register '{
  "id": "polartrade-api",
  "name": "PolarTrade API",
  "command": "~/Polarisor/tqsdk/trading-platform/.venv/bin/python -m uvicorn app.main:app --host 127.0.0.1 --port 8000",
  "work_dir": "~/Polarisor/tqsdk/trading-platform/apps/api",
  "port": 8000,
  "device_id": "'"$DEVICE"'",
  "auto_start": true,
  "restart_on_failure": true,
  "max_restarts": 5,
  "health_check_url": "http://127.0.0.1:8000/healthz"
}'

register '{
  "id": "polartrade-web",
  "name": "PolarTrade Web",
  "command": "/opt/homebrew/bin/node node_modules/.bin/vite preview --host 127.0.0.1 --port 6130 --strictPort",
  "work_dir": "~/Polarisor/tqsdk/trading-platform/apps/web",
  "port": 6130,
  "device_id": "'"$DEVICE"'",
  "auto_start": true,
  "restart_on_failure": true,
  "max_restarts": 5,
  "health_check_url": "http://127.0.0.1:6130"
}'

echo ""
echo "=== Done. Verify with: curl -s http://127.0.0.1:${API_PORT}/api/services | python3 -m json.tool ==="
