import PQueue from 'p-queue';
import type { Container } from '../../platform/container.js';
import { MultiAgentService } from './application/multi-agent-service.js';
import { ReviewService } from './application/review-service.js';
import { ReviewRunExecutor } from './application/run-executor.js';
import { ReviewRepository } from './repository.js';
import { MultiAgentRepository } from './repository/multi-agent.repo.js';

/**
 * Composition root of the reviews module (lazy: `Container.modules.reviews`).
 * Adapters are resolved per call (`c.git`, `c.repoIntel`, `c.llm`) so test
 * overrides and secret rotation keep working.
 */
export function buildReviewsModule(c: Container) {
  const reviews = new ReviewRepository(c.db);
  const clock = () => new Date();
  const executor = new ReviewRunExecutor({
    reviews,
    tx: c.transactionRunner((db) => ({ reviews: new ReviewRepository(db) })),
    runBus: c.runBus,
    llm: (provider) => c.llm(provider),
    git: { diff: (repo, base, head) => c.git.diff(repo, base, head) },
    repoIntel: {
      getCallerSignatures: (repoId, files, limit) => c.repoIntel.getCallerSignatures(repoId, files, limit),
      getRepoMap: (repoId, budget) => c.repoIntel.getRepoMap(repoId, budget),
      getFileRank: (repoId, paths) => c.repoIntel.getFileRank(repoId, paths),
    },
    skills: reviews,
    clock,
    // Agents of one batch run in parallel, at most REVIEW_AGENT_CONCURRENCY at once.
    runBounded: (tasks) => new PQueue({ concurrency: c.config.reviewAgentConcurrency }).addAll(tasks),
    ...(c.config.reviewMapConcurrency !== undefined ? { mapConcurrency: c.config.reviewMapConcurrency } : {}),
    // Intent layer (server/specs/05-intent-layer.md): reached only through this
    // port, never a direct import of modules/intent internals. Kill switch off
    // → no port wired → resolveIntentPrework short-circuits to {} (no call, no
    // pr_intent row, prompt byte-identical to before this feature).
    ...(c.config.reviewIntentEnabled
      ? { intent: { resolveForReview: (input) => c.modules.intent.service.resolveForReview(input) } }
      : {}),
    // Project Context: documents attached to the agent/its skills, read at the PR
    // base commit — reached only through this port, never module internals.
    projectContext: { resolveForRun: (input) => c.modules.projectContext.service.resolveForRun(input) },
    promptLog: c.promptLog,
  });
  return {
    service: new ReviewService({ reviews, agents: c.agentsRepo, runBus: c.runBus, executor, clock }),
    // Multi-agent read model + Learn (same module, no module of its own).
    multiAgent: new MultiAgentService({
      store: new MultiAgentRepository(c.db),
      tx: c.transactionRunner((db) => ({ learn: new MultiAgentRepository(db) })),
    }),
  };
}
