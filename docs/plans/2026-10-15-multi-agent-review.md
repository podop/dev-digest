# Development Plan: Multi-Agent Review (worktree A)
Packages: server, client · Base: feat/multi-agent-review@dafe6b0 (contracts+migration: db09602) · Spec: specs/multi-agent-review.md
Context pack: docs/plans/2026-10-15-multi-agent-review.context.md
Execution: multi-agent, 4 implementers (chosen by the user)
Paths: `reviews/` = `server/src/modules/reviews/`; `pr/` = `client/src/app/repos/[repoId]/pulls/[number]/_components/`

## Goal
Pick 2+ agents (PR page or `/multi-agent/new`, with estimates), run them in parallel as one parent run, compare on `/multi-agent/<id>` (Columns/Tabs, live status, trace, disagreements); Learn saves a finding to memory.

## Out of scope
- Spec §3; migrations/contracts [F7]; new tests, e2e, READMEs (Open questions); forbidden paths (spec boundaries)

## Decisions
- ≤ 4 implementers; no new tests (an existing test broken by an intended change may be minimally updated); review architecture-reviewer → plan-verifier; fix loop ≤ 2 iterations / ≤ 2 subagents — user
- AC3 wants 400 but the contract's `.min(1).max(20)` gives 422 [F3][I8] → local `RunReviewBody` has `agentIds: z.array(z.string().uuid()).optional()`; the service enforces one option + 1–20 ids → 400 `invalid_run_request`; non-uuid → 422 like `IdParams`
- `limit`: `z.coerce.number().int().optional()`, outside 1–20 → 400
- Optional `runBounded` executor dep (PQueue in `reviews/composition.ts`); absent → sequential, fakes stay green — [I1][F9]
- No new module: `buildReviewsModule` returns `{ service, multiAgent }` — [F20]
- Learn = `MultiAgentService.learn`; `actOnFinding` unchanged ([F5]). Idempotent: one tx: advisory lock `learn:<id>` → lookup `sources @> [{context}]` → insert — [I9][F8]
- Deleted agent → `agent_id/agent_name ''` (non-null contract); client keys by `run_id`, shows "Deleted agent"
- Results page polls 3 s while running; no SSE refetch (AC33: poll or SSE)
- `git mv` RunTraceDrawer/EvalCaseButton → `client/src/components/run-trace-drawer/`, `…/eval-case-button/` — frontend-ui-architecture §3
- New RunReviewPicker replaces RunReviewDropdown (folder + test deleted)
- `vendor/ui/nav.ts`: GLOBAL group only (spec allows)

## Recommendations not adopted
- 3 implementers (W3+W4 merged) — ~25 files, too big for one context

## Steps
### S1 — Bounded parallel executor + config [server]
- Files: M `server/src/platform/config.ts`, `server/.env.example` (append), `reviews/application/run-executor.ts`, `reviews/application/ports.ts`, `reviews/composition.ts`
- Change: `REVIEW_AGENT_CONCURRENCY` (int 1–20, default 4, [F10]); loop [F2] → `runBounded(jobs.map(j => () => runJob(j)))`, each task catches its error; diff/intent once
- Rules: [I1][I4]
- Covers: AC6, AC7, AC9
- Tests: — (reviews-service.test.ts stays green)
- Done when: `cd server && pnpm typecheck && pnpm exec vitest run test/reviews-service.test.ts --reporter=dot`

### S2 — Trigger accepts agentIds [server]
- Files: M `reviews/domain/types.ts`, `reviews/application/ports.ts`, `reviews/repository/run.repo.ts`, `reviews/repository.ts`, `reviews/application/review-service.ts`, `reviews/http/schemas.ts`, `reviews/routes.ts`, `server/test/reviews-service.test.ts` (:319 add `multi_agent_run_id: null`)
- Change: validate → dedupe → `getById` each (404 before any write); ≥ 2 ids: insert parent, runs with `multiAgentRunId`, log `{multiAgentRunId, prId, agentCount}`; 1 id = `agentId` path; response always has `multi_agent_run_id`
- Rules: [I7][I8]
- Covers: AC1–AC5, AC16, AC17, AC24
- Tests: one existing line updated
- Done when: S1 cmd + `pnpm exec vitest run test/run-integrity.it.test.ts test/reviews.it.test.ts --reporter=dot`

### S3 — Read model, list, estimates [server]
- Files: A `reviews/domain/multi-agent.ts`, `reviews/application/multi-agent-service.ts`, `reviews/repository/multi-agent.repo.ts`; M `reviews/application/ports.ts`, `reviews/repository/review.repo.ts` (export [F11]), `reviews/composition.ts`, `reviews/http/schemas.ts`, `reviews/routes.ts`
- Change: pure `groupFindings` (FR6/FR7), `runTotals`, `orderColumns`; runs only by `multi_agent_run_id` (CI excluded), review by `run_id` + findings, eval case + memory ids; list (≤ 20); estimates (last 10 `done`/agent); routes per spec §7, shared response schemas
- Rules: [I2][I3][I6][I10]; risk R2
- Covers: AC7–AC15, AC17, AC18, AC22, AC23
- Tests: —
- Done when: `pnpm typecheck && pnpm arch:check && pnpm lint`

