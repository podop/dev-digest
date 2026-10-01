# specs (cross-module)

Feature specs that touch **two or more modules** (`server`, `client`, `reviewer-core`,
`e2e`, `mcp`). One file per feature: `<YYYY-MM-DD>-<feature-slug>.md`, one Goal and one
acceptance-criteria list, per-module subsections only where the modules differ.

A feature that touches one module lives in that module's `specs/` instead.

Specs are written by the `specreator` agent (`claude --agent specreator`,
[`.claude/agents/specreator.md`](../.claude/agents/specreator.md)) and planned by the
`implementation-planner`. They describe *what* and *why* — scenarios, requirements,
workflow/communication diagrams, contracts, edge cases, NFRs, acceptance criteria —
never file layout or code.
