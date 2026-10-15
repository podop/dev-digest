#!/usr/bin/env bash
# verify-l06.sh — lesson 06 (eval pipeline) acceptance run: fails on the first failing step.
# Order: shared-contract drift · server typecheck · lint · arch:check · unit tests ·
# eval tests · client typecheck · client tests · integration tests (only with Docker) ·
# LLM skill evals in evals/ (only with VERIFY_EVALS=1 — they call a model).
# Run from anywhere: `cd server && pnpm verify:l06` (or `VERIFY_EVALS=1 pnpm verify:l06`).
set -euo pipefail

SERVER="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ROOT="$(cd "$SERVER/.." && pwd)"

step() {
  echo
  echo "==> $1"
}

cd "$SERVER"

step "shared-contract drift"
"$ROOT/scripts/check-shared-drift.sh"

step "server typecheck"
pnpm typecheck

step "server lint"
pnpm lint

step "server arch:check"
pnpm arch:check

step "server unit tests"
pnpm test:unit

step "eval tests (unit)"
pnpm exec vitest run test/eval- --exclude '**/*.it.test.ts'

step "client typecheck"
(cd "$ROOT/client" && pnpm typecheck)

step "client tests"
(cd "$ROOT/client" && pnpm test)

step "integration tests (eval)"
if docker info >/dev/null 2>&1; then
  # Shell-expanded file list: vitest filters are substring matches, not globs.
  pnpm exec vitest run test/eval-*.it.test.ts
else
  echo "SKIPPED: Docker is not available (integration tests need Testcontainers)"
fi

step "LLM skill evals (evals/, opt-in)"
if [[ "${VERIFY_EVALS:-}" == "1" ]]; then
  # Calls a model on every case (EVAL_BACKEND / EVAL_MODEL as in evals/README.md), ~4 min.
  (cd "$ROOT/evals" && pnpm exec vitest run skills/dependency-checker)
else
  echo "SKIPPED: set VERIFY_EVALS=1 to run the model-backed skill evals"
fi

echo
echo "verify:l06 OK"
