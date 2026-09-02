#!/bin/bash
# Install the JA Office app (port 3000) as a launchd user agent.
#
#   scripts/launchd/install-ja-office-app.sh              # generate + (re)load
#   scripts/launchd/install-ja-office-app.sh --dry-run    # only print the plist
#   scripts/launchd/install-ja-office-app.sh --adopt-pid 84683
#       cut over from a detached process you have identified as the old app
#
# The plist pins PORT=3000 and HOST=127.0.0.1, holds no secrets, and never
# shifts to another port. A foreign listener on 3000 aborts the install.
# After the app answers 200 it pins the persisted Studio active gateway at
# 127.0.0.1:9137 once, so a launchd restart cannot come back on the demo
# adapter. Startup or pin failure exits nonzero.
set -euo pipefail

LABEL="dev.ja-office.app"
PORT="${JA_OFFICE_APP_PORT:-3000}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="${JA_OFFICE_ROOT:-$(cd "$SCRIPT_DIR/../.." && pwd)}"
# shellcheck source=lib.sh
. "$SCRIPT_DIR/lib.sh"

PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOG_DIR="$REPO_ROOT/logs"
OUT_LOG="$LOG_DIR/launchd-ja-office-app-$PORT.out.log"
ERR_LOG="$LOG_DIR/launchd-ja-office-app-$PORT.err.log"
CMD_REGEX='server/index\.js'

DRY_RUN=0
ADOPT_PID=""
while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY_RUN=1; shift ;;
    --adopt-pid) ADOPT_PID="${2:-}"; shift 2 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

START_SH="$REPO_ROOT/scripts/start-ja-office-app.sh"
if [ ! -f "$START_SH" ]; then
  echo "missing $START_SH" >&2
  exit 1
fi

NODE_BIN_PATH="${NODE_BIN:-$(command -v node || true)}"
if [ -z "$NODE_BIN_PATH" ] || [ ! -x "$NODE_BIN_PATH" ]; then
  echo "node binary not found (set NODE_BIN)" >&2
  exit 1
fi

if [ ! -f "$REPO_ROOT/.next/BUILD_ID" ]; then
  echo "no production build at $REPO_ROOT/.next — run 'npm run build' first" >&2
  exit 1
fi

PLIST_BODY="$(cat <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>$START_SH</string>
    <string>$PORT</string>
  </array>
  <key>WorkingDirectory</key>
  <string>$REPO_ROOT</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>/usr/bin:/bin:/usr/sbin:/sbin</string>
    <key>HOME</key>
    <string>$HOME</string>
    <key>JA_OFFICE_ROOT</key>
    <string>$REPO_ROOT</string>
    <key>NODE_BIN</key>
    <string>$NODE_BIN_PATH</string>
    <key>NODE_ENV</key>
    <string>production</string>
    <key>PORT</key>
    <string>$PORT</string>
    <key>HOST</key>
    <string>127.0.0.1</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>10</integer>
  <key>ProcessType</key>
  <string>Background</string>
  <key>StandardOutPath</key>
  <string>$OUT_LOG</string>
  <key>StandardErrorPath</key>
  <string>$ERR_LOG</string>
</dict>
</plist>
PLIST
)"

if [ "$DRY_RUN" = "1" ]; then
  printf '%s\n' "$PLIST_BODY"
  exit 0
fi

# Free the port (or refuse) before a single file is touched.
prepare_port "$LABEL" "$PORT" "$CMD_REGEX" "$ADOPT_PID"

mkdir -p "$LOG_DIR" "$HOME/Library/LaunchAgents"

TMP_PLIST="$(mktemp -t "$LABEL")"
printf '%s\n' "$PLIST_BODY" > "$TMP_PLIST"
plutil -lint "$TMP_PLIST"

if [ -f "$PLIST" ]; then
  cp "$PLIST" "$PLIST.bak"
  echo "previous plist backed up to $PLIST.bak"
fi

mv "$TMP_PLIST" "$PLIST"
chmod 644 "$PLIST"

launchctl bootstrap "$LAUNCHD_DOMAIN" "$PLIST"
launchctl enable "$LAUNCHD_DOMAIN/$LABEL"
launchctl kickstart "$LAUNCHD_DOMAIN/$LABEL" >/dev/null 2>&1 || true
record_service_pid "$LABEL"

# Wait for the app to actually serve before pinning anything through it.
APP_READY=0
for i in $(seq 1 90); do
  if [ "$(curl -s -o /dev/null -w '%{http_code}' -L --max-time 5 "http://127.0.0.1:$PORT/")" = "200" ]; then
    APP_READY=1
    break
  fi
  sleep 1
done
if [ "$APP_READY" != "1" ]; then
  echo "app did not answer 200 on http://127.0.0.1:$PORT/ within 90s" >&2
  echo "the agent is installed — check $ERR_LOG, then re-run this installer." >&2
  exit 1
fi

# Pin the persisted Studio active gateway at the fixed backend, once, through
# the official PUT /api/studio route (a merge, so unrelated settings survive).
# Without this the saved profile can drift back to the demo adapter on
# ws://localhost:18789 and the browser shows HERMES DISCONNECTED after a
# restart. The helper reads the token from .env and the route strips tokens
# from its response; we discard its stdout regardless and print only the URL.
GATEWAY_URL="http://localhost:${JA_OFFICE_BACKEND_PORT:-9137}"
PIN_RC=0
PIN_OUT="$("$NODE_BIN_PATH" "$REPO_ROOT/scripts/apply-studio-gateway.mjs" \
  "$GATEWAY_URL" "http://127.0.0.1:$PORT" 2>&1)" || PIN_RC=$?
if [ "$PIN_RC" != "0" ]; then
  echo "failed to pin the Studio active gateway (helper exit $PIN_RC)" >&2
  printf '%s\n' "$PIN_OUT" | grep -E '^status: [0-9]+$' >&2 || true
  echo "the agent is installed and serving — re-run this installer to retry the pin." >&2
  exit 1
fi
echo "studio active gateway pinned to $GATEWAY_URL"

echo "installed $LABEL -> $PLIST"
echo "bound: 127.0.0.1:$PORT (fixed)"
echo "logs: $OUT_LOG"
echo "      $ERR_LOG"
echo "verify:   scripts/launchd/verify-ja-office-stack.sh"
echo "rollback: scripts/launchd/uninstall-ja-office-app.sh"
