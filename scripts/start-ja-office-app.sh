#!/bin/bash
# Start the JA Office app (Next.js production server) on a fixed loopback port.
#
# Usage: scripts/start-ja-office-app.sh [port]     # default 3000
#
# Same command as `npm start` (node server/index.js, no --dev), just with the
# port and host pinned and the paths resolved for launchd's minimal PATH:
#   repo root : $JA_OFFICE_ROOT, else the parent dir of this script
#   node      : $NODE_BIN, else `node` on PATH
# The port is never shifted: if 3000 is taken the server fails and launchd
# retries, which is what we want — a silent move to 3001 breaks every caller.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="${JA_OFFICE_ROOT:-$(cd "$SCRIPT_DIR/.." && pwd)}"
PORT="${1:-${JA_OFFICE_APP_PORT:-3000}}"

NODE="${NODE_BIN:-$(command -v node || true)}"
if [ -z "$NODE" ] || [ ! -x "$NODE" ]; then
  echo "node binary not found (set NODE_BIN)" >&2
  exit 1
fi

if [ ! -f "$REPO_ROOT/.next/BUILD_ID" ]; then
  echo "no production build at $REPO_ROOT/.next — run 'npm run build' first" >&2
  exit 1
fi

cd "$REPO_ROOT"

export PORT="$PORT"
export HOST="127.0.0.1"
export NODE_ENV=production

exec "$NODE" server/index.js
