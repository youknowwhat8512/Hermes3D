#!/usr/bin/env python3
"""Start a command fully detached (session leader, reparented to PID 1).

Usage: python3 scripts/spawn-detached.py <logfile> <cmd> [args...]
Prints only the spawned PID.
"""
import os
import subprocess
import sys

log = sys.argv[1]
cmd = sys.argv[2:]
if not cmd:
    sys.exit("no command")

cwd = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
os.makedirs(os.path.dirname(log) or ".", exist_ok=True)
fh = open(log, "ab")
p = subprocess.Popen(
    cmd,
    cwd=cwd,
    stdout=fh,
    stderr=subprocess.STDOUT,
    stdin=subprocess.DEVNULL,
    start_new_session=True,
)
print(p.pid)
