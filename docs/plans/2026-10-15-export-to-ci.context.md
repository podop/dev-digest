# Context pack: Export to CI
## INSIGHTS that apply
- [I1] `server/INSIGHTS.md:90` "composition.test.ts asserts the exact list of registered modules" → add `ci`
- [I2] `:73` "the pg SQLSTATE … is on err.cause.code" → 23505 (repo, slug) → 409
- [I3] `:72` "a POST with no payload reaches the zod body validator as null" → `z.preprocess`
- [I4] `:69-70` Date fails `z.string()`; unknown keys stripped → ISO strings, map every field
- [I5] `:65` "list/skip entries … inside filter, never inflate first"
- [I6] `:37` "reach a sibling module only via c.modules.<name>… inside a composition.ts"
- [I7] `:43` "infrastructure may import only application/ports.ts"
- [I8] `:44` "pass req.log into service methods as a request-scoped Logger port"
- [I9] `:82` after a port change "run the tests that fake it (pnpm test:unit)"
- [I10] `:29` "an AppError's details is sent on the wire" → `{ rule }`
- [I11] `:91` "'${…}' inside a plain quoted string … trips noTemplateCurlyInString" → `\${{` in template literals
- [I12] `client/INSIGHTS.md:42` own-error mutations set `meta: { quietErrorCodes }`
- [I13] `:28`,`:56` Modal has no Escape; own handler "must return early on e.defaultPrevented"
- [I14] `:35` "new dropdowns import @/components/select"
- [I15] `:49` "Save PUTs just the draft (server accepts partial patches)"
- [I16] `:27` NAV labels are English literals
- [I17] `:55` Textarea has no aria/id → wrap in `<label>`
- [I18] `:90` route files rendering `@devdigest/ui` need "use client" → page renders a client View
- [I19] `:48` keys only from `keys.ts`; mutations own invalidation
- [I20] `:66` dates via `toLocaleString`; `:38` Badge props closed
- [I21] `:72` value imports from `@devdigest/shared` pull zod → types only
- [I23] `agent-runner/insights/INSIGHTS.md` typecheck needs `cd reviewer-core && pnpm install`
- [I24] same, Open Questions: nothing sets `DEVDIGEST_POST_AS` → FR9 env closes it

## Verified facts
- [F1] `db09602` has `eval-ci.ts` (both), `schema/ci.ts`, migration 0020
- [F2] `GitHubClient` (`vendor/shared/adapters.ts:178`): only `octokit.ts` + `mocks.ts:154`
- [F3] `octokit.ts:384` commitFiles branches from `base` if absent; `:452` findOpenPr; `:365` openPullRequest; withRetry retries 429/5xx (`resilience.ts:85`)
- [F4] `container.ts:237` `github()` → ConfigError without token
- [F5] `Repo.default_branch` (`contracts/platform.ts:121`); `c.modules.repos.service.list(ws)`
- [F6] `agents/repository.ts:57` getById, `:219` linkedSkills (all); `schema/skills.ts:24` enabled; `reviews/application/ports.ts:94` linked+enabled
- [F7] `ci_installations`: no workspace, cascades on agent delete; `ci_runs`: no repo/agent column
- [F8] `error-handler.ts:25`: Validation 422, NotFound 404, Conflict 409, Internal 500, ExternalService 502
- [F9] checkout `11d5960a326750d5838078e36cf38b85af677262` (`server-integration.yml:43`), setup-node `49933ea5288caeca8642d1e84afbd3f7d6820020` (`:49`), upload-artifact `ea165f8d65b6e75b540449e92b4886f43607fa02` (`e2e-web.yml:151`)
- [F10] server declares fflate, not yaml (2.9.0 hoisted)
- [F11] `.dependency-cruiser.cjs:37` FRAMEWORKS omits yaml/fflate
- [F12] runner `manifest.ts:25` exactly-one; `artifact.ts` `RUNNER_VERSION='1'`; `run.ts:142` artifact before post
- [F13] `scripts/gates.py:32` skips agent-runner
- [F14] `AgentEditorView/constants.ts:2` VALID_TABS; `AgentEditor/constants.ts:11` TABS; `agents.json` has `editor.tabs.ci`; `repo-context.tsx:59` useActiveRepo

## Flows (S4)
Export: agent 404 → target 422 → provider 422 → triggers 422 → repo by full_name 404 → slug = stored else slugify → (repo,slug) of another agent 409 → dup skill slug 422 → `checkWorkflow(edited ?? generated)` 422 → bundle null 500 → files. `files` 200. `open_pr`: commitFiles(`devdigest/ci`, default_branch) → findOpenPr ?? openPullRequest → upsert installation → 201. GitHub 403/404 → 422 `github_permission_denied`, else 502 `github_unavailable`.
Refresh: `github()` once; workspace installations (unknown agent_id 404), sequential; 45 s deadline before every call, rest `not_checked`. List 30 runs (404 `not_installed`, else `error`+code). Skip stored (id, attempt) and skipped/cancelled. Per run: newest artifact `devdigest-result-<slug>`; none → store `failed`. expired/410 → expired; >1 MiB or JSON >64 KiB → too_large; bad JSON/schema → invalid; sha/repo id/path → mismatch. Valid → one tx: agent_runs (ci, agent, ws, pr null, openrouter, model, cost, duration, findings, blockers, done) + ci_runs (findings>0 ? succeeded : no_findings). degraded = any error|not_checked. Log {installation_id, repo, github_run_id, reason|code} only.

## Rules (S2)
invalid_yaml: >64 KiB, parse error, non-mapping. forbidden_trigger: `on` mapping, only `pull_request`, `types` ⊆ allowed. permissions: top-level exactly the two; no job grants other write. secrets: every `secrets` ref is `.OPENROUTER_API_KEY|.GITHUB_TOKEN`. unpinned_action: `owner/repo[/path]@<40hex>`. fork_guard: every job `if` = `github.event.pull_request.head.repo.full_name == github.repository`. untrusted_expression: spec §7. Generated: `ubuntu-24.04`, checkout head.sha + `persist-credentials: false`, upload `if: always()`.

## Mirrors
- `server/src/modules/evals/`: layout, composition, `http/schemas.ts`, `infrastructure/pg-error.ts` (copy)
- upstream (read only): `ci/slug.ts`; `ci/workflow.ts` layout only; `ExportWizard/zip.ts` (copy)

## Skill map
| Step | Files | Skills |
|---|---|---|
| S1 | adapters, vendor/shared | onion, ts-expert, security; drift |
| S2, S4 | modules/ci | onion, ts-expert, security, zod |
| S5 | ci/http, composition | + fastify |
| S3 | agent-runner | none (its CLAUDE.md) |
| S6–S8 | client/src | frontend-ui-arch, react, ts-expert, security; app/** next |

## Assumptions
- A1 deleted installation: repo from `github_url`. A2 `not_checked` sets `degraded`. A3 newest artifact by `created_at`. A4 unused `ci.json` keys stay. A5 inline bundle in createTree, size unverified (AC38).

## Notes for reviewers
- Missing tests: user decision, not a FAIL. yaml/fflate in domain: decision. `nav.ts`: spec exception.
