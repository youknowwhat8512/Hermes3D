#!/bin/bash
# Probe candidate kanban endpoints on the local backend. Status codes only.
set -uo pipefail
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TOKEN=""
while IFS= read -r line; do
  if [[ "$line" == HERMES3D_GATEWAY_TOKEN=* ]]; then
    TOKEN="${line#*=}"
    TOKEN="${TOKEN#\"}"
    TOKEN="${TOKEN%\"}"
    break
  fi
done < "$ROOT_DIR/.env"
[[ -n "$TOKEN" ]] || { echo "missing HERMES3D_GATEWAY_TOKEN" >&2; exit 1; }
for p in \
  /api/kanban/tasks \
  /api/plugins/kanban/board \
  /api/plugins \
  /api/kanban/board \
  /api/sessions
do
  printf "%s -> " "$p"
  curl -s -o /dev/null -w "%{http_code}\n" --max-time 10 -H "Authorization: Bearer $TOKEN" "http://127.0.0.1:9120$p"
done
