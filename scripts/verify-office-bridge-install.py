#!/usr/bin/env python3
"""Report hermes3d-office-bridge plugin state per Hermes target (no secrets)."""
from __future__ import annotations

import pathlib
import sys

import yaml

NAME = "hermes3d-office-bridge"
ROOT = pathlib.Path.home() / ".hermes"
REPO_ROOT = pathlib.Path(__file__).resolve().parents[1]


def targets():
    out = [("default", ROOT)]
    profiles = ROOT / "profiles"
    if profiles.is_dir():
        for d in sorted(profiles.iterdir()):
            if d.is_dir():
                out.append((d.name, d))
    return out


rows = []
for name, home in targets():
    cfg_path = home / "config.yaml"
    cfg = {}
    if cfg_path.exists():
        cfg = yaml.safe_load(cfg_path.read_text(encoding="utf-8")) or {}
    plugins = cfg.get("plugins") or {}
    entries = plugins.get("entries") or {}
    entry = entries.get(NAME) or {}
    settings = entry.get("settings") or {}
    enabled = NAME in (plugins.get("enabled") or []) and NAME not in (
        plugins.get("disabled") or []
    )
    pdir = home / "plugins" / NAME
    version = ""
    ymlp = pdir / "plugin.yaml"
    if ymlp.exists():
        version = str((yaml.safe_load(ymlp.read_text(encoding="utf-8")) or {}).get("version", ""))
    rows.append(
        {
            "target": name,
            "dir": pdir.is_dir(),
            "version": version,
            "enabled": enabled,
            "port": settings.get("port"),
            "host": settings.get("host"),
            "channel": settings.get("channel"),
            "install_sh_removed": not (pdir / "install.sh").exists(),
            "tests_removed": not list(pdir.glob("test_*.py")),
        }
    )

def env_value(path: pathlib.Path, key: str) -> str:
    if not path.exists():
        return ""
    for line in path.read_text(encoding="utf-8").splitlines():
        stripped = line.strip()
        if stripped.startswith("#") or not stripped.startswith(key + "="):
            continue
        value = stripped.split("=", 1)[1].strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
            value = value[1:-1]
        return value
    return ""


for row in rows:
    print(
        "{target:14s} dir={dir!s:5s} v={version:6s} enabled={enabled!s:5s} "
        "port={port!s:5s} host={host!s:10s} channel={channel!s}".format(**row)
    )

office_token = env_value(ROOT / ".env", "HERMES3D_OFFICE_TOKEN")
app_token = env_value(
    REPO_ROOT / ".env", "HERMES3D_GATEWAY_TOKEN"
)
token_present = bool(office_token)
token_match = bool(office_token) and office_token == app_token
print(f"token_present={token_present} token_match={token_match}")

bad = [
    r["target"]
    for r in rows
    if not (
        r["dir"]
        and r["version"] == "1.1.0"
        and r["enabled"] is True
        and r["port"] == 9137
        and r["host"] == "127.0.0.1"
        and r["channel"] == "hermes3d"
    )
]
print(f"targets={len(rows)} noncompliant={bad}")
sys.exit(1 if (bad or not token_match) else 0)
