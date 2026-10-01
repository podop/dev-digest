import type { Container } from '../../platform/container.js';
import { ProjectContextService } from './application/project-context-service.js';
import { FsCloneDocs } from './infrastructure/clone-docs.js';
import { ProjectContextRepository } from './infrastructure/repository.js';

/**
 * Composition root of the project-context module (lazy:
 * `Container.modules.projectContext`). Documents come from the local clone
 * (`FsCloneDocs`) for the browser and from git at the PR base commit for runs;
 * no LLM, no background jobs. Listable globs are server config
 * (`PROJECT_CONTEXT_GLOBS`).
 */
export function buildProjectContextModule(c: Container) {
  const service = new ProjectContextService({
    store: new ProjectContextRepository(c.db),
    tx: c.transactionRunner((db) => ({ store: new ProjectContextRepository(db) })),
    docs: new FsCloneDocs(),
    // Resolved per call so test overrides of `c.git` keep working.
    git: {
      resolveBaseCommit: (repo, baseRef, head) => c.git.resolveBaseCommit(repo, baseRef, head),
      readFileAt: (repo, sha, path, opts) => c.git.readFileAt(repo, sha, path, opts),
    },
    globs: c.config.projectContextGlobs,
  });
  return { service };
}
