import type { Container } from '../../platform/container.js';
import { BlastService } from './application/blast-service.js';
import { BlastRepository } from './infrastructure/repository.js';

/**
 * Composition root of the blast module (lazy: `Container.modules.blast`).
 * The index is reached only here, through `c.repoIntel` (= the repo-intel
 * module's service, or `overrides.repoIntel` in tests) behind a local port.
 * Prior PRs come from the container's github adapter. No background jobs (server/specs/07-blast-radius.md).
 */
export function buildBlastModule(c: Container) {
  const repository = new BlastRepository(c.db);
  const service = new BlastService({
    source: repository,
    index: { getBlastRadius: (repoId, changedFiles) => c.repoIntel.getBlastRadius(repoId, changedFiles) },
    // c.github() throws ConfigError without a token — the service turns that into an empty history.
    history: { listMergedPullRequests: async (repo, opts) => (await c.github()).listMergedPullRequests(repo, opts) },
  });
  return { service };
}