### S4 — Learn [server]
- Files: M (under `reviews/`) the S3 files except review.repo.ts
- Change: `POST /findings/:id/learn` per spec §7; 404 unknown/foreign; log `{findingId, memoryId}`
- Rules: [I9][I11]; risk R3
- Covers: AC19–AC22, AC24
- Tests: —
- Done when: S3 cmd

### S5 — Client hooks [client]
- Files: M `client/src/lib/hooks/reviews.ts`, `keys.ts` (append `multiAgentKeys`), `index.ts`; A `lib/hooks/multi-agent.ts`
- Change: `useMultiAgentRun` (3 s poll while running), `useRepoMultiAgentRuns`, `useRunEstimates`, `useMultiAgentFindingAction` (optimistic, rollback); `useRunReview` + `agentIds`, invalidates `multiAgentKeys.all`
- Rules: [C4][C5]
- Covers: AC26, AC33, AC36
- Tests: —
- Done when: `cd client && pnpm typecheck && pnpm exec vitest run reviews.test --reporter=dot`

### S6 — Promote drawer + eval button [client]
- Files: `git mv` `pr/RunTraceDrawer/`, `pr/EvalCaseButton/` (see Decisions); M `pr/PrDetailView/PrDetailView.tsx`, `pr/FindingsPanel/FindingsPanel.tsx` [F12][F13]
- Change: move only
- Covers: AC38
- Tests: move with folders
- Done when: `pnpm exec vitest run RunTraceDrawer EvalCaseButton PrDetailView FindingsPanel --reporter=dot`

### S7 — PR page picker [client]
- Files: A `pr/RunReviewPicker/`; M `pr/PrDetailHeader/PrDetailHeader.tsx`, `client/messages/en/prReview.json` (`runReview.*` [C8]); D `pr/RunReviewDropdown/`
- Change: FR12/FR13; own popover of `Checkbox`es (Escape/outside close); N ≥ 2 → `/multi-agent/<id>`, N = 1 → `agentIds:[id]` + `onRunStart`; error keeps selection
- Covers: AC25–AC28, AC40, AC41
- Tests: —
- Done when: `pnpm typecheck && pnpm lint`

### S8 — Nav, list, Configure run [client]
- Files: M `client/src/vendor/ui/nav.ts`, `client/messages/en/runs.json`; A `client/src/app/multi-agent/page.tsx` + `_components/MultiAgentListView/`, `app/multi-agent/new/page.tsx` + `_components/ConfigureRunView/`
- Change: FR14/FR15 + §9 states; pages await `?pr`/`?agents` [C2]; PR select = themed Select [C7]
- Covers: AC29–AC31, AC40–AC42
- Tests: —
- Done when: `pnpm typecheck && pnpm lint`

### S9 — Results page [client]
- Files: A `client/src/app/multi-agent/[id]/page.tsx` + `_components/MultiAgentRunView/` (RunHeader, AgentColumns, AgentTabs, DisagreementBlock); M `runs.json`
- Change: FR16–FR21; `?view`/`?trace` as page props + `router.replace` [C2]; drawer after data, `running` from column [C1], beside columns [C12]; text/Markdown only [C9]
- Covers: AC32–AC42
- Tests: —
- Done when: `pnpm typecheck && pnpm lint`

## Execution
- Mode: multi-agent — 2 packages, ~45 files
- W1: S1–S4, server, 1 implementer
- W2: S5–S7, client, 1 implementer, ∥ W1 (other package, disjoint files)
- W3: S8, client, after W2 · W4: S9, client, after W3
- Each wave ends with `./scripts/gates.sh` (`--integration` for W1 + final)

## Contracts & migrations
- None; server-local schemas only; drift check stays clean

## Verification
- `./scripts/gates.sh --integration`; `git diff --name-only feat/multi-agents...` has no forbidden path
- Manual AC42 (+ AC40, AC23 informally): DB `devdigest_review`, API 3011 `LLM_PROVIDER_OVERRIDE=mock`, web 3010
- Review risk: high (concurrency, aggregates, idempotent write)

## Open questions / assumptions
- Test backfill for unit/integration/component ACs — default: follow-up task
- `eval-case-button/` is outside the spec's listed shared location — default: move (B never touches it); fallback: minimal duplicate in S9
- e2e flows 09/11 use the old dropdown [F18] — default: follow-up (outside A, not gated)
- README route/API maps — default: after B merges
- Configure preselects enabled agents unless `?agents=`
