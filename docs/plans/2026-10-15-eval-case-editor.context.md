# Context pack: Case Editor
## INSIGHTS that apply (s=server, c=client INSIGHTS.md line; quotes cut)
- [I-s12] "app.addHook('onRequest', req => { req.log = recorder })" → AC13/AC31
- [I-s13] "LLM_PROVIDER_OVERRIDE=mock … key-free review" → AC23
- [I-s21] "always inject overrides.llm … for every provider id in tests"
- [I-s22] "wait on the specific new run id"
- [I-s23] "after changing a port, grep test/ for its fakes"
- [I-s29] "an AppError's details is sent on the wire as error.details" → files/ranges
- [I-s37] "reach a sibling module only via c.modules.<name>…" → SkillDirectory
- [I-s44] "inject bounded concurrency from composition.ts … pass req.log"
- [I-s46] "throw platform/errors.ts subclasses and never expect 422 from a service-side parse"
- [I-s57] "run one integration file with 'pnpm exec vitest run test/<file>.it.test.ts'"
- [I-s59] "declare { enum } with the same shared list as the CHECK" → owner_kind
- [I-s62] "ADDS and DROPS columns on the same table triggers the rename prompt" → add only
- [I-s68] "keys missing from the schema are silently stripped … build response schemas from the @devdigest/shared contract"
- [I-s71] "pg SQLSTATE … is on err.cause.code"
- [I-s78] "model is read from eval_suite_runs.config->>'model' … put {"model"} in config"
- [I-s79] "change call sites to (r) => mapper(r)"
- [I-s80] "pnpm typecheck never checks test/ files … run the tests that fake it"
- [I-s91] "set createdAt explicitly whenever a test depends on ORDER BY created_at"
- [I-c11] "vi.useFakeTimers({ shouldAdvanceTime: true }) … advanceTimersByTimeAsync" → polling, debounce
- [I-c15] "renderWithProviders … + mockFetch … do not vi.mock('@/lib/hooks/*')"
- [I-c19] "getByRole('status') … can match the toast region"
- [I-c22] "mockFetch returns the same GET body every time … stub the GET to change"
- [I-c26] "assert query params via api.requests('GET /path')[i].search"
- [I-c28] "vendored Modal has no Escape … register its own document keydown listener"
- [I-c35] "new dropdowns import @/components/select; tests … pickOption"
- [I-c39] "render confirm modals as a sibling of the clickable row"
- [I-c42] "meta: { quietErrorCodes: [...] | ['*'] }"
- [I-c45] "keep new URL state in the page's searchParams" (?tab=evals)
- [I-c48] "every query key comes from the factories there"
- [I-c55] "wrapping each toolbar item in a display:grid span"
- [I-c56] "Tabs render plain <button> … getByRole('button', { name })"
- [I-c59] "scrollIntoView does not exist … el?.scrollIntoView?.()"
- [I-c67] "add it under vendor/shared/constants/ (both copies) instead of importing the barrel"
- [I-c71] "filter by a plain substring of the file name"
- [I-c78] "pseudoMessages + strayText … allow-list those data patterns"
- [I-c81] "register a factory … when a route is hit more than once"
## Verified facts
- [F1] `server/src/db/schema/eval.ts:99` running-uq on agent_id only; `:75-77` agent FK cascade
- [F2] `@fastify/rate-limit store/LocalStore.js:79-81` child() = new store per route; `index.js:252-256` groupId only suffixes the key
- [F3] `server/src/app.ts:90-92` limiter off under NODE_ENV=test
- [F4] `client/src/components/eval-run-history/helpers.ts:22-24` Agent column if any row has agent_name
- [F5] `server/src/adapters/git/diff-parser.ts:39-43,62,78` strips `b/`; `/dev/null` keeps ''; pre-hunk lines ignored; pathless files dropped; new-side = `+` and non-`-` lines
- [F6] `EV/infrastructure/repository.ts:37-43` find/lock/update/delete agent-only; `run-queries.ts:102-114` loadCase too
- [F7] `run-queries.ts:35-55,118-209` agent reads filter agent_id only; agentsWithEvals/recentRuns ignore owner
- [F8] `EV/domain/compare.ts:86-93` compares agent_id only
- [F9] `EV/domain/run-input.ts:316-318` task line uses pr_number
- [F10] `skills/application/skills-service.ts:154-160` delete = deleteEvalCases + delete, one tx
- [F11] `agents/repository.ts:68-80` deletes agent cases; runs cascade by FK
- [F12] `migrations/0011_integrity_indexes_checks.sql:8-9` hand-written UPDATE precedent
- [F13] `client/src/lib/hooks/evals.ts:99,144` invalidation by agent_id
- [F14] `diff-viewer/DiffViewer/DiffViewer.tsx:16-31` `PrFile[]` (path, additions, deletions, patch=hunks) + highlight
- [F15] `client/src/app/skills/constants.ts:8` SKILL_TABS; `skills/helpers.ts:12` resolveTab
- [F16] `SH/contracts/eval-pipeline.ts:244` EvalRecentRun extends EvalRunSummary with agent_name
- [F17] `SH/contracts/findings.ts:11,14` Severity, FindingCategory
- [F18] `EV/infrastructure/agent-snapshots.ts:382-386` getById type lacks name
- [F19] `SH/contracts/knowledge.ts:124-141` Skill has name/description/body/version
- [F20] `grep -rl eval e2e mcp/src` → none
## Mirrors
- `eval-cases-service.ts:29-48` (limit, insert) · `editExpectationLines` (400) · `tryStart`/`runAll` · `test/eval-runs.it.test.ts` (ScriptedLLM, gate, waitForRun, recorder, AC37 429) · agent `EvalsTab` follow-run · `useStartEvalRun`
## Skill map (routing.json)
| Step | Files | Skills | Key rules |
|---|---|---|---|
| S1 | */vendor/shared | drift_check, zod | both copies; trim→min |
| S2 | server/src/db, EV | drizzle-orm-patterns, postgresql-table-design, onion, ts, security | CHECK not ENUM; index FK cols; partial uq |
| S3–S5 | EV/**, composition.ts | onion, ts, security, zod; fastify (http/) | ports not Container; schema-first |
| S6–S9 | client/src/** | frontend-ui-architecture, react-best-practices, ts, security; next (app/); RTL (tests) | shared on 2nd use; hooks own keys; derive |
## Risks
- Exact-shape asserts in existing it tests → update in S2/S4
- Skill/host deleted mid-run → FK cascade; recordCase → case_gone
- Preview jank on 200 k chars → debounce + deferred value
## Notes for reviewers
- Architecture: evals owns `/skills/:id/eval-*`; skills only via `c.modules` · Security: workspace 404s; host check 422; no diff/body in logs; plain text, no dangerouslySetInnerHTML
