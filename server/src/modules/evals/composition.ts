import PQueue from 'p-queue';
import { parseUnifiedDiff } from '../../adapters/git/diff-parser.js';
import { AGENT_PROVIDERS } from '../../db/schema.js';
import type { Container } from '../../platform/container.js';
import { ConfigError } from '../../platform/errors.js';
import { EvalCasesService } from './application/eval-cases-service.js';
import { EvalRunExecutor } from './application/run-executor.js';
import { EvalRunsService } from './application/eval-runs-service.js';
import { EVAL_CASE_CONCURRENCY } from './domain/constants.js';
import { AgentConfigSnapshots } from './infrastructure/agent-snapshots.js';
import { EvalsRepository } from './infrastructure/repository.js';

/** Narrow a stored provider string to a provider id the container can resolve. */
function providerId(provider: string): (typeof AGENT_PROVIDERS)[number] {
  const id = AGENT_PROVIDERS.find((p) => p === provider);
  if (!id) throw new ConfigError(`Unknown LLM provider "${provider}"`);
  return id;
}

/**
 * Composition root of the evals module (lazy: `Container.modules.evals`).
 * `cases` = eval case use cases; `runs` = run use cases (start / list / compare /
 * dashboards / reap / shutdown). The agents repository is the only cross-module
 * reach, through the `AgentDirectory` and `AgentSnapshots` ports.
 */
export function buildEvalsModule(c: Container) {
  const store = new EvalsRepository(c.db);
  const snapshots = new AgentConfigSnapshots(c.agentsRepo);
  const agents = {
    exists: async (workspaceId: string, agentId: string) =>
      (await c.agentsRepo.getById(workspaceId, agentId)) !== undefined,
    listIds: async (workspaceId: string) => (await c.agentsRepo.list(workspaceId)).map((a) => a.id),
    snapshot: (workspaceId: string, agentId: string) => snapshots.snapshot(workspaceId, agentId),
  };
  const executor = new EvalRunExecutor({
    runs: store,
    // Resolved per call so test overrides and secret rotation keep working.
    llm: (provider) => c.llm(providerId(provider)),
    parseDiff: parseUnifiedDiff,
    runBounded: (tasks) => new PQueue({ concurrency: EVAL_CASE_CONCURRENCY }).addAll(tasks),
  });
  return {
    cases: new EvalCasesService({
      cases: store,
      tx: c.transactionRunner((db) => ({ cases: new EvalsRepository(db) })),
      agents,
    }),
    runs: new EvalRunsService({ runs: store, agents, executor }),
  };
}
