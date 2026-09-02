#!/usr/bin/env python3
"""Compare a Studio settings backup against the live file, without printing secrets."""
import json
import os
import sys

backup_path = sys.argv[1] if len(sys.argv) > 1 else "/tmp/hermes3d-backup/settings.json.pre-9137.bak"
state_dir = os.environ.get("HERMES_STATE_DIR") or os.path.expanduser("~/.hermes")
live_path = os.path.join(state_dir, "hermes3d", "settings.json")

with open(backup_path, "r", encoding="utf-8") as fh:
    before = json.load(fh)
with open(live_path, "r", encoding="utf-8") as fh:
    after = json.load(fh)

print("backup:", backup_path)
print("live  :", live_path)
print("top keys equal:", sorted(before) == sorted(after))

changed = [
    key
    for key in before
    if json.dumps(before[key], sort_keys=True) != json.dumps(after.get(key), sort_keys=True)
]
print("changed top-level keys:", changed)

non_gateway_intact = all(
    before[key] == after.get(key) for key in before if key != "gateway"
)
print("non-gateway sections intact:", non_gateway_intact)

bg = before.get("gateway") or {}
ag = after.get("gateway") or {}
print("gateway.url:", bg.get("url"), "->", ag.get("url"))
print("gateway.adapterType:", bg.get("adapterType"), "->", ag.get("adapterType"))
print(
    "gateway.token unchanged:",
    isinstance(ag.get("token"), str)
    and ag.get("token") == bg.get("token")
    and bool(ag.get("token")),
)
print(
    "lastKnownGood.url:",
    (bg.get("lastKnownGood") or {}).get("url"),
    "->",
    (ag.get("lastKnownGood") or {}).get("url"),
)
print("profiles equal:", bg.get("profiles") == ag.get("profiles"))
