# Context pack: Eval Pipeline
## INSIGHTS that apply (S=server, C=client INSIGHTS.md; quotes cut)
- [I1] S:21 "always inject overrides.llm … for every provider id in tests"
- [I2] S:22 "wait on the specific new run id"
- [I3] S:12 "add app.addHook('onRequest', req => { req.log = recorder })" (AC35)
- [I4] S:11 "race the call against the abort … injected timeoutMs"
- [I5] S:43 "inject bounded concurrency from composition.ts … pass req.log"
- [I6] S:36 "reach a sibling module only via c.modules.<name>.<method>(...)"
- [I7] S:38 "seeded agents … NO agent_versions row" -> run keeps own snapshot
- [I8] S:45 "throw platform/errors.ts subclasses"
- [I9] S:46 "built ONLY by the module's build<Name>Module"
- [I10] S:59 "declare { enum } with the same shared list as the CHECK"
- [I11] S:61 "set mode:'number' up front on every new numeric column"
- [I12] S:62 "ADDS and DROPS columns … triggers the rename prompt"
- [I13] S:68 "build response schemas from the @devdigest/shared contract"
- [I14] S:70 "optional body use z.preprocess((v) => v ?? {}, Schema)"
- [I15] S:71 "SQLSTATE (23514/23503/23505) is on err.cause.code"
- [I16] S:85 "add the new module name to that expected list"
- [I17] S:88 "set createdAt explicitly whenever a test depends on ORDER BY"
- [I18] S:91 "return the locked row when it is empty" (empty PATCH)
- [I20] S:57 "run one integration file"
- [I22] S:23 "after changing a port, grep test/ for its fakes"
- [I23] S:24 "warm the pool first" (double-POST test)
- [I24] S:13 "LLM_PROVIDER_OVERRIDE=mock … key-free review" (AC39 smoke)
- [I25] S:86 literal '${…}' in a string fails lint
- [I26] S:15 "keep DB writes of runs/jobs before onClose"
- [C1] C:14 "stub fetch/EventSource, do not vi.mock('@/lib/hooks/*')"
- [C2] C:44 "never write a key literal or invalidate from a page/component"
- [C3] C:38 "meta: { quietErrorCodes: [...] }"
- [C4] C:41 "keep new URL state in the page's searchParams"
- [C5] C:79 "need \"use client\" (or render a client View)"
- [C6] C:73 "register a factory … when a route is hit more than once"
- [C7] C:21 "stub the GET to change between calls"
- [C8] C:34 "wrap the Badge in a plain <span title=...>"
- [C9] C:35 "render confirm modals as a sibling of the clickable row"
- [C10] C:52 "use --crit for error/missing states"
- [C11] C:18 "getByRole('status') … can match the toast region"
- [C13] C:30 finding text "a PR author can steer" -> plain text
- [C14] C:58 "format dates with toLocaleString"
- [C15] C:65 "filter by a plain substring of the file name"
- [C16] C:20 "run the full suite on its own"
- [C18] C:31 "import @/components/select … pickOption"
## Verified facts
- [F1] `server/src/db/schema/eval.ts:21-58` no created_at/source ids; eval_runs per case
- [F2] `server/src/app.ts:82-83` rate-limit off when nodeEnv='test'; per-route `reviews/routes.ts:39`
- [F3] `server/src/http/error-handler.ts:60-63` route validation -> 422 `validation_error`; codes lower snake
- [F4] `reviews/repository/review.repo.ts:52-67` reviewsForPull; `mappers.ts:9-30`
- [F5] `reviews/repository/pull.repo.ts:31-42` `diff --git a/p b/p` + `--- a/p` + `+++ b/p` + patch
- [F6] `reviewer-core/src/review/run.ts:80-180` ReviewInput; outcome `dropped`, `costUsd`
- [F7] `reviews/application/run-executor.ts:335-356` engine call; `renderSkillBlock` via `modules/skills/index.ts`
- [F8] `agents/repository.ts:68` deleteById, `:207` linkedSkills; `container.ts:181` agentsRepo
- [F9] `app.ts:68` boot reaper, `:115` preClose
- [F10] `skills/infrastructure/repository.ts:224-233` deletes skill cases
- [F11] `client/src/vendor/ui/shell/Sidebar.tsx:3` reads NAV; commit 0d2c45a edited nav.ts
- [F12] `AgentEditor.tsx:25-27` unknown tab -> Config; `AgentEditorView/constants.ts` VALID_TABS
- [F13] `FindingsPanel.tsx:98-107` no agent id; ReviewRunAccordion has `review.agent_id`
- [F15] FindingRecord built in ~40 client files + `mcp/src/present.ts`
- [F17] `vendor/ui/kit/Modal.tsx:26` role=dialog, no Escape
- [F18] `import eval from …` = strict-mode SyntaxError
## Data model (S2)
- eval_cases +created_at, source_finding_id/review_id/pr_id (no FK), uq(source_finding_id), idx(owner_kind, owner_id, created_at)
- eval_suite_runs: workspace_id, agent_id FK cascade, agent_version, config jsonb {provider, model, system_prompt, strategy, skills[id,name,description,body,version]}, case_ids, status running|completed|failed, started/finished_at, cases_total/finished/passed/errored, recall, precision, citation_accuracy, unlabeled_findings, cost_usd, duration_ms, error; partial uq(agent_id) WHERE running; idx(agent_id, started_at), (workspace_id, started_at)
- eval_runs +run_id FK cascade, status passed|failed|error, error, dropped/hit/violation/unlabeled counts, uq(run_id, case_id)
## Executor (S6)
- Inputs: snapshot config, parsed case diff, task from title, prDescription, temperature 0
- Per case: reload (gone -> skip, total-1); signal = timeout + shutdown; error keeps cost; 23503 -> skip; finished+1; 1 start/1 end log
- AC12 fixture: 2 hits, 2 violations, 2 unlabeled, 1 dropped -> 6/7
## Mirrors
- `modules/skills/` layout · `brief-service.ts:81` raceAbort · `review-service.ts:71` background · `test/skills-executor.it.test.ts` RecordingLLM · SkillsTab · `useFindingAction`
## Skill map (routing.json)
| Step | Files | Skills |
|---|---|---|
| S1 | vendor/shared | drift_check, zod |
| S2, S9 | server/src/db | drizzle-orm-patterns, postgresql-table-design |
| S3-S8 | server modules, app.ts | onion-architecture, typescript-expert, security, fastify (http), zod |
| S10 | server/scripts | none |
| S11-S16 | client/src | frontend-ui-architecture, react-best-practices, typescript-expert, security, next (app), RTL (tests) |
Key rules: rings + ports, no Container; schema-first routes; thin pages; hooks own keys; no derived state.
## Risks
- Deletes mid-run -> FK errors: tolerate, finish
- Seed adds 4 agents -> assert AC19 by id
- Tests: await terminal status before app.close
## Notes for reviewers
- Architecture: cross-module only reviews repo, agents repo, app.ts; nav.ts exception
- Security: workspace scope; plain text; limits; no prompt/diff in logs
