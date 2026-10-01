# Workflow retro ledger

One row per `/workflow-retro` run (manual only — nothing runs it automatically). Rows are appended by
`scripts/workflow-retro.sh --append-ledger`; the metric columns come from the transcripts on disk, so runs are
comparable. *Tokens total* includes cache reads; *Fresh* = total − cache read.

| Date | Label | Session | Agents (nested) | Peak ∥ | Wall | Tokens total | Fresh | Cache read % | Tool calls | Verdict | Top actions |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 2026-10-01 | project-context | 05ff2ed0 | 15 (0) | 3 | 94m | 48.51M | 1.79M | 96% | 513 | healthy: 1 fix round, planner 26% of tokens | planner reads saved research reports instead of re-exploring (79 Bash calls); planner checks its defaults against spec ACs (AC12 contradiction cost a fix round); skill rule excerpts in the context pack (36 Skill loads over 8 implementers) |
