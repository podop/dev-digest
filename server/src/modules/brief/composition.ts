import { Intent } from '@devdigest/shared';
import type { Container } from '../../platform/container.js';
import { BriefService } from './application/brief-service.js';
import { LlmBriefModel } from './infrastructure/llm-model.js';
import { GitHubIssueSource } from './infrastructure/issue-source.js';
import { BriefRepository } from './infrastructure/repository.js';

/**
 * Composition root of the brief module (lazy: `Container.modules.brief`). Reached from
 * here only: intent (stored intent read), blast (blast radius read), project-context
 * (attached documents of an agent), settings (the `risk_brief` feature model) and the
 * container's GitHub/LLM adapters. No background jobs — a brief is generated inline on POST.
 */
export function buildBriefModule(c: Container) {
  const service = new BriefService({
    store: new BriefRepository(c.db),
    intent: {
      get: async (workspaceId, prId) => {
        const { intent } = await c.modules.intent.service.get(workspaceId, prId);
        // The stored record carries cache keys and usage; the brief snapshots the Intent fields only.
        const parsed = intent ? Intent.safeParse(intent) : null;
        return parsed?.success ? parsed.data : null;
      },
    },
    blast: { getBlast: (workspaceId, prId, log) => c.modules.blast.service.getBlast(workspaceId, prId, log) },
    specs: { resolveForRun: (input) => c.modules.projectContext.service.resolveForRun(input) },
    // Resolved per call so test overrides of `c.github` / `c.llm` keep working.
    issues: new GitHubIssueSource({ github: () => c.github() }),
    model: new LlmBriefModel({
      resolveModel: (workspaceId) => c.modules.settings.service.resolveFeatureModel(workspaceId, 'risk_brief'),
      llm: (provider) => c.llm(provider),
    }),
    clock: () => new Date(),
    promptLog: c.promptLog,
  });
  return { service };
}
