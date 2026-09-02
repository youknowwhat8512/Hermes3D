#!/bin/bash
# Verify the kanban plugin surface on the local backend. Prints status + count only.
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
URL="http://127.0.0.1:9120/api/plugins/kanban/tasks"
printf "kanban_status -> "
curl -s -o /tmp/kanban_probe.json -w "%{http_code}\n" --max-time 15 -H "Authorization: Bearer $TOKEN" "$URL"
printf "kanban_task_count -> "
python3 -c 'import json;d=json.load(open("/tmp/kanban_probe.json"));t=d.get("tasks",d) if isinstance(d,dict) else d;print(len(t) if isinstance(t,list) else "nonlist")' 2>/dev/null || echo parse_skip
rm -f /tmp/kanban_probe.json
