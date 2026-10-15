# Development Plan: Commit test gate (PreToolUse hook)
Packages: none (harness) · Base: feat/evals@f385adc + unrelated uncommitted work · Spec: specs/2026-10-15-commit-test-gate.md
Context pack: docs/plans/2026-10-15-commit-test-gate.context.md
Execution: single-agent (planner default; Open q. 1)

## Goal
Spec §1: a deterministic PreToolUse hook blocks Claude's `git commit`/`commit-tree` unless the gates report for the current state is green for the touched packages. Ships with hermetic tests and a docs page whose caught case waits for real sessions.

## Out of scope
Spec §3. Do not edit `scripts/gates.py`, the spec, packages or `pr-self-review`. No fabricated case.

## Decisions
- One file, `.claude/hooks/commit-gate.py`, with tests beside it (D10). All git calls go through one helper `git(cwd, *args)`: argv, no shell, 5 s timeout (NFR3) [F6].
- State: `importlib`-load `<toplevel>/scripts/gates.py` and call `state_hash()`, which equals `gates.sh --state`, worktrees included [F2]. Set `sys.dont_write_bytecode` first. Missing file → `internal-error`.
- "This project" = the repo's `--git-common-dir` equals the hook repo's (3 dirnames up from `__file__`, not `$CLAUDE_PROJECT_DIR`) (EC5).
- Log: `<hook repo root>/.devdigest/commit-gate/log.jsonl`. Worktree commits log there too.
- Several commits in one call → evaluated in order; the first block wins.
- Reason precedence: `no-report` > `gates-failed` > `missing-test-gate`. A required gate with `exit: null` counts as missing.
- `--packages` = packages lacking their test gate. On `no-report`: every touched package.

## Steps
H=`.claude/hooks/` · T=`H/test_commit_gate.py` · **Done** = `python3 .claude/hooks/test_commit_gate.py` (repo root) exits 0

### S1 — Tokeniser and gated-commit detection [harness]
- Files: A `H/commit-gate.py`; A `T`
- Change:
  - `main()` reads stdin JSON. If `tool_name != "Bash"` or the text has no `"git"`, exit 0 with no subprocess.
  - `find_commits(command, cwd) -> list[Commit]` per the [F11] grammar. Its only git call is `git config --get alias.<x>` for a non-builtin subcommand.
  - On a shlex `ValueError` or depth overflow: an `unparsed` commit if both words `git` and `commit` occur (FR4).
  - `Commit` = {kind, dir, git_opts (`-C`/`--git-dir`/`--work-tree` only, never `-c`), args}.
  - Wrapper: an error before identification → exit 0; after → `internal-error` block (FR11).
- Rules: py 3.9 stdlib (NFR4): `from __future__ import annotations`, no `match`. Never execute the command text (NFR3) [F8].
- Covers: AC2, AC3, AC4, AC12, AC22 (detection halves)
- Tests (in-process, on the temp copy): AC2 forms + a config alias → 1 commit each; AC3 → exit 0, no stdout, patched `git` uncalled; heredoc containing `don't`; `$(touch <tmp>/pwn)` → no file; raising parser on `ls` and bad stdin → exit 0.
- Done when: **Done** green

### S2 — Repo, path set, decision, block message [harness]
- Files: M `H/commit-gate.py`; M `T`
- Change, per commit:
  - dir = `-C`, else the `cd` target, else `cwd` (nearest existing ancestor). `git rev-parse --path-format=absolute --show-toplevel --git-common-dir`: "not a git repository" or a foreign common dir → allow.
  - Path set (FR5) = union of `diff --cached --name-only -z`, `diff --name-only -z` (with `-a`/`--all`, or `a` in a short cluster before an argument letter `mFcCt`), and `diff HEAD --name-only -z -- <pathspecs>`.
  - `unparsed`, `--pathspec-from-file`, or a pathspec with `$` or a backtick → staged ∪ `diff HEAD`.
  - `commit-tree` → staged ∪ tracked ∪ untracked, never docs-only.
  - Empty or all-`.md` path set → allow without reading the report (FR6).
  - Otherwise compute the state and read `.devdigest/gates/<state>.json`. Absent → `no-report`. Bad JSON, no `gates` dict, or a non-int non-null `exit` → `internal-error`.
  - Pure `decide(report, packages)` applies FR7 a–c with the test-gate map [F3].
  - `format_block()` writes the exact 4 lines of §7, ≤ 1,200 chars. Lists are truncated with `…`; a missing state reads `state unknown`. Exit 2.
