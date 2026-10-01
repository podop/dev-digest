# 07 — Blast Radius (server + MCP)

UI half: [`client/specs/07-blast-radius.md`](../../client/specs/07-blast-radius.md).
Course slot: **L04 homework — Blast Radius** (the lab built `devdigest-mcp` and
left `get_blast_radius` as a stub).
Status: **in progress** (2026-10-01).

## Goal

Answer the reviewer's question "what else in the repo can this diff hit?" by
**reading** the index `repo-intel` already built at clone time —
`repoIntel.getBlastRadius(repoId, changedFiles)` — and mapping it to the
`BlastRadius` contract. No re-parsing, no AST/import-graph rebuild, no model
call. The same response feeds the Overview block and the MCP tool.

## Out of scope

- PR description + demo video (done by a human).
- An LLM-written summary (summary is a string built from numbers).
- Changing how `repo-intel` indexes or ranks (limits stay in
  `modules/repo-intel/constants.ts`: `MAX_CALLERS_PER_SYMBOL`, `BFS_DEPTH`).

## Acceptance criteria

1. New module `src/modules/blast/` (onion layout, wired via its own
   `composition.ts`; reaches repo-intel only through `c.modules.repoIntel`)
   exposes `GET /pulls/:id/blast`. It loads the PR's changed files and calls
   `getBlastRadius(repoId, changedFiles)` exactly **once** per request.
2. Mapping (pure domain function): the facade's flat `callers[]` are grouped
   by `viaSymbol` into `downstream[]` (`callers[{ name, file, line }]`, where
   `name` = caller symbol). Each group's `endpoints_affected` /
   `crons_affected` are the de-duplicated union of `factsByFile[file]` over
   that group's caller files. Groups are ordered by highest caller `rank`
   (desc), callers inside a group by rank desc. A caller whose file is the
   file that declares the symbol is never listed (defensive, even though the
   facade already drops it). Unit-tested.
3. `summary` is a deterministic string built from counts (symbols, callers,
   endpoints, crons) — no LLM.
4. Honest degradation: when the facade returns `degraded: true`, the response
   carries `degraded` and `reason` (`flag_off | index_failed | index_partial |
   repo_too_large | no_data`) through to the client. The shared `BlastRadius`
   contract gains these as optional fields in **both** `vendor/shared` copies
   (byte-identical, `check-shared-drift.sh` green).
5. The route response validates against the `BlastRadius` contract (zod
   response schema built from it); an inject test reads the fields.
   Unknown PR → 404 `not_found` envelope.
6. Request logs show the index being **read** (e.g. one info line with repo id,
   changed-file count, degraded/reason, caller count) — not a reindex.
7. **P3 — Prior PRs touching these files**: `GET /pulls/:id/history` returns
   the `PrHistory` contract — previously merged PRs of the same repo that
   changed any of this PR's files (excluding this PR), newest first, capped
   (constant), with `files_overlap`. Data comes from GitHub (via the existing
   GitHub adapter / port); failure or no token degrades to an empty list, never
   a 500.

## MCP (`mcp/`)

8. `get_blast_radius` replaces the stub: resolves `repo` + `pr_number` like the
   other tools, calls `GET /pulls/:id/blast` and returns that map (same
   changed symbols, callers, endpoints, crons, degraded/reason as the UI) as
   compact structured content + a short text rendering. Nothing is computed
   anew beyond an optional `max_callers` trim.
9. Follows the lab rules: short description saying when to call it, clear arg
   schema, concise output, a useful `ToolError` (with next step) for an
   unknown repo/PR, `readOnlyHint: true`. Degraded results say so explicitly
   (never imply "no impact"). Covered by the mcp tool tests.

## Open questions

- None blocking. Caller links point to GitHub blob at the PR head sha (files
  outside the diff).
