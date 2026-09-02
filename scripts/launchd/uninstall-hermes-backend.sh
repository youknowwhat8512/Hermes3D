#!/bin/bash
# Uninstall / roll back the JA Office hermes-agent backend launchd agent.
#
#   scripts/launchd/uninstall-hermes-backend.sh            # bootout + remove plist
#   scripts/launchd/uninstall-hermes-backend.sh --keep-plist
#   scripts/launchd/uninstall-hermes-backend.sh --restore-backup  # restore .bak
#
# Touches nothing but this label. Port 3000, 9120 and Hermes Desktop are left
# alone.
set -euo pipefail

LABEL="dev.ja-office.hermes-backend"
PORT="${JA_OFFICE_BACKEND_PORT:-9137}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="${JA_OFFICE_ROOT:-$(cd "$SCRIPT_DIR/../.." && pwd)}"
# shellcheck source=lib.sh
. "$SCRIPT_DIR/lib.sh"

PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
CMD_REGEX="bin/hermes .*--port $PORT"
ACTION="${1:-}"

if [ -n "$ACTION" ] && [ "$ACTION" != "--keep-plist" ] && [ "$ACTION" != "--restore-backup" ]; then
  echo "unknown argument: $ACTION" >&2
  exit 2
fi

# Remember who launchd owns before bootout takes the answer away.
PREV_PID="$(svc_pid "$LABEL")"

launchctl bootout "$LAUNCHD_DOMAIN/$LABEL" 2>/dev/null && echo "booted out $LABEL" || echo "$LABEL was not loaded"

# bootout must not leave one of our own processes squatting on the port with
# the plist gone. Foreign listeners are never touched.
release_owned_listener "$LABEL" "$PORT" "$CMD_REGEX" "$PREV_PID"

case "$ACTION" in
  --keep-plist)
    echo "plist kept at $PLIST"
    ;;
  --restore-backup)
    if [ -f "$PLIST.bak" ]; then
      mv "$PLIST.bak" "$PLIST"
      plutil -lint "$PLIST"
      launchctl bootstrap "$LAUNCHD_DOMAIN" "$PLIST"
      record_service_pid "$LABEL"
      echo "restored and loaded previous plist from backup"
    else
      echo "no backup at $PLIST.bak" >&2
      exit 1
    fi
    ;;
  "")
    if [ -f "$PLIST" ]; then
      rm -f "$PLIST"
      echo "removed $PLIST"
    else
      echo "no plist at $PLIST"
    fi
    rm -f "$STATE_DIR/$LABEL.pid"
    ;;
esac

echo "remaining listener on $PORT:"
lsof -nP -iTCP:"$PORT" -sTCP:LISTEN || echo "  (none)"
