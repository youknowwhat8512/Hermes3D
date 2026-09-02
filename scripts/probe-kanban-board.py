#!/usr/bin/env python3
"""Print the shape of the hermes kanban `/board` response (no task text).

Read-only probe: reports column ids, task field names, and the (status,
assignee) pairs of running tasks so the office bridge can be written against
the real payload rather than a guess. Never prints titles, bodies, or tokens.
"""

import json
import os
import sys
import urllib.request

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def token() -> str:
    with open(os.path.join(REPO, ".env"), encoding="utf-8") as handle:
        for line in handle:
            if line.startswith("HERMES3D_GATEWAY_TOKEN="):
                return line.split("=", 1)[1].strip()
    return ""


def probe(port: str, secret: str) -> None:
    url = f"http://127.0.0.1:{port}/api/plugins/kanban/board?include_archived=false"
    request = urllib.request.Request(url, headers={"X-Hermes-Session-Token": secret})
    print(f"--- port {port} ---")
    try:
        with urllib.request.urlopen(request, timeout=8) as response:
            payload = json.load(response)
    except Exception as err:  # noqa: BLE001 - probe reports, never raises
        print("request_failed", type(err).__name__, str(err)[:120])
        return
    print("top_keys", sorted(payload)[:10])
    columns = payload.get("columns") or []
    print("columns", [column.get("id") or column.get("status") for column in columns])
    for column in columns:
        tasks = column.get("tasks") or []
        if tasks:
            print("task_field_names", sorted(tasks[0]))
            break
    running = [
        (task.get("status"), task.get("assignee"))
        for column in columns
        for task in (column.get("tasks") or [])
        if task.get("status") == "running"
    ]
    print("running_status_assignee", running)


if __name__ == "__main__":
    secret = token()
    for port in sys.argv[1:] or ["9137", "9120"]:
        probe(port, secret)
