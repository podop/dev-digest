# Context pack: Commit test gate (PreToolUse hook)

## INSIGHTS that apply
- None. No package is touched. A grep of the package `INSIGHTS.md` files for gates/hook/`.devdigest` found nothing relevant, and there is no root `INSIGHTS.md`. Do not edit any INSIGHTS file.

## Verified facts
- [F1] `.claude/settings.json:1-38` has 8 `permissions.deny` entries; `Bash(git push*)` is at :11. `hooks.UserPromptSubmit` (timeout 15) and `hooks.Stop` (timeout 30) both run `engineering-insights.py`. There is no `PreToolUse` entry.
- [F2] `scripts/gates.py:31,41-52`: `ROOT = dirname(dirname(abspath(__file__)))`. `state_hash()` hashes `rev-parse HEAD`, then `diff HEAD --binary -- . ':(exclude)*.md'`, then each untracked non-md path with its content, and keeps 16 hex chars. `main()` is guarded by `__main__` (:205), so importing the file has no side effects. Reports live in `.devdigest/gates/<state>.json`. Never read `latest.json` as the current report.
- [F3] `scripts/gates.py:72-100,180-193`:
  - `root:drift` always runs; every package gets `<pkg>:typecheck` and `<pkg>:lint`.
  - Further gates: `server:arch`, `server:unit`, `server:integration` (its exit can be null), `reviewer-core:test`, `client:test`, `mcp:test`. e2e has no test gate.
  - The result is `report["gates"][id].exit`, an int or null. `--only`/`--packages` merge into the same per-state report.
- [F4] `.gitignore:15-20` ignores `__pycache__/` and the `.devdigest/{cache,self-review,gates,review,research}/` folders one by one. `.devdigest/commit-gate/` is NOT ignored. If the log is not ignored, it counts as an untracked non-md file: it changes the state and orphans every cached report.
- [F5] `python3` is 3.9.21; `git` is 2.47.3. `rev-parse --path-format=absolute` needs git ≥ 2.31.
- [F6] Spec §2/§7 (hooks docs):
  - stdin has `tool_name`, `tool_input.command`, `cwd`, `session_id`, and `agent_type` for subagents.
  - Exit 2 blocks, and stderr becomes the reason. Exit 0 with no output means no decision.
  - On a crash or timeout the call proceeds.
- [F7] Fail-open pattern to copy: `.claude/hooks/engineering-insights.py:153-158` (`try: main() except Exception: sys.exit(0)`). Here it must also depend on the phase (FR11).
- [F8] Claude commits usually look like `git commit -m "$(cat <<'EOF'\n…\nEOF\n)"`. The body may hold an unbalanced `'` or the words "git commit". Gate on the outer argv; never crash on the body.
- [F9] The implementer never commits (`implement/SKILL.md:40`, `agents/implementer.md:32`), so `/implement` is unaffected. `pr-self-review/SKILL.md:21` ("no PreToolUse gate runs it") stays true. Edit neither file.
- [F11] Detection grammar (FR2/FR3; planner design):
  - Remove heredoc bodies first. A body fed to `sh`/`bash` is parsed as a script.
  - Split with `shlex` (posix, `punctuation_chars`, newline as a separator) into simple commands at `&& || ; | & ( ) { } !`. Drop redirections, including a digit right before `>`.
  - Track `cd <dir>`. Skip leading `VAR=val` and the wrappers `env command exec nohup time nice`.
  - When the argv0 basename is `git`, skip the global options `-C -c --git-dir --work-tree --no-pager -p -P --bare --literal-pathspecs --exec-path --namespace`, `=` forms included.
  - `commit`/`commit-tree` → gated. Expand `-c alias.X=` and config aliases. A `!` alias containing git and commit → gated.
  - Recurse at most 4 levels into `$(…)`, backticks, and the argument of `sh -c`/`bash -c`/`eval`.

## Mirrors
- `.claude/hooks/engineering-insights.py`: shebang and usage docstring, a stdlib `git()` helper on `subprocess.run([...], capture_output=True, text=True)`, a fail-open wrapper.
- `.claude/skills/pr-self-review/scripts/test_collect.py`: one `unittest` class per concern, the run command in the docstring, `unittest.main(verbosity=2)`.
- Hermetic fixture:
  - Temp repo: `git init -q -b main`. Env: `GIT_CONFIG_GLOBAL=<tmp>/empty`, `GIT_CONFIG_NOSYSTEM=1`, `HOME=<tmp>`, `GIT_AUTHOR_*`/`GIT_COMMITTER_*` set, `DEVDIGEST_COMMIT_GATE` removed.
  - Copy in the hook, `scripts/gates.py` and the real `.gitignore`. Seed `server/src/a.ts`, `client/src/b.ts` and `README.md`, then commit.
  - Report: `<tmp>/.devdigest/gates/<state>.json`, with the state from `python3 <tmp>/scripts/gates.py --state`. The path is ignored, so writing it keeps the state.
  - Run the hook as `[sys.executable, <tmp>/.claude/hooks/commit-gate.py]` with JSON on stdin. In-process tests load the temp copy, so nothing is logged to the real `.devdigest/`.

## Skill map (from routing.json)
| Step | Files | Skills | Key rules |
|---|---|---|---|
| S1–S3 | `.claude/hooks/*.py`, `.gitignore` | none (no `.claude/**`/root rule) | NFR3/NFR4: argv-only git, stdlib |
| S4 | `docs/commit-gate.md`, `.claude/agents/README.md` | none | link, don't copy |
| S5 | `.claude/settings.json` | none | other keys unchanged (AC1) |
No `*/src/vendor/shared/**` file is touched, so drift_check does not apply.

## Risks
- A missed form passes silently. The FR4 fallback, recursion and wrapper handling reduce this; S4 documents what remains.
- A false positive blocks a non-commit. The AC3, heredoc and quoted-argument cases test for it, and the block text tells the agent how to recover.
- A crash after identification blocks every commit. The escape hatch is `DEVDIGEST_COMMIT_GATE=off`, set at launch.
- S5 activates the hook in the running session. After that, the eval-trends commit needs a green `gates.sh` (client:test takes ~89 s).
- The worktree's `gates.py` is code from the same project, so loading it is fine. The identity `rev-parse` runs before any `diff`.

## Notes for reviewers
- Architecture: pure `find_commits`, `decide` and `format_block`, kept apart from the I/O (`git`, `append_log`, `main`). `gates.py` is unchanged. The tests are not in `gates.sh` (D7).
- Security: no `shell=True`, `os.system` or `eval`. `-c` values never reach git. Pathspecs go after `--`. The log keeps the command at ≤ 500 chars and no env; stderr is capped at 1,200.
