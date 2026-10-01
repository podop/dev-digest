---
name: workflow-retro
description: "Workflow retrospective (manual only): after a multi-agent run (/implement, /pr-self-review, a Workflow, a specreator → planner → implement pipeline) collects tokens, cache reads, tool calls, duration, spawn order and parallelism per agent (nested subagents included), finds duplicated context, overloaded roles and wasted re-runs, and proposes concrete changes to agents, skills and orchestration. Reports in chat and appends one row to docs/retros/ledger.md. Use only when the user types /workflow-retro."
disable-model-invocation: true
argument-hint: "[<label>] [--deep] [--session <id>] [--since <ISO>] [--until <ISO>] [--no-ledger]"
metadata:
  version: "1.0.0"
  type: "workflow"
---

# /workflow-retro — how did the last multi-agent run go?

Arguments: `$ARGUMENTS`

Manual only (`disable-model-invocation`): no hook, agent or other skill starts it.
It never edits agents, skills, scripts or code — it **proposes**; the user decides.
The only file it writes is one row in `docs/retros/ledger.md` (skip with `--no-ledger`).

## Modes

| Mode | Source | When |
|---|---|---|
| **in-context** (default) | this conversation: the `<usage>` blocks of task notifications (`subagent_tokens`, `tool_uses`, `duration_ms`), the agents' short reports, what the lead did between them | the run happened in this session and you can still see it |
| **`--deep`** | transcripts on disk via `./scripts/workflow-retro.sh` (`~/.claude/projects/<repo>/<session>.jsonl` + `<session>/**/agent-*.jsonl`) | always more accurate; required when agents spawned agents, when the context was compacted, or the run was in another session |

Why deep exists: a parent's `subagent_tokens` covers that agent's own calls only — what
its children (nested agents, workflow agents) spent is in their own transcripts. In-context
numbers are a **lower bound**; say so in the report.

## 1 — scope

1. `label` = first argument, or the plan/feature slug of the run (`project-context`,
   `pr-self-review-r2`). Ask only if neither exists.
2. Window: `--since/--until` if given; otherwise from the run's first agent spawn to now.
   In deep mode pass the same window to the script so earlier work in the session is
   not counted.

## 2 — collect

- **in-context**: list every agent of the run in spawn order from the notifications you
  received: type, description, model, `subagent_tokens`, `tool_uses`, `duration_ms`, which
  ran in parallel (spawned in one message), verdict/STATUS of its report.
- **deep**: `./scripts/workflow-retro.sh [--session <id>] --since <ISO> [--until <ISO>]`
  (markdown) or `--json`. It reports per agent: fresh input, cache write, cache read,
  output, API calls, peak context, tool calls by name, duration, depth/parent; plus spawn
  order, peak concurrency, files read by ≥ 2 agents and commands run by ≥ 2 agents.
  Read the table; open a transcript only to confirm one specific claim (`grep`, never
  `cat` a whole `.jsonl`).

Never paste transcripts or full reports into the chat.

## 3 — analyse

Go through every check; each finding needs a number or a quote as evidence.

| # | Check | Signal | Typical action |
|---|---|---|---|
| A1 | Cost share | one agent > 40 % of tokens, or lead > subagents | split the role, or move lead work into an agent |
| A2 | Duplicated context | same file read by ≥ 2 agents; plan/spec/INSIGHTS re-read every round | pre-load it into the context pack, pass a path + "already summarised" |
| A3 | Re-run commands | same gate/test command by ≥ 2 agents or ≥ 2× per state | cite `gates.sh` cache; `--only <id>` |
| A4 | Overloaded role | peak context > 200k, > 120 API calls, or report says PARTIAL | split into waves / steps, fresh agent per wave |
| A5 | Cache efficiency | cache read < 80 % of input on long agents; many cache writes | stable prompt prefix, continue instead of respawn (only small contexts) |
| A6 | Parallelism | independent agents ran sequentially, or peak ∥ caused gate/file conflicts | spawn in one message / lower concurrency |
| A7 | Rounds | review rounds > 2; same finding re-opened; ESCALATE | sharper fix brief (`file:line` + expected), earlier test |
| A8 | Hand-offs | lead relayed long reports; agent asked for info another agent had | short-form returns, file artifacts |
| A9 | Friction & ease | per agent: what blocked it (BLOCKED, retries, wrong paths, missing tool), what was quick | prompt or tool-list fix in the agent file |
| A10 | Gaps | what nobody checked (CANNOT_VERIFY, skipped integration, untested AC) | add the check to the right agent/skill |
| A11 | Model fit | opus on mechanical work / sonnet failing judgement work | change frontmatter model or `--opus-review` default |

## 4 — report (chat)

```
# Workflow retro — <label> · <date> · mode in-context|deep
Run: <agents> agents (<nested> nested) · peak ∥ <n> · wall <m> min · tokens <total> (fresh <f>, cache read <p>%) · tool calls <n>
Verdict: <one line: healthy / wasteful / blocked — main reason>

## Timeline
| # | Agent | Model | ∥ group | Tokens | Tools | Duration | Outcome |

## Findings
- A2 — <evidence> → <impact in tokens or minutes>

## Per-agent notes
- <agent>: hard — <…>; easy — <…>; duplicated — <…>; missed — <…>

## Proposed changes (ranked by saving)
1. <file to change> — <change> — expected saving <~tokens/min> — <check id>

## Not measured
- <what this mode could not see, e.g. nested spend in in-context mode>
```

≤ 60 lines. Proposals name a concrete file (`.claude/agents/<x>.md`, a skill, a script,
`.claude/agents/README.md` Token budget) and one change each; at most 5, ranked.

## 5 — ledger

Unless `--no-ledger`:

```
./scripts/workflow-retro.sh --append-ledger --label <label> [--session <id>] --since <ISO> \
  --verdict "<healthy|wasteful|blocked>: <reason ≤ 8 words>" --actions "<top 1–3 proposals, ;-separated>"
```

The script computes the metric columns from disk even in in-context mode (one row per
run, so the trend between runs is comparable). Then show the appended row and the
previous 3 rows of the same label, if any, with the trend in one line ("tokens −18 %
vs last run").

## Not this skill

Engineering lessons about the code go to `INSIGHTS.md` (`engineering-insights`), not here.
Applying a proposal is a separate, user-approved change.
