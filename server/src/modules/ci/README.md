# `modules/ci` — Export to CI

Generates the CI files of an agent, publishes them as a PR, and ingests CI results back.
Cross-package flow, security rules and UI: [`../../../../docs/export-to-ci.md`](../../../../docs/export-to-ci.md).
Spec: [`../../../../specs/export-to-ci.md`](../../../../specs/export-to-ci.md).

## Routes (`http/routes.ts`)

| Method | Path | Result |
|---|---|---|
| POST | `/agents/:id/export-ci` | 200 `CiExport` (`action: "files"`, no GitHub call, no DB write) · 201 (`open_pr`). 404 `agent_not_found` / `repo_not_found` · 409 `ci_slug_conflict` · 422 `unsupported_target` / `unsupported_provider` / `invalid_triggers` / `skill_slug_conflict` / `workflow_insecure` (`details.rule`) / `github_permission_denied` · 502 `github_unavailable` · 500 `runner_bundle_missing` |
| GET | `/agents/:id/ci-installations` | `{installations}` newest export first, each with `last_run`; 404 `agent_not_found` |
| GET | `/ci/runs?agent_id=&limit=` | `{runs}` newest first (`limit` 1–200, default 100) |
| POST | `/ci/refresh` | `CiRefreshResult`; body `{agent_id?}` (empty body allowed); 404 `agent_not_found` |

Ids of another workspace are a 404, never a 403. The request body is the route-local
`CiExportBody` (`http/schemas.ts`): the shared `CiExportInput` with `workflow` capped at 1 MiB, so
an oversized workflow answers `workflow_insecure` / `invalid_yaml` instead of `validation_error`.

## Layers

| Ring | Files | Notes |
|---|---|---|
| domain (pure) | `domain/constants.ts` · `slug.ts` · `manifest.ts` · `workflow.ts` · `workflow-rules.ts` · `ingest.ts` | paths, names, pins, limits; workflow and PR-body generators; rule checks on a parsed document; artifact parse and verification; GitHub error mapping. No `yaml` / `fflate` imports. |
| application | `export-service.ts` · `ingest-service.ts` · `workflow-check.ts` · `artifact-reader.ts` · `ports.ts` | use cases; `checkWorkflow` = size → YAML parse → domain rules; `readResultArtifact` = zip size → entry read → parse |
| infrastructure | `repository.ts` · `mappers.ts` · `pg-error.ts` · `runner-bundle.ts` · `yaml-codec.ts` · `zip-entry-reader.ts` | Drizzle over `ci_installations`, `ci_runs`, `agent_runs`; `YamlLibCodec` (`yaml`) implements `YamlCodec`; `FflateZipEntryReader` (`fflate`) implements `ZipEntryReader` and checks the entry size before inflating |
| composition | `composition.ts` | `container.modules.ci` = `{ exporter, ingest }`; agents and repos reached through ports; GitHub resolved per call, so a missing token fails only the flows that need it |

## GitHub port

`GitHubClient` (`src/vendor/shared/adapters.ts`, implemented in `src/adapters/github/octokit.ts`,
mocked in `src/adapters/mocks.ts`) gained `listWorkflowRuns` (completed `pull_request` runs of one
workflow file; a missing file rejects with `.status === 404`), `listRunArtifacts` and
`downloadArtifact` (`null` when over `maxBytes`; expired rejects with `.status === 410`).
Types: `WorkflowRunSummary`, `RunArtifactSummary`. Both `vendor/shared` copies must stay identical.

## Extending

- New workflow rule: add it to `domain/workflow-rules.ts` (and its id to `WorkflowRule`), keep the
  rule order, and make sure `buildWorkflow` output still passes.
- New exported file: add the path to `domain/constants.ts` and the file in `CiExportService.export`.
- Pinned action SHAs live in `ACTION_PINS`; bump them there.
