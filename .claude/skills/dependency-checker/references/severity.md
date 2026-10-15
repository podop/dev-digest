# Severity tiers

Four tiers. Pick the **highest** tier whose condition holds; when unsure between two,
take the lower one and say why in Evidence. Only verified findings get P0–P2.

| Tier | Meaning | Deadline |
|---|---|---|
| **P0** | Breaks a build, a fresh install or production, leaks a vulnerability, or breaks a package boundary | before the next merge |
| **P1** | Real cost or risk now: dead runtime weight, two versions of a library that crosses a package boundary, a runtime import that only works by accident | this sprint |
| **P2** | Hygiene with a small payoff | backlog |
| **Info** | Worth knowing, nothing to do (or unverified) | — |

## P0

- **Boundary violation** — a relative import from one package into another package's
  files (`boundary_violations`), e.g. `server/src/x.ts` → `../../reviewer-core/src/pipeline.js`
  instead of the `@devdigest/reviewer-core` alias / public entry.
- **Deep import of another package's internals** through a `/*` alias when the symbol is
  not re-exported from that package's `index.ts` (couples to private files).
- **Shared contract drift** — `shared_drift.identical == false`
  (`./scripts/check-shared-drift.sh` fails; CI fails too).
- **Critical / high vulnerability** in a **prod** dependency (`--online` audit), or one
  reachable at runtime.
- **Phantom runtime import** — imported from `src` (not tests), not declared in that
  package's manifest, resolves only through hoisting (`confidence: high`): a clean or
  `--prod` install breaks it.
- A declared dependency that is **not installed** while code imports it (broken checkout).

## P1

- **Unused prod dependency**, verified (no import, no config/CSS/script reference, not
  a convention-loaded plugin).
- **Version drift (major)** of the same library across packages, or **any drift**
  (minor too) of a library whose objects cross a package boundary: `zod` / `openai` /
  shared-contract deps between `server` ↔ `reviewer-core` ↔ `mcp` (reviewer-core is
  consumed as source, so both copies load in one process).
- **Dev dependency imported from runtime `src`** (`dev_imported_from_src`) on a path
  that runs in production — a `--prod` install breaks it.
- **Moderate vulnerability** in a prod dependency (`--online`).
- A **prod** dependency that is ≥ 10 MB of closure and is used by ≤ 2 files where a
  lighter option or a lazy `import()` exists (verified usage — see heuristics).

## P2

- **Unused dev dependency**, verified.
- **Redundant direct declaration** (`redundant-direct`) — only arrives transitively and
  is never imported; remove unless it intentionally pins a version.
- **Prod dependency used only in tests/tooling** (`prod_only_in_tests`) → move to devDependencies.
- **Version drift (minor/patch)** of dev tooling across packages (vitest, tsx, @types/node).
- **Outdated by ≥ 1 major** (`--online`, `major_behind ≥ 1`) without a known vulnerability.
- Low vulnerability, or one in a dev-only tool.

## Info

- The same dev tool installed separately in every package — expected without a workspace.
- Large but justified weight: framework cores (`next`), platform-native binaries
  (`@next/swc-*`, `@biomejs/cli-*`, `@esbuild/*`, `*-linux-x64(-musl)`), test containers.
- Both glibc and musl native variants installed (only one is used) — disk only.
- Two copies of the same version of a library loaded across a source-consumed boundary.
- `module-redirect` aliases (`zod` → own node_modules) — intentional.
- Candidates you could not verify — mark "unverified".

## Tie-breakers inside a tier

1. runtime (prod) over tooling (dev);
2. more packages affected over fewer;
3. bigger measured win (MB, files touched) over smaller;
4. cheaper fix first when impact is equal.
