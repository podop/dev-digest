# Workflow retro ledger

One row per `/workflow-retro` run (manual only — nothing runs it automatically). Rows are appended by
`scripts/workflow-retro.sh --append-ledger`; the metric columns come from the transcripts on disk, so runs are
comparable. *Tokens total* includes cache reads; *Fresh* = total − cache read.

| Date | Label | Session | Agents (nested) | Peak ∥ | Wall | Tokens total | Fresh | Cache read % | Tool calls | Verdict | Top actions |
|---|---|---|---|---|---|---|---|---|---|---|---|
