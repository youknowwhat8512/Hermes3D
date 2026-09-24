#!/bin/bash
# Single entry point for "open the JA Office".
#
#   scripts/open-ja-office.sh              # verify the stack, then open it
#   scripts/open-ja-office.sh --check      # verify only, never open a browser
#   scripts/open-ja-office.sh --no-open    # alias of --check
#
# Why this exists: an HTTP 200 on 3000 and 9137 does NOT mean the office works.
# A stray `hermes dashboard --port 9137` answers 200 too, while holding a
# different session token than the one the app proxies with — the app then gets
# 403 from its upstream and the UI shows "Gateway closed (1011): connect
# failed". The only conclusive check is: the launchd job owns the port AND an
# authenticated same-origin WebSocket reaches the hermes-agent adapter.
#
# So the order here is always: identify the repo -> verify ownership + HTTP +
# authenticated WebSocket -> only then open the browser. On failure it opens
# nothing and prints the recovery commands. It never kills a process it does not
# own and never prints a token.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="${JA_OFFICE_ROOT:-$(cd "$SCRIPT_DIR/.." && pwd)}"

APP_PORT="${JA_OFFICE_APP_PORT:-3000}"
BE_PORT="${JA_OFFICE_BACKEND_PORT:-9137}"
BE_LABEL="dev.ja-office.hermes-backend"
APP_LABEL="dev.ja-office.app"
OFFICE_URL="http://127.0.0.1:$APP_PORT/office"
VERIFIER="$SCRIPT_DIR/launchd/verify-ja-office-stack.sh"
# Overridable so a test can capture the command instead of launching a browser.
OPEN_CMD="${JA_OFFICE_OPEN_CMD:-open}"

DO_OPEN=1
for arg in "$@"; do
  case "$arg" in
    --check|--no-open) DO_OPEN=0 ;;
    *) echo "unknown argument: $arg" >&2; exit 2 ;;
  esac
done

if [ ! -x "$VERIFIER" ] && [ ! -f "$VERIFIER" ]; then
  echo "missing verifier: $VERIFIER" >&2
  exit 1
fi

echo "repo: $REPO_ROOT"
echo

# The verifier is the single source of truth for "is this stack healthy":
# launchd label loaded, listener pid == service pid on both fixed ports,
# HTTP 200, and an authenticated ws frame from the hermes-agent adapter.
bash "$VERIFIER"
verify_rc=$?

if [ "$verify_rc" != "0" ]; then
  cat >&2 <<EOF

NOT opening the office: verification failed (exit $verify_rc).

Opening the UI now would just reproduce the error you already saw, so read the
failing line above and use the matching recovery:

  "LISTEN pid=[N] but ... service pid=M"
      A process that is not the launchd job holds the port. Identify it first:
        ps -o pid=,command= -p N
      If it is a stray Hermes backend you started by hand, stop that one process
      (kill N), then:
        launchctl kickstart -k gui/\$(id -u)/$BE_LABEL
      If it is something else, leave it alone and free the port deliberately.

  "not loaded in gui/..."
      The service is not installed. Install it:
        scripts/launchd/install-hermes-backend.sh
        scripts/launchd/install-ja-office-app.sh

  "nothing listening on 127.0.0.1:PORT"  /  HTTP != 200
      The job is loaded but not serving. Restart and read its log:
        launchctl kickstart -k gui/\$(id -u)/$BE_LABEL
        launchctl kickstart -k gui/\$(id -u)/$APP_LABEL
        logs/launchd-hermes-backend-$BE_PORT.err.log
        logs/launchd-ja-office-app-$APP_PORT.err.log

  "probe-gateway-ws: ..."
      Ports are up but the app cannot authenticate to the backend — usually a
      token mismatch from a backend this repo did not start. Confirm the
      listener pid equals the service pid above, then kickstart the backend.

Never start the backend by hand on $BE_PORT: that is the original cause of
"Gateway closed (1011): connect failed".
EOF
  exit "$verify_rc"
fi

if [ "$DO_OPEN" = "0" ]; then
  echo
  echo "verified. not opening ($OFFICE_URL) because --check was given."
  exit 0
fi

echo
echo "verified. opening $OFFICE_URL"
"$OPEN_CMD" "$OFFICE_URL"
