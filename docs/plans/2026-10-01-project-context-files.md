# Development Plan: Project Context — file management
Packages: server, client · Base: feat/lab5-sdd@a7298fe · Spec: specs/2026-10-01-project-context-files.md
Context pack: docs/plans/2026-10-01-project-context-files.context.md
Execution: multi-agent (chosen by the user)
Paths: `PC/`=`server/src/modules/project-context/` · `T/`=`server/test/` · `VS/`=`server/src/vendor/shared/` · `C/`=`client/src/` · `CV/`=`C/app/repos/[repoId]/context/_components/ContextView/`

## Goal
Each repo gets a DB-stored `.devdigest/specs/` folder of markdown files (create, upload, edit, rename, delete). The files are attached like repo docs, and runs read the latest save.

## Out of scope
Spec §3; MCP; e2e; trace UI.

## Decisions
- New table `context_files` + `ContextFilesService` [F5]. create/rename lock the repo row; save = `UPDATE…WHERE version=base`; a rename moves the attachments in the same tx.
- Store `doc_type` = `specs`; store paths can be attached [F3]; FR9 uses `CloneDocs.read` [F4]; logging goes through `req.log` [I3].
- Client: the editor and guard are copied, not moved (frontend-ui §1). Shell navigation asks `LeaveGuardProvider` [F9]. Edit mode = `?mode=edit` [C7].
- User: multi-agent; defaults kept; the implementer writes tests; no e2e; AC18 manual.

## Recommendations not adopted
- Share SkillEditor's editor/guard (needs deletions).

Deletions (need user approval): none.

## Steps
### S1 — Contracts [server, client]
- Files: M `VS/{contracts,constants}/project-context.ts` + client copies, `C/test/context-fixtures.ts`, `T/contracts.test.ts`
- Change:
  - The doc and preview gain `source`, `editable` and `version?`; the trace doc gains `source?`.
  - The create, save and rename inputs from §7.
  - Zod-free `STORE_*` constants: root, 500 files, depth 5, segment RE [C13].
- AUTHORISED EXCEPTION: `client/src/vendor/shared/{contracts,constants}/project-context.ts` — required copy.
- Covers: AC1, AC6, AC8 · Tests: old trace doc + new fields parse
- Done when: `./scripts/check-shared-drift.sh`; `cd server && pnpm exec vitest run test/contracts.test.ts`; `cd client && pnpm typecheck`

### S2 — Table [server]
- Files: M `server/src/db/schema/project-context.ts`; A generated `0017_*`
- Change: `context_files` holds id, repo_id (FK, cascade), path (CHECK ≤512), content, size_bytes, version and timestamptz columns; all NOT NULL; (repo_id,path) UNIQUE.
- Covers: AC1, AC3 · Tests: S5 · Done when: `cd server && pnpm db:generate && pnpm typecheck` (generates CREATE only)

### S3 — Path rules [server]
- Files: A `PC/domain/store-files.ts`; M `PC/domain/paths.ts`, `T/project-context-domain.test.ts`
- Change: `checkStorePath` (FR8), `withSuffix`, `utf8Bytes`, `hasNul`; `validateAttachmentPaths` accepts store paths
- Rules: [I13] · Covers: AC2, AC7 · Tests: the AC7 paths, depth 5 vs 6, suffixes
- Done when: `cd server && pnpm exec vitest run test/project-context-domain.test.ts`

### S4 — Write use cases [server]
- Files: A `PC/application/context-files-service.ts`, `T/context-files-service.test.ts`; M `PC/application/ports.ts`, `PC/infrastructure/repository.ts`
- Change:
  - A path in the clone but not the store -> 403; a path in neither -> 404.
  - create: suffix, 500-file cap, 413. NUL content -> 422 `invalid_content`.
  - save: stale -> `stale_version` [F6].
  - rename: 409 `path_exists` (also on 23505 [I1]). A duplicate owner row is dropped; the moved row keeps its position.
  - Returns preview DTOs, ISO dates [I8].
- Rules: [I2][I6][I16] · Covers: AC2–AC5, AC9 · Tests: log line, 403/404, stale
- Done when: `cd server && pnpm exec vitest run test/context-files-service.test.ts`

### S5 — Routes, list, preview [server]
- Files: M `PC/http/{routes,schemas}.ts`, `PC/composition.ts`, `PC/application/project-context-service.ts`, `server/README.md`; A `T/project-context-files.it.test.ts`
- Change:
  - The 4 routes of §7, with an optional POST body [I9] and `bodyLimit` 2 MiB [I10].
  - The list puts store files first, sorted `COLLATE "C"` [I7], even when `not_cloned`. Preview reads the store first.