- Rules: an allow prints no stdout and never emits a JSON `allow` (FR9). A package = a first path segment that is one of the 5 package dirs.
- Covers: AC2, AC4–AC10, AC12, AC16–AC18, AC22
- Tests (black-box subprocess, temp repos, fixture reports keyed by the copied `gates.py --state`): one case per AC; AC17 via `git worktree add` + an unrelated repo; AC18 via `merge --no-commit --no-ff`; AC22 via 3 runs with the same decision.
- Done when: **Done** green

### S3 — Block log, bypass, ignore entry [harness]
- Files: M `H/commit-gate.py`; M `.gitignore` (+ `.devdigest/commit-gate/`); M `T`
- Change:
  - `append_log()` never raises. It appends one §8 JSON line per block, bypass or internal error.
  - `ts` = `datetime.now().astimezone().isoformat(timespec="seconds")` (log only, NFR2). `command[:500]`, no env values (NFR5).
  - Bypass: hook env `DEVDIGEST_COMMIT_GATE == "off"`, checked after the docs-only rule. Log `bypassed`, reason `env-off`, state best-effort. Errors still exit 0 (FR10).
  - An error before identification is logged as `internal-error` with reason `allowed: <ExcType>`.
- Rules: the log dir must be ignored [F4].
- Covers: AC11, AC12, AC13, AC19
- Tests: env bypass vs command-text bypass; 2,000-char command → all fields, length 500; `git -C <tmp> check-ignore -q <log>`; 3 blocks → 3 lines.
- Done when: **Done** green

### S4 — Docs page skeleton [docs]
- Files: A `docs/commit-gate.md`; M `.claude/agents/README.md` (a link paragraph under "Shared guardrails")
- Change: the page covers:
  - the decision rule (link to the spec), the launch-time escape hatch, the test command;
  - a 3–5 line eval-vs-hook note and the difference from `docs/pr-self-review-plan.md` §9;
  - risks: EC9, EC11, other interpreters, `xargs`/`find -exec`;
  - "Caught cases": the §8 template plus "none recorded yet (AC14)".
- Covers: AC14 (skeleton only; the case is manual and comes later)
- Tests: none. Done when: `grep -c "Caught cases" docs/commit-gate.md` ≥ 1 and `grep -c "commit-gate.md" .claude/agents/README.md` ≥ 1

### S5 — Register the hook (LAST) [harness]
- Precondition: **Done** fully green after S1–S3.
- Files: M `.claude/settings.json`; M `T` (AC1 test)
- Change: add `hooks.PreToolUse = [{matcher:"Bash", hooks:[{type:"command", command:"python3 \"$CLAUDE_PROJECT_DIR/.claude/hooks/commit-gate.py\"", timeout:10}]}]`, with no `if` and no `onFailure`. Leave the other keys untouched [F1]. The AC1 test parses the real file. While HEAD's copy has no `PreToolUse`, the other keys must equal HEAD's.
- **From here on every Claude `git commit` in this repo is gated**, including this feature's and the eval-trends commits.
- Covers: AC1, AC15; AC20 and AC21 manually after merge (see Verification)
- Done when: **Done** green and `jq '.hooks.PreToolUse|length' .claude/settings.json` = 1

## Execution
- Mode: single-agent. One harness area, 6 files, no contract or DB change.
- W1: S1→S5 in order. The hook tests are not in `gates.sh` (D7), so the implementer and reviewers run **Done** explicitly.

## Contracts & migrations
None; the gates report is read-only [F2, F3].

## Verification
- **Done** + `./scripts/gates.sh` (the eval-trends diff vs main adds the client and server gates).
- Manual, in a fresh session: AC20; AC21 with `session_id` `ac21-perf` (never a caught case); AC14 after real sessions.
- Review risk: high (untrusted command parsing) → round 1 on opus.

## Open questions / assumptions
1. Execution mode — default: single-agent.
2. Forms beyond FR2 (wrappers, subshells, heredocs, a missing `cd` target) — default: conservative, so they block more, never less.
3. A non-builtin subcommand costs one `git config` call, so NFR1's "no git" holds for builtins (all AC3 cases) — default: accept.
4. Bypass is checked after the docs-only rule, so only would-be-gated commits get a `bypassed` line — default: accept.
5. AC1's byte-identity check against HEAD runs only until the registration is committed — default: accept.
