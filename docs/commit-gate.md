# Commit test gate

A deterministic `PreToolUse` hook that blocks Claude's `git commit` / `git commit-tree`
unless the cached gates report for the current working-tree state is green for the
packages the commit touches. Spec: [`specs/2026-10-15-commit-test-gate.md`](../specs/2026-10-15-commit-test-gate.md).
Code: [`.claude/hooks/commit-gate.py`](../.claude/hooks/commit-gate.py), registered in
[`.claude/settings.json`](../.claude/settings.json) (matcher `Bash`, timeout 10 s).

## Decision rule

For a gated commit the hook builds the path set (staged, plus tracked changes with `-a`,
plus explicit pathspecs), then:

1. empty or all-`.md` path set -> allow, report not read;
2. no report `.devdigest/gates/<state>.json` for the state (`./scripts/gates.sh --state`) -> block `no-report`;
3. any gate with a non-zero exit -> block `gates-failed`;
4. `root:drift`, or the test gate of a touched package (`server:unit`, `client:test`,
   `reviewer-core:test`, `mcp:test`, `e2e:typecheck`), absent or skipped -> block `missing-test-gate`;
5. otherwise allow silently.

The hook never runs gates itself: the agent runs `./scripts/gates.sh` (the block message
names the command) and retries. A malformed report or a git failure after the commit was
identified blocks as `internal-error`; an error before that lets the call through.
Blocks, bypasses and internal errors are appended to `.devdigest/commit-gate/log.jsonl`
(git-ignored).

## Escape hatch

Launch Claude Code with `DEVDIGEST_COMMIT_GATE=off` in its environment: gated commits pass
and are logged `bypassed`. The variable typed inside the command has no effect, so the
agent cannot set it.

## Tests

```
python3 .claude/hooks/test_commit_gate.py     # repo root, python3 >= 3.9, stdlib only
```

Not part of `gates.sh` (spec D7). Fixtures are temp git repos; nothing touches the real `.devdigest/`.

## Evals vs hooks

Evals measure probabilistic behaviour against a threshold: a prompt passes 87% of the
time and that is a result. Some rules must hold every time, whatever the model decides:
no commit without green tests. That is a hook: plain code on the tool call, no LLM,
same input and report give the same decision. Evals for the probabilistic, hooks for the critical.

## Not the pr-self-review gate

[`pr-self-review-plan.md`](pr-self-review-plan.md) section 9 plans a review gate on push/PR
(PASS/BLOCK from a review) and it is deliberately not installed. This hook is narrower and
earlier: a test gate on commit, no review involved. It neither implements nor replaces section 9.

## Residual risks

- EC9: if the hook crashes, times out or `python3` is missing, Claude Code lets the call proceed.
- EC11: the agent can edit `.claude/settings.json` or the hook to disable the gate; nothing prevents it.
- Git started from another interpreter or a script file (`python -c`, `node -e`, `./x.sh`),
  and through `xargs` or `find -exec`, is not detected. `merge`, `cherry-pick`, `revert`,
  `rebase`, `am` and `stash` are not gated.
- Commits a human makes outside Claude Code are not gated.
- Partial staging: the tested state is the whole tree, so a commit of one file passes when the whole tree is green (EC3).

## Caught cases

One real case from `.devdigest/commit-gate/log.jsonl` goes here after real sessions (AC14).
Template, one entry per case:

| Field | Value |
|---|---|
| Date | |
| Task | |
| Agent | main session or subagent type |
| Command attempted | |
| Hook reason (verbatim) | |
| Agent's next action | |
| Outcome | |
| Lesson | |

None recorded yet (AC14).
