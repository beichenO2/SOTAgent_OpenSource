#!/usr/bin/env bash
set -euo pipefail
POLARPROCESS_URL=${POLARPROCESS_URL:-http://127.0.0.1:11055}
exec curl -fsS -X POST "$POLARPROCESS_URL/api/services/sotagent/start"

