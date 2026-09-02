#!/bin/bash
# Focused verification for the two JA Office launchd agents:
#   dev.ja-office.app             127.0.0.1:3000
#   dev.ja-office.hermes-backend  127.0.0.1:9137
#
#   scripts/launchd/verify-ja-office-stack.sh                 # checks only
#   scripts/launchd/verify-ja-office-stack.sh --app-only
#   scripts/launchd/verify-ja-office-stack.sh --backend-only  # legacy backend scope
#   scripts/launchd/verify-ja-office-stack.sh --restart-test
#     additionally kills each in-scope service PID and asserts launchd brings a
#     different PID back within 30s, with the HTTP/ws surface healthy again.
#
# Only touches the two labels above. Never restarts port 9120 or Hermes
# Desktop, never kills a listener that is not the tracked service PID, and
# never prints tokens.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="${JA_OFFICE_ROOT:-$(cd "$SCRIPT_DIR/../.." && pwd)}"
# shellcheck source=lib.sh
. "$SCRIPT_DIR/lib.sh"

APP_LABEL="dev.ja-office.app"
BE_LABEL="dev.ja-office.hermes-backend"
APP_PORT="${JA_OFFICE_APP_PORT:-3000}"
BE_PORT="${JA_OFFICE_BACKEND_PORT:-9137}"
APP_URL="http://127.0.0.1:$APP_PORT/"
BE_URL="http://127.0.0.1:$BE_PORT/api/status"

CHECK_APP=1
CHECK_BE=1
RESTART_TEST=0
for arg in "$@"; do
  case "$arg" in
    --app-only) CHECK_BE=0 ;;
    --backend-only) CHECK_APP=0 ;;
    --restart-test) RESTART_TEST=1 ;;
    *) echo "unknown argument: $arg" >&2; exit 2 ;;
  esac
done

FAILED=0
pass() { echo "PASS  $*"; }
fail() { echo "FAIL  $*"; FAILED=1; }

http_code() { curl -s -o /dev/null -w '%{http_code}' -L --max-time 15 "$1"; }
probe_ws() { node "$REPO_ROOT/scripts/probe-gateway-ws.mjs" 2>&1 | head -1; }

check_label() {
  local label="$1" pid
  if svc_loaded "$label"; then
    pid="$(svc_pid "$label")"
    pass "$label loaded in $LAUNCHD_DOMAIN (pid=${pid:-none})"
  else
    fail "$label not loaded in $LAUNCHD_DOMAIN"
  fi
}

# The listener on the fixed port must be the launchd job itself — an orphan
# holding the port is exactly the failure mode this whole setup exists to stop.
check_listener() {
  local label="$1" port="$2" pids spid
  pids="$(listen_pids "$port" | tr '\n' ' ')"
  pids="${pids% }"
  spid="$(svc_pid "$label")"
  if [ -z "$pids" ]; then
    fail "nothing listening on 127.0.0.1:$port"
  elif [ "$pids" = "$spid" ]; then
    pass "127.0.0.1:$port LISTEN pid=$pids == $label service pid"
  else
    fail "127.0.0.1:$port LISTEN pid=[$pids] but $label service pid=${spid:-none}"
    for p in $pids; do describe_pid "$p"; done
  fi
}

check_http() {
  local url="$1" code
  code="$(http_code "$url")"
  [ "$code" = "200" ] && pass "$url $code" || fail "$url $code"
}

# ok:true alone is not enough — the demo adapter answers it too. The frame has
# to come back from the hermes-agent adapter, which is the thing on 9137.
ws_ok() {
  case "$1" in
    *'"ok":true'*) ;;
    *) return 1 ;;
  esac
  case "$1" in
    *'"adapterType":"hermes-agent"'*) return 0 ;;
    *) return 1 ;;
  esac
}

check_ws() {
  local frame
  frame="$(probe_ws)"
  if ws_ok "$frame"; then
    pass "probe-gateway-ws ok=true adapterType=hermes-agent"
  else
    fail "probe-gateway-ws: $frame"
  fi
}

# Kill only the PID launchd reports for this label, then assert KeepAlive
# replaces it with a different PID inside the bound.
restart_test() {
  local label="$1" port="$2" url="$3" old new i
  old="$(svc_pid "$label")"
  if [ -z "$old" ]; then
    fail "$label: no service pid to restart-test"
    return
  fi
  kill "$old" 2>/dev/null || true
  new=""
  for i in $(seq 1 30); do
    sleep 1
    new="$(svc_pid "$label")"
    [ -n "$new" ] && [ "$new" != "$old" ] && break
  done
  if [ -n "$new" ] && [ "$new" != "$old" ]; then
    pass "$label KeepAlive restarted: $old -> $new"
  else
    fail "$label: no new pid within 30s (old=$old new=${new:-none})"
    return
  fi
  for i in $(seq 1 40); do
    sleep 1
    [ -n "$(listen_pids "$port")" ] && break
  done
  # The replacement process must be the one on the port. A restart that leaves
  # the old child squatting is exactly the failure we are guarding against.
  check_listener "$label" "$port"
  local code
  code="$(http_code "$url")"
  [ "$code" = "200" ] && pass "$label post-restart $url $code" \
    || fail "$label post-restart $url $code"
}

echo "== launchd service state =="
[ "$CHECK_APP" = "1" ] && check_label "$APP_LABEL"
[ "$CHECK_BE" = "1" ] && check_label "$BE_LABEL"

echo "== fixed-port listeners =="
[ "$CHECK_APP" = "1" ] && check_listener "$APP_LABEL" "$APP_PORT"
[ "$CHECK_BE" = "1" ] && check_listener "$BE_LABEL" "$BE_PORT"

echo "== HTTP =="
# The ws probe rides on the app, so the app URL is checked in both scopes.
check_http "$APP_URL"
[ "$CHECK_BE" = "1" ] && check_http "$BE_URL"

echo "== gateway websocket (app -> backend) =="
check_ws

if [ "$RESTART_TEST" = "1" ]; then
  echo "== KeepAlive restart test =="
  [ "$CHECK_APP" = "1" ] && restart_test "$APP_LABEL" "$APP_PORT" "$APP_URL"
  [ "$CHECK_BE" = "1" ] && restart_test "$BE_LABEL" "$BE_PORT" "$BE_URL"
  echo "== post-restart websocket =="
  frame=""
  for _ in $(seq 1 6); do
    frame="$(probe_ws)"
    ws_ok "$frame" && break
    sleep 3
  done
  if ws_ok "$frame"; then
    pass "post-restart probe ok=true adapterType=hermes-agent"
  else
    fail "post-restart probe: $frame"
  fi
fi

echo
if [ "$FAILED" = "0" ]; then
  echo "ALL CHECKS PASSED"
else
  echo "SOME CHECKS FAILED"
fi
exit "$FAILED"
