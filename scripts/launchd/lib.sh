#!/bin/bash
# Shared helpers for the dev.ja-office.* launchd user agents.
# Sourced by install/uninstall/verify scripts — not meant to be run directly.
# The caller must set REPO_ROOT before sourcing.

: "${REPO_ROOT:?REPO_ROOT must be set before sourcing lib.sh}"

LAUNCHD_DOMAIN="gui/$(id -u)"
STATE_DIR="$REPO_ROOT/logs/launchd-state"

# --- read-only inspection --------------------------------------------------

# svc_loaded is the one predicate here: nonzero means "not loaded".
svc_loaded() { launchctl print "$LAUNCHD_DOMAIN/$1" >/dev/null 2>&1; }

# The lookups below print nothing and succeed when there is nothing to report.
# Callers run under `set -euo pipefail`, so "no such label" (launchctl exits
# 113) or "no listener" (lsof exits 1) must not abort the script before it can
# print its refusal.
svc_pid() {
  launchctl print "$LAUNCHD_DOMAIN/$1" 2>/dev/null | awk '/^\tpid = /{print $3; exit}' || true
}

listen_pids() {
  lsof -nP -iTCP:"$1" -sTCP:LISTEN -t 2>/dev/null | sort -u || true
}

# PID recorded by the last successful install of this label.
recorded_pid() {
  local f="$STATE_DIR/$1.pid"
  [ -f "$f" ] || return 0
  head -1 "$f" | tr -dc '0-9' || true
}

record_pid() {
  mkdir -p "$STATE_DIR"
  printf '%s\n' "$2" > "$STATE_DIR/$1.pid"
}

# A recycled PID number must not become a licence to kill a stranger, so every
# candidate is matched against the command line we expect to own the port.
cmd_matches() {
  local pid="$1" regex="$2" cmd
  cmd="$(ps -o command= -p "$pid" 2>/dev/null || true)"
  [ -n "$cmd" ] && printf '%s' "$cmd" | grep -Eq "$regex"
}

describe_pid() { ps -o pid=,command= -p "$1" 2>/dev/null || echo "  pid $1 (gone)"; }

# --- lifecycle -------------------------------------------------------------

# Terminate one PID we are allowed to touch. TERM first, KILL as a last resort.
terminate_pid() {
  local pid="$1" i
  kill -TERM "$pid" 2>/dev/null || true
  for i in $(seq 1 10); do
    kill -0 "$pid" 2>/dev/null || return 0
    sleep 1
  done
  kill -KILL "$pid" 2>/dev/null || true
  for i in $(seq 1 5); do
    kill -0 "$pid" 2>/dev/null || return 0
    sleep 1
  done
  return 1
}

