#!/usr/bin/env bash
set -euo pipefail

PROJECT_DIR=$(cd "$(dirname "$0")/.." && pwd)
POLARPROCESS_URL=${POLARPROCESS_URL:-http://127.0.0.1:11055}

register_service() {
  local id=$1 name=$2 command=$3 port=$4 health_url=$5
  local payload
  payload=$(jq -n \
    --arg id "$id" \
    --arg name "$name" \
    --arg command "$command" \
    --arg work_dir "$PROJECT_DIR" \
    --arg health_check_url "$health_url" \
    --argjson port "$port" \
    '{
      id: $id,
      name: $name,
      command: $command,
      work_dir: $work_dir,
      device_id: "any",
      auto_start: true,
      restart_on_failure: true,
      max_restarts: 5,
      port: $port,
      health_check_url: $health_check_url,
      start_script_dir: "-"
    }')
  curl -fsS -X POST "$POLARPROCESS_URL/api/services/register" \
    -H 'Content-Type: application/json' \
    -d "$payload"
  printf '\n'
}

curl -fsS --max-time 3 "$POLARPROCESS_URL/api/health" >/dev/null
register_service sotagent "SOTAgent API" "bash Start/api.sh" 4800 "http://127.0.0.1:4800/api/health"
register_service sotagent-console "SOTAgent Console" "bash Start/console.sh" 4880 "http://127.0.0.1:4880/"

