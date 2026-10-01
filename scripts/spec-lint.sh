#!/usr/bin/env bash
# spec-lint.sh — deterministic checks for a specreator spec; see scripts/spec-lint.py.
exec python3 "$(dirname "${BASH_SOURCE[0]}")/spec-lint.py" "$@"
