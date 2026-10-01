# Workflow retro ledger

One row per `/workflow-retro` run (manual only — the last step of an SDD pipeline, run in the same session).
Rows are appended by `scripts/workflow-retro.sh --append-ledger`; metrics come from the session transcript, so runs are
comparable. *Tokens total* includes cache reads; *Fresh* = total − cache read; *Cost ≈* uses `scripts/workflow-retro-config.json` prices (estimate).

| Date | Label | Session | Agents (nested) | Peak ∥ | Wall | Tokens total | Fresh | Cache hit | Cost ≈ | Tool calls | Verdict | Top actions |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 2026-10-01 | project-context | 05ff2ed0 | 15 (0) | 3 | 94m | 48.51M | 1.79M | 96% | $16.52 | 513 | healthy: 1 fix round, planner 26% of tokens | planner reads saved research reports instead of re-exploring (79 Bash calls); planner checks its defaults against spec ACs (AC12 contradiction cost a fix round); skill rule excerpts in the context pack (36 Skill loads over 8 implementers) |
| 2026-10-01 | onboarding-generator | 05ff2ed0 | 13 (0) | 2 | 103m | 33.42M | 1.27M | 96% | $11.57 | 352 | healthy: subagents -51% vs project-context; lead 42% | run each pipeline in a fresh lead session (lead ctx 320k = top cost); plan marks authorised do-not-touch exceptions inside the step (S6 implementer blocked on vendor/ui); ask file deletions at plan approval (classifier denied rm) |
