# Context pack: Project Context — file management
Path aliases (PC/, T/, VS/, C/, CV/) as in the plan.
## INSIGHTS that apply (S=`server/INSIGHTS.md`, C=`client/INSIGHTS.md`, line numbers)
- [I1] S:67 "the pg SQLSTATE … is on err.cause.code" (23505 → path_exists)
- [I2] S:43 "throw platform/errors.ts subclasses"
- [I3] S:41 "pass req.log into service methods as a request-scoped Logger port"
- [I4] S:22 "warm the pool first"
- [I5] S:44 "edit its composition.ts, never container.ts"
- [I6] S:40 "infrastructure may import only application/ports.ts"
- [I7] S:61 "use ORDER BY name COLLATE \"C\" when a list must match JS/client sorting"
- [I8] S:63 "services return Date objects … the response serializer 500s" → ISO strings
- [I9] S:66 "for an optional body use z.preprocess((v) => v ?? {}, Schema)"
- [I10] S:60 "set a route-level bodyLimit on upload routes"
- [I11] S:64 "build response schemas from the @devdigest/shared contract" + an inject test per route
- [I12] S:53 run one integration file with `pnpm exec vitest run test/<file>.it.test.ts`
- [I13] S:77 "never write '**/' inside a /** */ comment"
- [I14] S:19 "always inject overrides.llm"; S:11 `LLM_PROVIDER_OVERRIDE=mock` = key-free
- [I15] S:20 "wait on the specific new run id"; S:93 → wait for the trace too
- [I16] S:21 "a changed port signature breaks test fakes only at runtime" → grep `test/` fakes
- [C1] C:14 "stub fetch/EventSource, do not vi.mock('@/lib/hooks/*')"
- [C2] C:12 "wait for dynamically loaded editors with findBy…(…, { timeout: 5000 })"
- [C3] C:21 "stub the GET to change between calls"
- [C4] C:36 "sets meta: { quietErrorCodes: [...] }"
- [C7] C:39 "keep new URL state in the page's searchParams"
- [C8] C:53 raw HTML "printed as escaped text" by `<Markdown>`
- [C9] C:35 capture-phase guard "blocks next/link navigation"; not Back
- [C10] C:33 "render confirm modals as a sibling of the clickable row"
- [C13] C:59 runtime constants go "under vendor/shared/constants/ (both copies)"
- [C17] C:25 "key a per-repo view by repoId"
## Verified facts
- [F1] `PC/application/project-context-service.ts`: `listDocs` :89 (`not_cloned` → no docs); `previewDoc` :117 (listable gate, then clone); `resolveForRun` :188 (sha null → missing/unreadable).
- [F2] `VS/contracts/project-context.ts`: `ContextDoc` :31, `ContextDocPreview` (single-doc response) :64, trace doc :108.
- [F3] `PC/domain/paths.ts`: `isListablePath` :28 requires a glob match; `docTypeOf` :39 uses the last specs/docs/insights segment; `validateAttachmentPaths` :52.
- [F4] `PC/infrastructure/clone-docs.ts:89` `read`: realpath must stay under the root; symlink or ENOENT → `not_found`.
- [F5] `server/src/db/schema/project-context.ts`: attachment PK is (owner,repo_id,path) plus `position`; `repository.ts:106` replaces them under an owner lock. The latest migration is 0016.
- [F6] `platform/errors.ts`: Forbidden 403 · Conflict 409 · PayloadTooLarge 413 · Validation 422. Stale precedent at `skills-service.ts:109` uses `ConflictError(msg,{current_version},'stale_version')`.
- [F7] `C/lib/api.ts:61`: a 204 response returns undefined.
- [F8] `C/lib/hooks/keys.ts`: `repoKeys.context` :27 prefixes `contextDoc`; `agentKeys.context` :66 = `["agents","context",id,repoId]`; skillKeys has the same shape.
- [F9] The shell navigates with `router.push`, which the link-capture guard misses: `useShellContext.ts:34,52`, `useShellCommands.ts:27,35`, `useGlobalShortcuts.ts:46-47`.
- [F10] `C/app/skills/[id]/_components/SkillEditor/_components/BodyEditor/CodeMirrorField.tsx:28` is loaded with next/dynamic (`BodyEditor.tsx:12`) and mocked in `C/test/setup.ts`.
- [F11] `C/components/context-picker/helpers.ts:21`: an attached path that is not listed → `missing` row (AC17).
- [F12] `T/project-context.it.test.ts:41-67`: tmp clone fixture (mkdtemp, `clonePath`).
## Mirrors
- The skills `base_version` flow ([F6], `VS/contracts/knowledge.ts:156-163`); `T/project-context*.test.ts` fixtures; SkillEditor BodyEditor + `useUnsavedChangesGuard`; ContextView tests.
## Skill map (from routing.json) — key rules quoted
| Step | Files | Skills | Key rules |
|---|---|---|---|
| S1 | `*/vendor/shared/**` | drift_check, zod | "Validate at system boundaries"; "Use enums for fixed string values"; copies identical |
| S2 | `server/src/db/**` | drizzle-orm-patterns, postgresql-table-design | "FK indexes: PostgreSQL does not auto-index FK columns"; "prefer TEXT … CHECK (LENGTH(col) <= n)"; "TIMESTAMPTZ for timestamps"; "Add NOT NULL everywhere" |
| S3–S6 | `server/src/modules/**` | onion-architecture, typescript-expert, security, zod | "the use case decides the boundary via a TransactionRunner port"; "Translate driver errors … into domain errors inside the adapter"; "A use case receives only the ports it uses"; "Always check ownership on update/delete"; "path.join() with user input allows traversal" |
| S5 | `PC/http/**` | fastify-best-practices + onion | "Handler = parsed input → getContext → use case → DTO … no business ifs"; "Schema-first … never Schema.parse(req.body) in a handler" |
| S1, S7–S11 | `client/src/**` (not vendor) | frontend-ui-architecture, react-best-practices, typescript-expert, security | "Components never call fetch or api.*"; "mutations invalidate the keys they affect"; "UI copy is not a constant — it goes to messages/"; feature A → feature-B/_components forbidden; "Duplicate once; extract on the second/third real use"; "NEVER use useEffect for event handling"; "dangerouslySetInnerHTML bypasses escaping" |
| S9–S11 | `client/src/app/**` | next-best-practices | thin route; URL state |
| S7–S11 | `client/**/*.test.tsx` | react-testing-library | "Mock at boundaries only"; "Write fewer, longer tests"; "Test behavior, not implementation" |
## Risks
- Lost update -> conditional UPDATE [I4]. Rename PK clash -> drop the duplicate owner row. AC9 flake -> warm-up.
## Notes for reviewers
- Arch: PC writes only its own tables, and reviews is unchanged. Security: store paths never touch the fs; the clone is read only via `FsCloneDocs.read` after `checkStorePath`; logs omit content; `<Markdown>` [C8].
