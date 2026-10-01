---
name: implement
description: "Workflow (manual): runs the implementation phase of Spec Driven Development for an approved plan — implementer (one pass or waves) → gates → plan-verifier ∥ architecture-reviewer → fix rounds with delta-reviewer until PASS → wrap-up. The spec (specreator) and the plan (implementation-planner) are made separately, before it. Use only when the user types /implement."
disable-model-invocation: true
argument-hint: "<docs/plans/<plan>.md> [--notes \"extra requirements\"] [--design <path>…] [--spec <path>] [--opus-review] [--max-rounds N]"
metadata:
  version: "1.0.0"
  type: "workflow"
---

# /implement — plan → reviewed code

```
specreator ──► spec ──► implementation-planner ──► plan      (separate sessions, manual)
                                                     │
/implement <plan> ───────────────────────────────────┘
  0 preflight ─► 1 implement (single pass | waves) ─► gates
  ─► 2 round 1: plan-verifier ∥ architecture-reviewer
  ─► 3 fix rounds: implementer fix ─► gates ─► delta-reviewer   (until PASS, ≤ max rounds)
  ─► 4 wrap-up: summary · INSIGHTS · next steps (doc-writer, /pr-self-review)
```

Arguments: `$ARGUMENTS`

You are the **lead** (orchestrator). You don't write code and you don't review; you
route paths between agents, run the scripts, and decide the next step from short
reports. Follow `.claude/agents/README.md` → Token budget; the rules that matter most
here are restated inline.

## Lead rules

- **Paths, not content.** Hand agents the plan path, context-pack path, report paths,
  gates state, delta label, finding IDs. Never paste a plan, diff, report or test output
  into a prompt, and don't read the plan body, the diff or full reports yourself — the
  short forms agents return are enough. Read a full report row only when a short form
  is ambiguous.
- **Agents that write run one at a time**, except implementers of one wave the plan
  marks parallel (`S3 ∥ S4`, different packages). Reviewers run together, read-only, on
  the same snapshot.
- **Never**: commit, push, `docker compose down -v`, `biome --write`, edit code yourself.
  Never fix a finding in the lead session: it goes to an implementer brief.
- **test-writer is paused**: tests come from the implementer as the plan lists them;
  plan-verifier `FAIL` rows about tests go to the implementer like code rows.
- **Ask the user** (AskUserQuestion) only at the gates named below: BLOCKED, scope
  change, max rounds reached, MEDIUM/LOW findings at the end.

## 0 — preflight (no agents)

