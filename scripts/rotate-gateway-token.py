#!/usr/bin/env python3
"""Rotate HERMES3D_GATEWAY_TOKEN in ja-office/.env with a fresh random value.

Never prints the token. Keeps file mode 0600.
"""
import os
import secrets

ENV = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), ".env")

new = secrets.token_urlsafe(48)
lines = []
found = False
with open(ENV, "r", encoding="utf-8") as fh:
    for line in fh:
        if line.startswith("HERMES3D_GATEWAY_TOKEN="):
            lines.append(f"HERMES3D_GATEWAY_TOKEN={new}\n")
            found = True
        else:
            lines.append(line)
if not found:
    if lines and not lines[-1].endswith("\n"):
        lines.append("\n")
    lines.append(f"HERMES3D_GATEWAY_TOKEN={new}\n")

tmp = ENV + ".tmp"
fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
with os.fdopen(fd, "w", encoding="utf-8") as fh:
    fh.writelines(lines)
os.replace(tmp, ENV)
os.chmod(ENV, 0o600)
print("rotated: ok, length_class=urlsafe48")
