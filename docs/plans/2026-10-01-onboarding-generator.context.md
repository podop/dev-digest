# Context pack: Onboarding Generator
## INSIGHTS that apply
- [I1] `server/INSIGHTS.md:53` "must pin the output language, and bump that feature's PROMPT_VERSION" → English rule, `PROMPT_VERSION=1`.
- [I2] `:33` "reach a sibling module only via c.modules.<name>.<method>(...) inside a composition.ts".
- [I3] `:47` "place it under a ring folder".
- [I4] `:31` "add a field typed for what downstream actually consumes".
- [I5] `:63` "build response schemas from the @devdigest/shared contract".
- [I6] `:65` "a POST with no payload reaches the zod body validator as null" → no body schema.
- [I7] `:42` "never expect 422 from a service-side parse" → `safeParse`.
- [I8] `:19` "always inject overrides.llm … for every provider id in tests".
- [I9] `:52` "run one integration file with 'pnpm exec vitest run test/<file>.it.test.ts'".
- [I10] `:21` "after changing a port, grep test/ for its fakes".
- [I12] `:40` "pass req.log into service methods as a request-scoped Logger port".
- [C1] `client/INSIGHTS.md:14` "stub fetch/EventSource, do not vi.mock('@/lib/hooks/*')".
- [C2] `:18` toast region is role="status" → "scope with within(...)".
- [C3] `:35` "meta: { quietErrorCodes: [...] | ['*'] }".
- [C4] `:41` "never write a key literal or invalidate from a page/component".
- [C5] `:49` jsdom: `el?.scrollIntoView?.()`, test via `vi.fn()`.
- [C6] `:54` not next-intl dateTime → `Intl.RelativeTimeFormat`.
- [C7] `:38` page = async Server Component → client View.
- [C8] `:61` "filter by a plain substring of the file name".
- [C9] `:48` use `--crit/--warn/--ok`, no `--danger`.
- [C10] `:13` real `<RepoProvider>` + mocked `next/navigation`.
- [C12] `:70` route files: no `@devdigest/ui` without "use client".
## Verified facts
- [F1] `db/schema/context.ts:125-131` `onboarding(repo_id PK FK cascade, json, generated_at)`, unused.
- [F4] `maxRetries` = reprompts (`vendor/shared/adapters.ts:58`); `MockLLMProvider.calls/failStructuredFromCall` (`adapters/mocks.ts:56`).
- [F5] `platform/container.ts:247-280` `c.llm(id)` → override, or `ConfigError` (500 unless mapped).
- [F6] `platform/errors.ts` `ValidationError(msg,details,code)` 422 · `ConflictError` 409 · `NotFoundError` 404 · `ExternalServiceError` 502.
- [F7] `repo-intel/service.ts:99-190` `getIndexState` never throws; `getTopFilesByRank` drops tests; `getRankedPaths` unfiltered (`read-repository.ts:101`); 1 `file_rank` row per indexed file (`rank.ts:25`).
- [F8] `RepoIntel` impl only `service.ts:45`; overrides `repoIntel`, `git`, `llm` (`container.ts:77-90`).
- [F9] `readFileAt` throws on missing/oversize (`adapters.ts:287`) → cap 512 KB, truncate in domain.
- [F10] `INJECTION_GUARD` private, review-only (`reviewer-core/src/prompt.ts:17`).
- [F14] `app-shell/helpers.ts:29` matches any `/onboarding`; repo switch → `/repos/<id>/pulls` (`useShellContext.ts:31`).
- [F16] `prompts/onboarding.system.md`, `messages/en/onboarding.json` unused.
- [F17] `MermaidDiagram` unused.
- [F18] Limits per FR2/FR3/FR9/NFR1 (input via `estimateTokens`); 120 000 ms. README `README.md|README|readme.md`; compose `(docker-)compose.y(a)ml`.
- [F19] Each source wrapped under its own label (repo-map, readme, todo-lines…). Trim: README → compose → TODO.
- [F20] `normalizeTour`: strip `./`, edge `/`; dedupe; exact indexed file (folder prefix only in first tasks); cap. Nodes first 12; edges known ids ≤ 20; < 2 nodes → none; below min 3 → `[]`. Returns `{tour, dropped}`. `staleness`: sha, then version.
- [F21] generate: repo 404 `repo_not_found` → 409 `generation_in_progress` → add; try { `filesIndexed 0` → 422 `index_not_ready`; timeout signal; reads at `lastIndexedSha`; call; normalize; upsert } finally { log `{repoId,provider,model,tokensIn,tokensOut,costUsd,durationMs,dropped,outcome}`; remove }.
- [F22] `layoutDiagram`: layers by longest path, fixed boxes, `<rect>+<text>`, kind colours. Open = `window.open(githubBlobUrl(fullName, indexed_sha, path), '_blank', 'noopener')`. Copy: "Copied" 2000 ms; reject → "Copy failed". Command `pre-wrap`, `overflow-wrap:anywhere`; path ellipsis + `title`.
- [F23] Name via `useActiveRepo`; `useRepoIntelStatus` 0 files → Generate disabled. TOC buttons `aria-current`; click scrolls + sets active; IntersectionObserver if defined. Share `origin+pathname+#active`. Toasts 409/422/502; provider 422 → link `/settings/models`. Pending: skeletons, buttons disabled.
## Mirrors
`modules/project-context/` · `intent/{infrastructure/llm-model,composition}.ts` · `C/app/repos/[repoId]/context/`
## Skill map (from routing.json)
| Step | Skills | Rules |
|---|---|---|
| S1 `*/vendor/shared/**` | drift_check, zod | K6 |
| S2–S4 `server/src/modules/**` | onion-architecture, typescript-expert, security, zod | K1–K6, K8 |
| S5 + `http/**` | + fastify-best-practices | K3, K5, K7 |
| S6 `C/lib`, `C/components` | frontend-ui-architecture, react-best-practices, typescript-expert, security | K10, K11 |
| S7–S8 `C/app/**` | + next-best-practices, react-testing-library | K9–K15 |
Load a skill only if these quotes don't settle it.
- [K1] "`domain` never imports `fastify`, `drizzle-orm`, … `fs`"
- [K2] files live in `domain/`, `application/`, `infrastructure/`, `http/`
- [K3] "Routes don't query, don't `new` repositories, don't hold business rules"
- [K4] "New/changed use cases take ports, not `Container`"
- [K5] "domain throws typed errors; only the root handler knows HTTP"
- [K6] "`parse-use-safeparse`", "`parse-never-trust-json`", "`schema-use-enums`"
- [K7] "Schema-first: Define schemas for validation and serialization"
- [K8] "Sanitize AI output … validate prompt length, set request timeouts"
- [K9] "Routes are thin." [K10] "Logic out of JSX." [K11] "Components never call `fetch` or `api.*`."
- [K12] "NEVER store derived values in `useState`" [K13] "Add `aria-label` to icon-only buttons"
- [K14] "Mock at boundaries only"; "Never use `setTimeout` or fixed delays"
- [K15] serializable props only.
## Risks / reviewers
- Injection → wrapped + guard + validated output; 200 `git show` → concurrency 8. `.env.example` values never sent; LLM text as text/`<code>` only.
