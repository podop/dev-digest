# Verification and advice

## Verify each candidate type

### `unreferenced` (possibly unused)

1. Grep the exact name in the package, outside `node_modules`:
   `Grep pattern="<name>" path="<pkg>"` — include `*.mjs`, `*.cjs`, `*.css`, `*.json`,
   `Dockerfile*`, `*.sh`, `*.yml`, `.github/workflows` (for root CI using the package).
2. Check `package.json` scripts for its bin (`bins_in_scripts` is empty, but a bin can
   be renamed — read the dep's own `package.json` `bin` field).
3. Rule out **convention-loaded** packages (loaded by name, never imported):

   | Package pattern | Loaded by |
   |---|---|
   | `@types/*` | the TypeScript compiler (status `types`) |
   | `@vitest/coverage-*` | `vitest --coverage` / `coverage.provider` in vitest config |
   | `postcss`, `@tailwindcss/postcss`, `autoprefixer` | `postcss.config.*` (object keys), Next's CSS pipeline |
   | `tailwindcss` (v4) | `@import "tailwindcss"` in CSS |
   | `jsdom`, `happy-dom` | `environment:` in vitest config |
   | `pino-pretty` | a `transport.target` string |
   | `eslint-*`, `prettier-*`, `@biomejs/*` | config files / CLI |
   | `tsx`, `ts-node` | scripts, shebangs, `node --import tsx` |

4. Only then: "unused (verified: grep found no reference in <pkg>)".

### `redundant-direct`

`required_by` lists who pulls it in. Remove only if it is not imported anywhere and the
declared range is not deliberately different from the parent's (a pin). If the parent is
the thing actually used (e.g. `@testcontainers/postgresql` → `testcontainers`), say so.

### `phantom_imports`

- `confidence: high` (resolves): open the file:line; real import → declare it in that
  package (`pnpm add <name>` / `npm i <name>`) with the version it currently resolves to.
- `confidence: low` (does not resolve): almost always import-looking text inside a string,
  fixture or template literal (e.g. code-analysis tests). Drop unless the file shows a
  real import.

### `boundary_violations` and `deep_imports`

Open the importing line. Check the target package's public entry (`index.ts`, and its
README "public surface" if any). The fix is importing through the alias root
(`@devdigest/reviewer-core`) and, if the symbol is missing there, exporting it from the
target's `index.ts` — a change in the **target** package.

### `dev_imported_from_src` / `prod_only_in_tests`

Read the importing file: does it run when the app runs (route, adapter, CLI used in
production) or only in dev tooling / tests? Adapters wrapping a dev tool on purpose
(e.g. a code-graph adapter over `dependency-cruiser`) still need the dep in
`dependencies` if the feature runs at runtime.

### `version_drift`

Report `major`/`minor`. Name each package with its installed version, and say which
copy wins where (Node resolves from the importing file's directory).

## Reading the sizes

- `own_kb` — the package directory alone. `closure_kb` — the package plus everything it
  pulls in (unique). Closures of different deps share members: never add them up.
- `heaviest_members` explains a big closure — usually a platform binary
  (`@next/swc-*`, `@esbuild/*`, `@biomejs/cli-*`, `*-linux-x64-musl`).
- `size.prod_closure_kb` ≈ what the app needs at runtime; `tooling_kb` = the rest
  (test runners, compilers, linters).
- Disk weight is not bundle weight. For `client/`, a large prod dep matters for the
  browser only if it is imported into client components — check before promising a
  bundle win.

## Advice catalog — use only when the evidence fits

| Signal (verified) | Advice |
|---|---|
| Unused prod/dev dep | remove with the package's manager: `cd <pkg> && pnpm remove <dep>` / `npm uninstall <dep>` |
| Heavy client lib used in 1–2 screens (charts, diagrams, editors: `mermaid`, `recharts`, `@uiw/react-codemirror`) | load it lazily (`next/dynamic` / `import()`) inside that screen |
| Icon library imported broadly | keep named imports (tree-shaken); never `import *` |
| Date/utility lib used for 1–3 calls (`moment`, `lodash`) | replace with `Intl` / native methods, or a smaller lib (`date-fns`, `dayjs`) |
| Same lib, drifting versions across source-consumed packages | align the ranges to one version in every listed `package.json`, reinstall each package |
| Dev tooling versions drift (vitest 2 vs 3) | align when you next touch those packages; not urgent |
| Both glibc + musl native binaries installed | disk only; ignore locally, fine to leave |
| Phantom import | declare it explicitly in the importing package |
| Dev dep used at runtime | move to `dependencies` in that package |
| Prod dep used only in tests | move to `devDependencies` |
| Vulnerability with a fix | bump to the patched version named by audit; no `audit fix --force` |
