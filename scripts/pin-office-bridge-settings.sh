#!/usr/bin/env bash
# Pin hermes3d-office-bridge settings in every profile config via the official
# `hermes config set`. Default home is handled separately by the caller.
set -uo pipefail

HERMES_BIN="${HERMES_BIN:-$HOME/.local/bin/hermes}"

for profile_dir in "$HOME"/.hermes/profiles/*/; do
  [[ -d "$profile_dir" ]] || continue
  profile="$(basename "$profile_dir")"
  echo "=== $profile ==="
  out="$(env -u HERMES_HOME -u HERMES_PROFILE "$HERMES_BIN" -p "$profile" \
    plugins enable hermes3d-office-bridge 2>&1)"
  echo "$out" | sed -n '1p'
  for kv in port=9137 host=127.0.0.1 channel=hermes3d; do
    key="${kv%%=*}"
    val="${kv#*=}"
    out="$(env -u HERMES_HOME -u HERMES_PROFILE "$HERMES_BIN" -p "$profile" config set \
      "plugins.entries.hermes3d-office-bridge.settings.$key" "$val" 2>&1)"
    echo "$out" | tail -1
  done
done
