#!/usr/bin/env bash
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/.." && pwd)

fail() {
  printf 'FAIL: %s\n' "$*" >&2
  exit 1
}

assert_contains() {
  local file=$1 text=$2
  grep -Fq "$text" "$file" || fail "$file does not contain $text"
}

assert_not_contains() {
  local file=$1 pattern=$2
  if grep -En "$pattern" "$file"; then
    fail "$file contains forbidden runtime behavior"
  fi
}

for launcher in "$ROOT/Start/api.sh" "$ROOT/Start/console.sh"; do
  [ -x "$launcher" ] || fail "$launcher must exist and be executable"
  assert_contains "$launcher" '127.0.0.1:11050'
  assert_contains "$launcher" '/api/health'
  assert_contains "$launcher" 'port-claim.sh'
  assert_contains "$launcher" 'claim_port'
  assert_contains "$launcher" 'release_port'
  assert_contains "$launcher" 'versions/node/v22'
  assert_contains "$launcher" 'exec '
  assert_not_contains "$launcher" '(^|[[:space:]])(nohup|disown|pkill|killall|kill|lsof)([[:space:]]|$)|PID_FILE|[^&]&[[:space:]]*$'
done

assert_contains "$ROOT/Start/api.sh" 'claim_port "sotagent" "SOTAgent" 4800'
assert_contains "$ROOT/Start/console.sh" 'claim_port "sotagent-console" "SOTAgent" 4880'

for client in start stop restart status; do
  [ -x "$ROOT/Start/$client.sh" ] || fail "Start/$client.sh must be executable"
  assert_contains "$ROOT/Start/$client.sh" '127.0.0.1:11055'
  assert_not_contains "$ROOT/Start/$client.sh" '(^|[[:space:]])(nohup|disown|pkill|killall|kill|lsof)([[:space:]]|$)|PID_FILE|[^&]&[[:space:]]*$'
done
[ -x "$ROOT/Start/version.sh" ] || fail "Start/version.sh must be executable"

assert_not_contains "$ROOT/start.sh" '(^|[[:space:]])(nohup|disown|pkill|killall|kill|lsof)([[:space:]]|$)|PID_FILE|[^&]&[[:space:]]*$'
assert_contains "$ROOT/start.sh" '127.0.0.1:11055'

assert_contains "$ROOT/src/ports.ts" 'process.env.SOTAGENT_API_PORT ?? process.env.PORT'
assert_contains "$ROOT/console/vite.config.ts" 'process.env.SOTAGENT_API_PORT'

assert_contains "$ROOT/scripts/register-runtime.sh" 'start_script_dir: "-"'
assert_contains "$ROOT/scripts/register-runtime.sh" 'sotagent-console'
assert_not_contains "$ROOT/scripts/register-runtime.sh" 'api/services/.*/(start|restart)'
assert_not_contains "$ROOT/scripts/register-runtime.sh" 'command:.*--port'

jq -e '
  .service_management.service_id == "sotagent" and
  .service_management.start_command == "bash Start/api.sh" and
  (.service_management.services | length) == 2 and
  ([.service_management.services[] | .service_id] | sort) == ["sotagent", "sotagent-console"] and
  ([.service_management.services[] | .preferred_port] | sort) == [4800, 4880] and
  all(.service_management.services[]; .auto_start == true)
' "$ROOT/polaris.json" >/dev/null || fail "polaris.json does not declare both governed services"

jq -e '
  .requirements[] | select(.id == "R6")
  | .features[] | select(.name == "runtime_governance")
  | (.status == "in-progress" or .status == "tested" or .status == "blocked" or .status == "done")
' "$ROOT/polaris.json" >/dev/null || fail "runtime_governance SSoT is missing"

printf 'SOTAgent runtime governance contract passed\n'
