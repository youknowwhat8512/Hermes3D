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
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="${JA_OFFICE_ROOT:-$(cd "$SCRIPT_DIR/.." && pwd)}"
ENV_FILE="$REPO_ROOT/.env"
MODE="${1:-serve}"
PORT="${2:-9120}"

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
