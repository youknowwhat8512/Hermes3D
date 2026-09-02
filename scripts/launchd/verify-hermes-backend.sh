#!/bin/bash
# Backend-scoped verification for dev.ja-office.hermes-backend (port 9137).
# Kept as the original entry point; the checks now live in the stack verifier.
#
#   scripts/launchd/verify-hermes-backend.sh              # checks only
#   scripts/launchd/verify-hermes-backend.sh --restart-test
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec "$SCRIPT_DIR/verify-ja-office-stack.sh" --backend-only "$@"