1. Parse `$ARGUMENTS`. No plan path → stop: "run `claude --agent
   implementation-planner` with your spec first". The plan must exist.
2. `head -n 6 <plan>` → title, `Packages`, `Base`, `Spec`, `Context pack`, `Execution`.
   `grep -n -A12 '^## Execution' <plan>` → mode and waves; `grep -n 'Review risk' <plan>`.
   `--spec` overrides the header's spec. Missing context pack or Execution line → still
   run, single-agent, and say so.
3. `--notes`: if they only clarify the plan, pass them on; if they add scope (new
   behaviour, screen, endpoint, AC), stop and ask — scope changes go back to the
   planner/spec. `--design` paths: check they exist; pass them to the implementers of
   client steps only.
4. `git status --short`: unrelated uncommitted changes → tell the user, ask whether to
   continue (they would mix into the diff and the scope check).
5. `slug` = plan file name without date and `.md`; `mkdir -p .devdigest/review/<slug>`.
6. Tell the user in ≤ 5 lines: plan, mode, waves, reviewers' model, max rounds
   (default 3).

## 1 — implement

**single-agent**: one `implementer`:
`plan: <path> · context: <pack> · steps: all · notes: <…> · designs: <…>`.

**multi-agent**: for each wave in order, one `implementer` per parallel group, fresh
each time: `plan: <path> · context: <pack> · wave: W<n> · steps: S… · parallel: yes|no
· notes · designs`. Parallel groups of one wave go out in **one message**.

After each implementer/wave:

- `STATUS: BLOCKED` → stop; show the blocker and the question to the user; resume with
  their answer in a new implementer brief (or send them back to the planner).
- `PARTIAL` → one more fresh implementer for the missing steps of that wave.
- Run `./scripts/gates.sh` (it caches; prints only failure tails). A red gate → one
  fresh implementer: `fix gates: <ids> · log: <path> · plan: <path>`, then gates again.
  Twice red on the same gate → ask the user.
- Keep each report's "Insight candidates" and "For reviewers" lines; drop the rest.

## 2 — review round 1 (full)

Gates green for the current state, then in **one message**:

- `plan-verifier`: `plan: <path> · spec: <path> · context: <pack> · mode: full ·
  round: 1` (+ `run-integration` when the plan's Verification has `--integration` and
  Docker is up).
- `architecture-reviewer`: `plan: <path> · base: <Base from header> · round: 1`
  (+ the implementers' "For reviewers" lines, one line each).

Both default to their frontmatter model (sonnet). With `--opus-review` or
`Review risk: high` in the plan, pass `model: opus` to both for **round 1 only**.

Then: `./scripts/review-delta.sh save r1`.

Verdicts: both PASS → step 4. Otherwise collect into one list: plan-verifier `FAIL-*`
rows, architecture `CRITICAL`/`HIGH` findings. `CANNOT_VERIFY` caused by the
environment (no Docker, missing toolchain) is reported to the user, not "fixed".
`INCOMPLETE` with "Not traceable" files → those files go into the fix brief
("explain or revert").

## 3 — fix rounds (N = 2 … max-rounds + 1)

1. **One** fresh `implementer` with the whole batch: `fix round: <N> · plan: <path> ·
   context: <pack> · findings: <ID — file:line — expected behaviour> · reports:
   <paths of the previous round's reports>`. All findings of the round in one brief.
2. `./scripts/gates.sh` until green (as in step 1).
3. `delta-reviewer`: `plan: <path> · round: <N> · delta: r<N-1> · previous reports:
   <paths> · fixing: <IDs>`.
4. `./scripts/review-delta.sh save r<N>`.
5. Verdict:
   - `PASS` → step 4.
   - `FAIL` → next round with the still-failing IDs + new findings.
   - `ESCALATE` → run step 2 again as round N+1 (both full reviewers, sonnet), then
     continue here.
   - Max rounds reached and still failing → stop; show the open IDs with one line each
     and ask: another round / accept and finish / stop to re-plan.

Continue (SendMessage) a reviewer instead of respawning only when it reviews the same
feature again and its context is small; fix-round implementers are always fresh.

## 4 — wrap-up

1. Summary to the user (≤ 30 lines): plan, mode, rounds run, final verdicts with report
   paths, gates state, changed files count (`git status --short | wc -l`), what was not
   verified (`CANNOT_VERIFY`, skipped integration) and why.
2. MEDIUM/LOW architecture findings that were not fixed: list them and ask whether to
   run one more fix round for them.
3. `engineering-insights` WRAP-UP (root `CLAUDE.md`): from the collected "Insight
   candidates" only, append what is new, verified and non-obvious; nothing qualifies →
   write nothing.
4. Next steps for the user, not run automatically: `doc-writer` for the README/docs;
   `/pr-self-review` before opening the PR (it reuses the gates cache); commit; then, in this
   same session, `/workflow-retro <slug>` to see where the agents lost tokens and time.

## Notes

- Re-running `/implement` on the same plan continues from the latest
  `.devdigest/review/<slug>/*-r<N>.md`: ask whether to resume at the next fix round or
  start over.
- To re-enable test-writer later: insert `test-writer` (mode `backfill`, the plan-verifier
  FAIL rows about tests) between steps 2 and 3, before the implementer fix brief.
