import type { Container } from '../../platform/container.js';
import { OnboardingService } from './application/onboarding-service.js';
import { LlmOnboardingModel } from './infrastructure/llm-model.js';
import { GitRepoFiles } from './infrastructure/repo-files.js';
import { OnboardingRepository } from './infrastructure/repository.js';

/**
 * Composition root of the onboarding module (lazy: `Container.modules.onboarding`).
 * Reached from here only: repo-intel (the index read facade), settings (the
 * `onboarding` feature model) and the container's git/LLM adapters. No background
 * jobs — a tour is generated inline on POST.
 */
export function buildOnboardingModule(c: Container) {
  const service = new OnboardingService({
    store: new OnboardingRepository(c.db),
    // Resolved per call so test overrides of `c.repoIntel` / `c.git` keep working.
    index: {
      getIndexState: (repoId) => c.repoIntel.getIndexState(repoId),
      getRepoMap: (repoId) => c.repoIntel.getRepoMap(repoId),
      getTopFilesByRank: (repoId, n) => c.repoIntel.getTopFilesByRank(repoId, n),
      getCriticalPaths: (repoId) => c.repoIntel.getCriticalPaths(repoId),
      listIndexedFiles: (repoId) => c.repoIntel.listIndexedFiles(repoId),
    },
    files: new GitRepoFiles({ readFileAt: (repo, sha, path, opts) => c.git.readFileAt(repo, sha, path, opts) }),
    model: new LlmOnboardingModel({
      resolveModel: (workspaceId) => c.modules.settings.service.resolveFeatureModel(workspaceId, 'onboarding'),
      llm: (provider) => c.llm(provider),
    }),
    clock: () => new Date(),
  });
  return { service };
}
