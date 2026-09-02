#!/usr/bin/env python3
"""Semantic diff of Hermes config backups vs current files.

`hermes config set` rewrites the whole YAML document, so a textual diff is
dominated by re-serialisation noise (key reordering, comment stripping,
unicode unescaping, pruning of empty containers). This compares the parsed
structures instead and reports only real value changes, ignoring the
hermes3d-office-bridge plugin subtree we intentionally set.
"""
from __future__ import annotations

import pathlib
import sys

import yaml

BAK = pathlib.Path("/tmp/h3d-config-bak")
ROOT = pathlib.Path.home() / ".hermes"
IGNORE_PREFIXES = (
    "plugins.enabled",
    "plugins.disabled",
    "plugins.entries.hermes3d-office-bridge",
    "_config_version",
)
EMPTY = (None, {}, [], "")


def flatten(node, prefix=""):
    out = {}
    if isinstance(node, dict):
        for key, value in node.items():
            out.update(flatten(value, f"{prefix}.{key}" if prefix else str(key)))
    elif isinstance(node, list):
        for i, value in enumerate(node):
            out.update(flatten(value, f"{prefix}[{i}]"))
    else:
        out[prefix] = node
    return out


def ignored(path: str) -> bool:
    for p in IGNORE_PREFIXES:
        if path == p or path.startswith(p + ".") or path.startswith(p + "["):
            return True
    return False


targets = [("default", ROOT / "config.yaml")]
profiles = ROOT / "profiles"
if profiles.is_dir():
    for d in sorted(profiles.iterdir()):
        if d.is_dir() and (d / "config.yaml").exists():
            targets.append((d.name, d / "config.yaml"))

problems = 0
for name, cur_path in targets:
    bak_path = BAK / f"{name}.config.yaml.bak"
    if not bak_path.exists():
        print(f"{name}: NO BACKUP")
        problems += 1
        continue
    before = flatten(yaml.safe_load(bak_path.read_text(encoding="utf-8")) or {})
    after = flatten(yaml.safe_load(cur_path.read_text(encoding="utf-8")) or {})

    changed = []
    for key in sorted(set(before) | set(after)):
        if ignored(key):
            continue
        b = before.get(key, "<absent>")
        a = after.get(key, "<absent>")
        if b == a:
            continue
        # Empty containers and nulls are pruned/added on rewrite; not a value change.
        if (b == "<absent>" and a in EMPTY) or (a == "<absent>" and b in EMPTY):
            continue
        changed.append((key, b, a))

    if changed:
        problems += 1
        print(f"=== {name}: {len(changed)} semantic change(s) ===")
        for key, b, a in changed:
            print(f"    {key}: {b!r} -> {a!r}")
    else:
        print(f"{name}: no semantic change outside the plugin entry")

print(f"targets={len(targets)} with_unexpected_changes={problems}")
sys.exit(1 if problems else 0)