# prepare_port LABEL PORT CMD_REGEX [ADOPT_PID]
#
# Make PORT free and LABEL unloaded, or fail without changing anything that is
# not ours. "Ours" is exactly: the PID launchd reports for LABEL right now, the
# PID recorded by the previous install, or a PID the operator named explicitly
# with --adopt-pid. All three must also match CMD_REGEX. Anything else is a
# foreign listener and aborts the install — we never guess.
prepare_port() {
  local label="$1" port="$2" regex="$3" adopt="${4:-}"
  local live recorded holders pid i

  live="$(svc_pid "$label")"
  recorded="$(recorded_pid "$label")"

  is_ours() {
    local p="$1"
    [ -n "$live" ] && [ "$p" = "$live" ] && return 0
    [ -n "$recorded" ] && [ "$p" = "$recorded" ] && cmd_matches "$p" "$regex" && return 0
    [ -n "$adopt" ] && [ "$p" = "$adopt" ] && cmd_matches "$p" "$regex" && return 0
    return 1
  }

  # Classify before touching anything, so a refusal leaves the box untouched.
  for pid in $(listen_pids "$port"); do
    if ! is_ours "$pid"; then
      echo "port $port is held by a process this installer does not track:" >&2
      describe_pid "$pid" >&2
      echo "refusing to install — nothing was changed." >&2
      if cmd_matches "$pid" "$regex"; then
        echo "it looks like an untracked JA Office process. To adopt it, re-run with:" >&2
        echo "  --adopt-pid $pid" >&2
      else
        echo "stop that process yourself, then re-run the installer." >&2
      fi
      return 1
    fi
  done

  if svc_loaded "$label"; then
    launchctl bootout "$LAUNCHD_DOMAIN/$label" 2>/dev/null || true
    for i in $(seq 1 20); do
      svc_loaded "$label" || break
      sleep 1
    done
    if svc_loaded "$label"; then
      echo "$label is still loaded 20s after bootout — aborting." >&2
      return 1
    fi
    # bootout usually takes the listener with it; wait before reaching for kill.
    for i in $(seq 1 20); do
      [ -z "$(listen_pids "$port")" ] && break
      sleep 1
    done
  fi

  for pid in $(listen_pids "$port"); do
    if ! is_ours "$pid"; then
      echo "port $port was grabbed by pid $pid while booting out — aborting." >&2
      describe_pid "$pid" >&2
      return 1
    fi
    echo "port $port still held by tracked pid $pid — terminating it"
    terminate_pid "$pid" || true
  done

  for i in $(seq 1 15); do
    [ -z "$(listen_pids "$port")" ] && break
    sleep 1
  done

  holders="$(listen_pids "$port")"
  if [ -n "$holders" ]; then
    echo "port $port is still held after bootout by: $holders" >&2
    echo "aborting instead of bootstrapping into an EADDRINUSE restart loop." >&2
    return 1
  fi

  return 0
}

# PIDs holding PORT that appear in the space-padded OWNED list.
owned_holders() {
  local port="$1" owned="$2" pid
  for pid in $(listen_pids "$port"); do
    case "$owned" in *" $pid "*) echo "$pid" ;; esac
  done
}

# release_owned_listener LABEL PORT CMD_REGEX [PREV_PID]
#
# Post-bootout cleanup for the uninstall path. bootout normally takes the
# listener with it, but a wedged child can outlive it — and removing the plist
# then leaves an orphan nobody tracks. Only PREV_PID (what launchd reported
# before bootout) and the recorded install PID are touchable, and only while
# the command line still matches. Anything else keeps running untouched.
# Returns nonzero when one of our own orphans survives, so the caller can stop
# before deleting the plist.
release_owned_listener() {
  local label="$1" port="$2" regex="$3" prev="${4:-}"
  local recorded owned pid i failed=""
  recorded="$(recorded_pid "$label")"
  owned=" $prev $recorded "

  # Wait only while one of our own PIDs is still holding the port.
  for i in $(seq 1 20); do
    [ -z "$(owned_holders "$port" "$owned")" ] && return 0
    sleep 1
  done

  for pid in $(owned_holders "$port" "$owned"); do
    if cmd_matches "$pid" "$regex"; then
      echo "orphan listener on port $port from $label (pid $pid) — terminating it"
      terminate_pid "$pid" || failed="$failed $pid"
    else
      echo "pid $pid no longer looks like $label — leaving it alone" >&2
      describe_pid "$pid" >&2
    fi
  done

  if [ -n "$failed" ]; then
    echo "owned orphan(s) survived on port $port:$failed" >&2
    echo "the plist was left in place so the service stays traceable." >&2
    return 1
  fi
  return 0
}

# Wait for the freshly bootstrapped label to report a PID, and remember it so
# the next reinstall knows which process it is allowed to clean up.
record_service_pid() {
  local label="$1" pid i
  for i in $(seq 1 15); do
    pid="$(svc_pid "$label")"
    [ -n "$pid" ] && break
    sleep 1
  done
  if [ -n "$pid" ]; then
    record_pid "$label" "$pid"
    echo "service pid $pid recorded in $STATE_DIR/$label.pid"
  else
    echo "warning: $label reported no pid within 15s — check the logs" >&2
  fi
}
