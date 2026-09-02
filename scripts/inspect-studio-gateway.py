#!/usr/bin/env python3
"""Print the Studio settings gateway block with tokens redacted (no secrets printed)."""
import json
import os
import sys

state_dir = os.environ.get("HERMES_STATE_DIR") or os.path.expanduser("~/.hermes")
path = os.path.join(state_dir, "hermes3d", "settings.json")
if not os.path.exists(path):
    print("missing:", path)
    sys.exit(1)

with open(path, "r", encoding="utf-8") as fh:
    data = json.load(fh)


def redact(obj):
    if isinstance(obj, dict):
        out = {}
        for key, value in obj.items():
            if key in ("token", "apiToken") and isinstance(value, str):
                out[key] = f"<set len={len(value)}>" if value else "<empty>"
            else:
                out[key] = redact(value)
        return out
    if isinstance(obj, list):
        return [redact(v) for v in obj]
    return obj


print("path:", path)
print("top keys:", sorted(data.keys()))
print("gateway:")
print(json.dumps(redact(data.get("gateway") or {}), indent=2, ensure_ascii=False))
