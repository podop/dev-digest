#!/usr/bin/env bash
# workflow-retro.sh — deep-mode data for the workflow-retro skill; see scripts/workflow-retro.py.
exec python3 "$(dirname "${BASH_SOURCE[0]}")/workflow-retro.py" "$@"