- Rules: [I5][I11][I12] · Covers: AC1–AC4, AC7–AC9 · Tests: one per AC; AC9 timed after a warm-up
- Done when: `cd server && pnpm exec vitest run test/project-context-files.it.test.ts test/project-context.it.test.ts && pnpm arch:check`

### S6 — Runs read the store [server]
- Files: M `PC/application/project-context-service.ts`, `PC/domain/{run-context,types}.ts`, `T/project-context-run.it.test.ts`, `docs/review-flow.md`
- Change: a store hit sends DB text, `source:'store'` (even with no sha); anything else comes from git, `source:'repo'` [F1].
- Rules: [I14][I15] · Covers: AC5, AC6 · Tests: the new text reaches the prompt; deleted -> `missing`
- Done when: `cd server && pnpm exec vitest run test/project-context-run.it.test.ts`

### S7 — Hooks [client]
- Files: M `C/lib/hooks/{project-context,keys}.ts`; A `C/lib/hooks/project-context-files.test.tsx`
- Change: 4 mutation hooks; they invalidate `repoKeys.context`, `agentKeys.contextAll()` and `skillKeys.contextAll()` [F8]; save/rename are quiet [C4].
- Covers: AC17 · Tests: a rename refetches the agent context [C3]
- Done when: `cd client && pnpm exec vitest run project-context-files`

### S8 — Leave guard [client]
- Files: A `C/lib/leave-guard.tsx`+test; M `C/lib/providers.tsx`, 3 `C/components/app-shell/hooks/*.ts` [F9]
- Change: `useLeaveGuard(dirty,msg)`; `useConfirmLeave()` returns true when no guard is set; the shell calls it before `router.push`.
- Covers: AC13 (repo/route) · Tests: dirty -> blocked; clean -> passes
- Done when: `cd client && pnpm exec vitest run leave-guard app-shell`

### S9 — Store section + row menu [client]
- Files: M `CV/{ContextView.tsx,helpers.ts}`+test, `client/messages/en/context.json`; A `CV/_components/StoreSection/` (+StoreFileRow)
- Change:
  - Header + root; store rows sit above repo rows; §9 states.
  - Inline rename checked by `checkStorePath`. Delete confirms in a sibling modal [C10].
  - Repo rows get no menu. The view is keyed by repoId [C17].
- Covers: AC10, AC14, AC16 · Tests: one per AC
- Done when: `cd client && pnpm exec vitest run ContextView StoreSection helpers`

### S10 — Toolbar [client]
- Files: M `CV/_components/StoreSection/StoreSection.tsx`+test, `CV/helpers.ts`, `context.json`; A `…/StoreSection/_components/NewFolderDialog/`
- Change:
  - New file -> POST, select it, edit, rename. New folder -> POST `<name>/untitled.md`.
  - Upload: `classifyUpload` checks `.md`, ≤256 KB, UTF-8, no NUL; files are POSTed one by one; toasts report results; progress shows `i/N`.
- Covers: AC11, AC12 · Tests: AC11, AC12
- Done when: `cd client && pnpm exec vitest run StoreSection helpers`

### S11 — Editor [client]
- Files: M `CV/_components/DocPreviewPane/DocPreviewPane.tsx`, `CV/{ContextView.tsx,helpers.ts}`, `context.json`; A `CV/_components/DocEditor/` (+MarkdownField copy [F10], StaleBanner)
- Change:
  - Preview|Edit toggle; Edit is disabled with a hint for repo docs. The draft lives in ContextView.
  - Save or Ctrl/Cmd+S (`preventDefault`), a dirty dot, "Saved" for 2 s.
  - 409/404 -> banner. A dirty file switch asks for confirmation.
- Covers: AC13–AC15 · Tests: one per AC [C2]
- Done when: `cd client && pnpm exec vitest run DocEditor DocPreviewPane ContextView`

## Execution
- Mode: multi-agent (2 packages, contracts, DB).
- W1: S1–S3. W2: S4–S6 ∥ S7–S8 (disjoint). W3: S9–S10. W4: S11.

## Contracts & migrations
- S1: client copy + drift check. S2: `0017_*`.

## Verification
- `./scripts/gates.sh --integration` per wave + at the end. Review risk: **high**.
- AC18 (manual):
  1. `pnpm db:migrate`, `./scripts/dev.sh`.
  2. Create `security-rules.md`, save it, attach it to Security Reviewer.
  3. Add `Never log request bodies.`, save.
  4. Review a PR (`LLM_PROVIDER_OVERRIDE=mock` [I14]). The trace drawer's Project context block must show the file `included` with the new line.

## Open questions / assumptions
- The clone later gains a store path -> the store file wins (default).
- NUL in content -> 422 `invalid_content`, a code §7 lacks (default).
- Renaming to the same path -> no-op 200 (default).
