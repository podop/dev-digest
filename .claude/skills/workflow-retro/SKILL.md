---
name: workflow-retro
description: "Retrospective of a finished multi-agent run (manual only). Reads the current session's transcript (~/.claude/projects/*.jsonl) and, per subagent, counts tokens, cache hit, time, tool calls and cost, plus overall parallelism; then finds problems — files several agents re-read, agents that came back to the orchestrator, agents that wrote outside their scope, pipeline steps that were skipped (INSIGHTS.md not updated, shared contracts not checked, no gates or review after code). Outputs a compact table in chat and up to 5 action items \"agent file → what to change\", and appends one row to docs/retros/ledger.md. Recommends only; never edits agents or skills. Use only when the user types /workflow-retro."
disable-model-invocation: true
argument-hint: "[<label>] [--since <ISO>] [--until <ISO>] [--session <id>] [--no-ledger]"
metadata:
  version: "2.0.0"
  type: "workflow"
---

# /workflow-retro — where did the agents lose tokens and time?

Arguments: `$ARGUMENTS`

**When:** right after a whole SDD workflow has run (spec → plan → `/implement` → review →
fixes), **in the same session** — the data comes from this session's transcript. It is the
last step of the pipeline: run the feature, see where agents lost tokens and time, tune the
prompts before the next feature. **Manual only** (`disable-model-invocation`): no hook,
agent or other skill starts it.

**Never** edits agents, skills, scripts or code — it recommends. The only file it writes is
one row in `docs/retros/ledger.md` (skip with `--no-ledger`).

## 1 — scope

- `label` = first argument, or the plan/feature slug of the run (`project-context`).
- Window: `--since/--until` if given; otherwise from the first subagent spawn of the run
  (look it up in your own context: the time of the spec/plan stage start) to now. A window
  keeps earlier work of a long session out of the numbers.
- `--session <id>` only to analyse another session; default is the newest transcript of
  this repo, i.e. the current one.

## 2 — collect (deterministic)

```
./scripts/workflow-retro.sh --since <ISO> [--until <ISO>] [--session <id>]      # markdown
./scripts/workflow-retro.sh ... --json                                             # for detail
```

If it prints `retro skipped` (fewer than 2 subagents in the window) → tell the user there
is nothing to compare and **stop** (no ledger row).

The script reads the lead transcript and every `agent-*.jsonl` of the session (nested and
workflow agents included — a parent's `subagent_tokens` does not count its children) and
prints:

- per agent: tokens, cache hit %, cost ≈ (prices in `scripts/workflow-retro-config.json`,
  an estimate), duration, API calls, peak context, top tools, and flags —
  `continued×N` (the lead had to SendMessage it), `re-ask` (hand-back says Clarification
  needed / BLOCKED / PARTIAL / "do it yourself"), `denied×N` (permission denials),
  `scope×N` (wrote outside its agent type's scope; config `scope`), `nested`;
- session: parallelism (peak and average), files read by ≥ 2 agents, commands run by ≥ 2
  agents, and **pipeline checks** — INSIGHTS wrap-up after code edits, shared-contract drift
  check after `@devdigest/shared` edits, gates after the last code edit, a migration for a
  schema change, a review after the last implementer.

Read the table; open a transcript only to confirm one specific claim (`grep`, never `cat` a
`.jsonl`). Write detection from Bash is heuristic — confirm a `scope` flag before reporting it.

## 3 — analyse

Every finding cites a number or a quote.

| Check | Signal | Typical action (agent file → change) |
|---|---|---|
| Cost share | one agent > 40 % of cost, or the lead > subagents | split the role / start the pipeline in a fresh session |
| Re-read context | a file read by ≥ 3 agents | put the facts in the context pack, pass "already summarised" |
| Re-run commands | same gate/test command by ≥ 2 agents | cite the `gates.sh` cache; `--only <id>` |
| Overloaded role | peak context > 200k or > 120 calls or PARTIAL | split into waves / smaller steps |
| Cache | hit < 80 % on agents with > 20 calls | stable prompt prefix; continue small contexts instead of respawning |
| Parallelism | avg ≪ peak, independent agents ran sequentially | spawn them in one message |
| Re-asks | `re-ask`, `continued`, `denied` | the brief or plan must pre-answer it (e.g. authorised exceptions, deletions approved at plan time) |
| Scope | `scope×N` (confirmed) | tighten the agent's write rules / give the step to the right agent |
| Skipped steps | a `MISSING` pipeline check | add the step to the skill/agent that owns it (`/implement` wrap-up, implementer self-check) |
| Rounds | > 2 review rounds, same finding re-opened | sharper fix brief, earlier test |

## 4 — report (chat, ≤ 50 lines)

```
# Workflow retro — <label> · <date>
Run: <n> agents · ∥ peak <p> / avg <a> · <wall> min · <tokens> (fresh <f>, cache hit <h>%) · cost ≈ $<c>
Verdict: healthy | wasteful | blocked — <main reason>

| Agent | Model | Tokens | Hit | Cost ≈ | Time | Tools | Flags |      (compact: top agents + totals)

Problems
- <check> — <evidence>

Action items (≤ 5, ranked by expected saving)
1. .claude/agents/<agent>.md → <what exactly to change> (saves ~<tokens/$/min>)
2. .claude/skills/<skill>/SKILL.md → …

Not measured: <cost is an estimate; Bash write detection is heuristic; …>
```

Action items always name a file (agent, skill, script, `docs/plans` template) and one
concrete change.

## 5 — ledger

Unless `--no-ledger`:

```
./scripts/workflow-retro.sh --append-ledger --label <label> --since <ISO> [--until <ISO>] \
  --verdict "<healthy|wasteful|blocked>: <reason ≤ 8 words>" --actions "<top 1–3 items, ;-separated>"
```

Then show the appended row and the trend against the previous rows in one line
("cost −30 % vs project-context").

## Not this skill

Lessons about the code go to `INSIGHTS.md` (`engineering-insights`). Applying an action item
is a separate change the user approves.
