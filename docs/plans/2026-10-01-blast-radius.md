# Development Plan: Blast Radius (L04 homework)
Packages: server, client, mcp, e2e · Base: feat/lab4-mcp@96c64d6 · Spec: server/specs/07-blast-radius.md (S-AC), client/specs/07-blast-radius.md (C-AC)
Context pack: docs/plans/2026-10-01-blast-radius.context.md
Paths: `B/`=`server/src/modules/blast/` · `BC/`=`client/src/app/repos/[repoId]/pulls/[number]/_components/OverviewTab/_components/BlastRadiusCard/` · `T/`=`server/test/`

## Goal
The PR Overview gets a Blast radius card, fed by `GET /pulls/:id/blast` (index read only). MCP `get_blast_radius` returns the same map. P3: `GET /pulls/:id/history` from GitHub, [] on failure.

## Out of scope
- PR text/video; LLM; repo-intel indexing/limits [F3]; `pr_brief`.

## Decisions
- `modules/blast/` mirrors smart-diff [I6]. Composition calls `c.repoIntel.getBlastRadius` (= `c.modules.repoIntel.service`, honours `overrides.repoIntel`) behind a local port, with structural types [I3][F2].
- Response schemas are the shared `BlastRadius`/`PrHistory` [I5].
- Degraded results lack `factsByFile`, so groups have no endpoints/crons [F1].
- P3 adds the port method `GitHubClient.listMergedPullRequests` [F5].
- MCP text is a short rendering (S-AC8): optional `text` arg on `ok()`; README rule updated.
- View toggle and expanded rows: local `useState` (ephemeral).

## Steps
### S1 — Contract degraded/reason [server, client]
- Files: M `server/src/vendor/shared/contracts/brief.ts` + client copy; M `T/contracts.test.ts`
- Change: add `BlastDegradedReason` (the 5 reasons in S-AC4) and give `BlastRadius` optional `degraded`/`reason`. [F6]
- Tests: parses with/without. Done when: `./scripts/check-shared-drift.sh` = 0; `./scripts/gates.sh`

### S2 — Domain mapping [server]
- Files: A `B/domain/types.ts` (structural BlastResult [F1]), `B/domain/blast-radius.ts` (`buildBlastRadius`, `blastSummary`); A `T/blast-domain.test.ts`
- Change: implements S-AC2/3. Callers are grouped by `viaSymbol`. A caller is dropped if its file declares the symbol (name+file). Each group gets the de-duplicated `factsByFile` union. Groups are ordered by max rank desc and callers by rank desc (ties: name/file/line). The summary comes from distinct counts (`"3 changed symbols · 7 callers · 2 endpoints · 1 cron"`). `degraded`/`reason` pass through. Pure.
- Tests (unit): each rule above + degraded.
- Done when: `cd server && pnpm test:unit -- blast-domain`

### S3 — Service, repo, route, wiring [server]
- Files: A `B/application/{ports,blast-service}.ts`, `B/infrastructure/repository.ts`, `B/http/{routes,schemas}.ts`, `B/composition.ts`; M `server/src/modules/{index,composition}.ts`, `T/composition.test.ts`
- Change:
  - Ports: `findPull(ws, prId) → {repoId, number, owner, name, files[]} | null` (workspace-scoped), `BlastIndexReader`, `Logger{info,warn}`.
  - `getBlast(ws, prId, log)`: an unknown PR throws `NotFoundError`. Otherwise it calls the facade **once** and logs one line with `{repoId, changedFiles, degraded, reason, callers}`.
  - Route: `GET /pulls/:id/blast` with `IdParams` and response 200 `BlastRadius`; passes `req.log`.
- Rules: [I1]–[I4][I6]; fastify schema-first.
- Tests: `T/blast-service.test.ts` (single call + args, 404, log); `T/blast.it.test.ts` (`overrides.repoIntel` + `overrides.llm` [I7]; reads every field; degraded; unknown uuid → 404 `not_found`).
- Done when: `./scripts/gates.sh --integration` [I10]; `cd server && pnpm arch:check`

### S4 — MCP get_blast_radius [mcp]
- Files: M `mcp/src/api.ts` (`getBlastRadius`), `mcp/src/tools/{get-blast-radius,shared}.ts`, `mcp/README.md` (row, 9 calls, text rule), `mcp/test/{tools,api}.test.ts`, `mcp/test/helpers.ts`
- Change:
  - resolveRepo → resolvePull → API; description = pack draft.
  - Output: `{repo, pr_number, summary, degraded, reason?, changed_symbols, downstream[{symbol, callers[{name,file,line}], endpoints_affected, crons_affected}], omitted_callers, next_step?}`.
  - The only computation is the `max_callers` trim, in group order.
  - Degraded: the text says "DEGRADED (<reason>) … NOT 'no impact'" and next_step says Resync.
  - `reason` uses `exactly<BlastDegradedReason>()`.
