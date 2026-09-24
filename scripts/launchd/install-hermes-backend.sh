#!/bin/bash
# Install the JA Office hermes-agent backend (port 9137) as a launchd user agent.
#
#   scripts/launchd/install-hermes-backend.sh              # generate + (re)load
#   scripts/launchd/install-hermes-backend.sh --dry-run    # only print the plist
#   scripts/launchd/install-hermes-backend.sh --adopt-pid 3505
#       adopt an orphaned backend listener you have identified yourself
#
# The plist never stores the gateway token: start-hermes-backend.sh reads it
# from ja-office/.env at launch time. Reinstall waits for the old service to
# release port 9137 before bootstrapping, and aborts rather than dropping
# launchd into an EADDRINUSE restart loop. A foreign listener on 9137 is
# refused, never killed.
set -euo pipefail

LABEL="dev.ja-office.hermes-backend"
PORT="${JA_OFFICE_BACKEND_PORT:-9137}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="${JA_OFFICE_ROOT:-$(cd "$SCRIPT_DIR/../.." && pwd)}"
# shellcheck source=lib.sh
. "$SCRIPT_DIR/lib.sh"

PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOG_DIR="$REPO_ROOT/logs"
OUT_LOG="$LOG_DIR/launchd-hermes-backend-$PORT.out.log"
ERR_LOG="$LOG_DIR/launchd-hermes-backend-$PORT.err.log"
CMD_REGEX="bin/hermes .*--port $PORT"

DRY_RUN=0
ADOPT_PID=""
while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY_RUN=1; shift ;;
    --adopt-pid) ADOPT_PID="${2:-}"; shift 2 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

START_SH="$REPO_ROOT/scripts/start-hermes-backend.sh"
if [ ! -f "$START_SH" ]; then
  echo "missing $START_SH" >&2
  exit 1
fi

HERMES_HOME_DIR="${HERMES_HOME:-$HOME/.hermes}"
HERMES_BIN_PATH="${HERMES_BIN:-$HERMES_HOME_DIR/hermes-agent/venv/bin/hermes}"
if [ ! -x "$HERMES_BIN_PATH" ]; then
  HERMES_BIN_PATH="$(command -v hermes || true)"
fi
if [ -z "$HERMES_BIN_PATH" ] || [ ! -x "$HERMES_BIN_PATH" ]; then
  echo "hermes binary not found (set HERMES_BIN)" >&2
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
    <string>dashboard</string>
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
    <key>HERMES_BIN</key>
    <string>$HERMES_BIN_PATH</string>
    <key>JA_OFFICE_BACKEND_PORT</key>
    <string>$PORT</string>
    <!-- Proof-of-launchd marker. start-hermes-backend.sh refuses the reserved
         port unless it sees this label, so a hand-started backend can never
         race this job for 127.0.0.1:$PORT. -->
    <key>JA_OFFICE_LAUNCHD_MANAGED</key>
    <string>$LABEL</string>
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

echo "installed $LABEL -> $PLIST"
echo "bound: 127.0.0.1:$PORT (fixed)"
echo "logs: $OUT_LOG"
echo "      $ERR_LOG"
echo "verify:   scripts/launchd/verify-hermes-backend.sh"
echo "rollback: scripts/launchd/uninstall-hermes-backend.sh"
