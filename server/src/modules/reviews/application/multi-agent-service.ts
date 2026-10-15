import type {
  AgentRunEstimate,
  FindingRecord,
  MultiAgentRun,
  MultiAgentRunSummary,
} from '@devdigest/shared';
import { InvalidInputError, NotFoundError } from '../../../platform/errors.js';
import { MULTI_AGENT_LIST_LIMIT } from '../domain/constants.js';
import { groupFindings, learnedMemoryContent, orderColumns, runTotals } from '../domain/multi-agent.js';
import type { LearnTx, Logger, MultiAgentStore } from './ports.js';

export interface MultiAgentServiceDeps {
  store: MultiAgentStore;
  /** Learn's lookup + insert run in one transaction under an advisory lock. */
  tx: LearnTx;
}

/**
 * Multi-agent use cases: the comparison read model of one parent run, the
 * repo's recent runs, per-agent estimates, and Learn (a finding → one memory
 * entry). Reads derive totals / groups on every call and make no LLM call.
 */
export class MultiAgentService {
  constructor(private readonly deps: MultiAgentServiceDeps) {}

  /** The parent run with one column per agent run, run totals and the location groups. */
  async get(workspaceId: string, id: string): Promise<MultiAgentRun> {
    const { store } = this.deps;
    const header = await store.getMultiAgentRun(workspaceId, id);
    if (!header) throw new NotFoundError('Multi-agent run not found', undefined, 'multi_agent_run_not_found');
    const columns = orderColumns(await store.columnsForMultiAgentRun(workspaceId, id));
    return {
      id: header.id,
      pr_id: header.prId,
      repo_id: header.repoId,
      pr_number: header.prNumber,
      pr_title: header.prTitle,
      ran_at: header.ranAt.toISOString(),
      agent_count: columns.length,
      ...runTotals(columns),
      columns,
      conflicts: groupFindings(columns),
    };
  }

  /** The repo's newest multi-agent runs (default and maximum 20). */
  async list(workspaceId: string, repoId: string, limit?: number): Promise<MultiAgentRunSummary[]> {
    if (limit !== undefined && (limit < 1 || limit > MULTI_AGENT_LIST_LIMIT)) {
      throw new InvalidInputError(`limit must be between 1 and ${MULTI_AGENT_LIST_LIMIT}`, undefined, 'invalid_limit');
    }
    const { store } = this.deps;
    if (!(await store.repoInWorkspace(workspaceId, repoId))) throw new NotFoundError('Repo not found');
    const rows = await store.listMultiAgentRuns(workspaceId, repoId, limit ?? MULTI_AGENT_LIST_LIMIT);
    return rows.map((r) => ({
      id: r.id,
      pr_id: r.prId,
      pr_number: r.prNumber,
      pr_title: r.prTitle,
      ran_at: r.ranAt.toISOString(),
      agent_count: r.agentCount,
      running_count: r.runningCount,
      total_cost_usd: r.totalCostUsd,
    }));
  }

  /** Average duration / cost per agent over its last done runs. */
  async estimates(workspaceId: string): Promise<AgentRunEstimate[]> {
    const rows = await this.deps.store.agentRunEstimates(workspaceId);
    return rows.map((r) => ({
      agent_id: r.agentId,
      sample_size: r.sampleSize,
      avg_duration_ms: r.avgDurationMs,
      avg_cost_usd: r.avgCostUsd,
    }));
  }

  /**
   * Save a finding as one `learning` memory entry (no embedding, no LLM call).
   * Idempotent: lookup and insert share one transaction and an advisory lock on
   * the finding, so repeated or concurrent calls return the same entry.
   */
  async learn(
    workspaceId: string,
    findingId: string,
    logger?: Logger,
  ): Promise<{ finding: FindingRecord; memoryId: string }> {
    const target = await this.deps.store.findingForLearn(findingId);
    if (!target || target.workspaceId !== workspaceId) throw new NotFoundError('Finding not found');
    const { finding } = target;
    const memoryId = await this.deps.tx.run(async ({ learn }) => {
      await learn.lockLearn(findingId);
      const existing = (await learn.memoryIdsForFindings(workspaceId, [findingId])).get(findingId);
      if (existing) return existing;
      return learn.insertLearnedMemory({
        workspaceId,
        repoId: target.repoId,
        findingId,
        prNumber: target.prNumber,
        content: learnedMemoryContent(finding),
        confidence: finding.confidence,
      });
    });
    logger?.info({ findingId, memoryId }, 'review: finding learned');
    return { finding: { ...finding, memory_id: memoryId }, memoryId };
  }
}
