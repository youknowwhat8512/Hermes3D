#!/bin/bash
# Start the local Hermes backend for Hermes3D, reusing the token stored in
# ja-office/.env. Never prints the token.
#
# Usage: scripts/start-hermes-backend.sh [mode] [port]
#   mode: dashboard | serve (default: serve)
#   port: TCP port on 127.0.0.1 (default: 9120)
#
# Path resolution (in order):
#   repo root   : $JA_OFFICE_ROOT, else the parent dir of this script
#   hermes home : $HERMES_HOME, else $HOME/.hermes (no fallback if HOME is unset)
#   hermes bin  : $HERMES_BIN, else <hermes home>/hermes-agent/venv/bin/hermes,
#                 else `hermes` on PATH
# Both overrides exist so launchd can run this with a minimal PATH.
#
# RESERVED PORT: the office backend port (9137) belongs to the
# dev.ja-office.hermes-backend LaunchAgent alone. A second hand-started backend
# on it wins the bind race, leaves launchd in an EADDRINUSE retry loop, and the
# office then talks to an upstream holding a different session token — HTTP 200
# on both ports while the UI shows "Gateway closed (1011): connect failed".
# Only launchd may start that port; see docs/ops/hermes-backend-launchd.md.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="${JA_OFFICE_ROOT:-$(cd "$SCRIPT_DIR/.." && pwd)}"
ENV_FILE="$REPO_ROOT/.env"
MODE="${1:-serve}"
PORT="${2:-9120}"

RESERVED_PORT="${JA_OFFICE_BACKEND_PORT:-9137}"
RESERVED_LABEL="dev.ja-office.hermes-backend"

# Refuse before reading .env so a rejected run cannot even load the token.
if [ "$PORT" = "$RESERVED_PORT" ] \
   && [ "${JA_OFFICE_LAUNCHD_MANAGED:-}" != "$RESERVED_LABEL" ]; then
  cat >&2 <<EOF
refusing to start: 127.0.0.1:$RESERVED_PORT is owned by the $RESERVED_LABEL
LaunchAgent, and this invocation is not that job.

Starting a second backend here is what produces "Gateway closed (1011):
connect failed" in the office UI: two processes race for the port and the
survivor holds a different session token than the one the app proxies with.

Use the managed paths instead:
  scripts/open-ja-office.sh                        # verify + open the office
  scripts/launchd/install-hermes-backend.sh        # (re)install the service
  launchctl kickstart -k gui/\$(id -u)/$RESERVED_LABEL   # restart it
  scripts/launchd/verify-ja-office-stack.sh        # check ownership + ws

For an unmanaged experiment, pick another port, e.g.:
  $0 $MODE 9199
EOF
  exit 1
fi

if [ ! -f "$ENV_FILE" ]; then
  echo "missing env file: $ENV_FILE" >&2
  exit 1
fi

TOKEN="$(grep '^HERMES3D_GATEWAY_TOKEN=' "$ENV_FILE" | head -1 | cut -d= -f2-)"
if [ -z "$TOKEN" ]; then
  echo "no HERMES3D_GATEWAY_TOKEN in $ENV_FILE" >&2
  exit 1
fi

export HERMES_DASHBOARD_SESSION_TOKEN="$TOKEN"

HERMES_HOME_DIR="${HERMES_HOME:-${HOME:+$HOME/.hermes}}"
if [ -n "${HERMES_BIN:-}" ]; then
  HERMES="$HERMES_BIN"
elif [ -n "$HERMES_HOME_DIR" ] && [ -x "$HERMES_HOME_DIR/hermes-agent/venv/bin/hermes" ]; then
  HERMES="$HERMES_HOME_DIR/hermes-agent/venv/bin/hermes"
else
  HERMES="$(command -v hermes || true)"
fi

if [ -z "$HERMES" ] || [ ! -x "$HERMES" ]; then
  if [ -z "$HERMES_HOME_DIR" ]; then
    echo "hermes binary not found: HERMES_BIN unset and neither HERMES_HOME nor HOME is set" >&2
  else
    echo "hermes binary not found (set HERMES_BIN, or HERMES_HOME/HOME)" >&2
  fi
  exit 1
fi

cd "$REPO_ROOT"

# `hermes serve` is headless and disables the plugin HTTP surface the office
# kanban desk reads, so the dashboard mode is the one that exposes
# /api/plugins/kanban/* on a loopback bind.
if [ "$MODE" = "dashboard" ]; then
  exec "$HERMES" dashboard \
    --host 127.0.0.1 --port "$PORT" --skip-build --no-open --isolated
fi

exec "$HERMES" "$MODE" \
  --host 127.0.0.1 --port "$PORT" --skip-build