- Rules: [M1]–[M3]; mcp AGENTS.
- Tests: map; trim; degraded; `pr_not_found`; 404; contract; catalog [F8].
- Done when: `cd mcp && npm test && npm run typecheck && npm run lint`

### S5 — Client hooks [client]
- Files: M `client/src/lib/hooks/{keys,index}.ts`; A `client/src/lib/hooks/blast.ts`
- Change: `prKeys.blast`/`history`; `useBlastRadius`; `useResyncBlast(repoId, prId)` sends POST `/repos/:id/resync` and invalidates blast + `repoKeys.intelState` [F7].
- Rules: [C3][C4][C6]. Tests: via S6. Done when: `cd client && pnpm typecheck`

### S6 — Card: stats, tree, empty, degraded [client]
- Files: A `BC/{index.ts,BlastRadiusCard.tsx,helpers.ts,helpers.test.ts,styles.ts,BlastRadiusCard.test.tsx}`, `BC/_components/BlastTree/{index.ts,BlastTree.tsx,BlastTree.test.tsx}`; M `OverviewTab.tsx` (+`repoId`), `PrDetailView.tsx`, `client/messages/en/blast.json`
- Change: C-AC1–6, 9:
  - the stat row comes from `blastStats()`;
  - each row is a `<button aria-expanded>`: chevron, `<> name()`, `callerCount`; the first row is open;
  - `githubBlobUrl` links open in a new tab with `noopener noreferrer`, plain text without repo/sha;
  - endpoint chips use the globe icon, cron chips the amber clock;
  - empty states use `noDownstream`/`noSymbols`;
  - degraded shows a badge, the reason text and Resync;
  - loading uses Skeleton, errors use ErrorState.
- Rules: [C1][C2][C5][F10].
- Tests: stats; hrefs; empty; degraded + resync POST; toggle; fix PrDetailView.test [C8].
- Done when: `cd client && pnpm test -- BlastRadius && pnpm typecheck && pnpm lint`

### S7 — Graph + toggle [client]
- Files: A `BC/_components/BlastGraph/{index.ts,BlastGraph.tsx,helpers.ts,helpers.test.ts,BlastGraph.test.tsx}`; M card, `blast.json`
- Change: C-AC7: `view.*` buttons (aria-pressed); pure `graphLayout()` with 3 columns + edges; SVG `role="img"` + legend; `graph.empty`. No new dependency.
- Tests: layout; toggle; empty. Done when: `cd client && pnpm test -- BlastGraph`

### S8 — Prior PRs, server (P3) [server, client vendor]
- Files: M both `vendor/shared/adapters.ts` (`MergedPrSummary`, `listMergedPullRequests(repo,{limit})`), `server/src/adapters/github/octokit.ts`, `server/src/adapters/mocks.ts`; A `B/domain/{history,constants}.ts`; M B application/http/composition, `T/{github-octokit,blast-domain,blast-service,blast.it}.test.ts`
- Change:
  - Adapter: merged PRs by updated desc (scan 30), first page of files each, paths deduped [I8].
  - `selectPriorPrs`: excludes self, overlap ≠ ∅, newest first, max 10, `notes: ''`.
  - `getHistory`: unknown PR → 404; any error → warn + `{history: []}`.
  - Route: `GET /pulls/:id/history` → `PrHistory`.
- Rules: [F5][F6][I5][I9].
- Tests: octokit stub; selection; it: fields, throwing client → 200 [].
- Done when: drift green; `./scripts/gates.sh --integration`

### S9 — Prior PRs, client (P3) [client]
- Files: M `keys.ts`, `blast.ts` (`usePrHistory`, staleTime 5 min); A `BC/_components/PriorPrs/{index.ts,PriorPrs.tsx,PriorPrs.test.tsx}`; M card, `blast.json`
- Change: C-AC8: accordion + count Badge. Each row: `#n` + title (`githubPrUrl`), author, date [C7], files. Hidden when empty or on error.
- Tests: rows + links; hidden. Done when: `cd client && pnpm test -- PriorPrs`

### S10 — e2e flow [e2e]
- Files: A `e2e/flows/13-blast-radius.flow.json`: PR #482 Overview shows the card (stats or degraded notice).
- Done when: `./scripts/e2e.sh` passes flow 13

## Contracts & migrations
- `brief.ts` (S1) and `adapters.ts` (S8): `cp -r server/src/vendor/shared/. client/src/vendor/shared/` + drift check. No migration.

## Verification
- `./scripts/gates.sh --integration`; manual: indexed vs unindexed repo; Inspector call.
- PR text (lead): planner=plan, implementer=S1–S10, reviewers=rounds.

## Open questions / assumptions
- 0-caller symbols: not in tree, counted in stats.
- Never-opened PR has no `pr_files` → `no_data`.
- Resync is a 202 job — default: no polling.
- Catalog bound may need a bump — default: measured, with comment.
