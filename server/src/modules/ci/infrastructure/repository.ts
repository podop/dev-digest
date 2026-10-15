/**
 * Ci data access (infrastructure; implements CiStore). Owns `ci_installations` and `ci_runs`; a stored
 * run also writes its `agent_runs` row (source='ci') in the same transaction. `ci_runs` has no
 * workspace column: runs are scoped through their `agent_runs` row, installations through their agent.
 */
import { and, desc, eq, inArray } from 'drizzle-orm';
import type { CiInstallation, CiRun } from '@devdigest/shared';
import type { Db } from '../../../db/client.js';
import * as t from '../../../db/schema.js';
import type {
  CiStore,
  NewCiRun,
  NewInstallation,
  UpsertInstallationResult,
} from '../application/ports.js';
import { toCiInstallation, toCiRun } from './mappers.js';
import { pgCode, UNIQUE_VIOLATION } from './pg-error.js';

const RUN_FIELDS = {
  id: t.ciRuns.id,
  installationId: t.ciRuns.ciInstallationId,
  agentId: t.agentRuns.agentId,
  agentName: t.agents.name,
  repo: t.ciInstallations.repo,
  prNumber: t.ciRuns.prNumber,
  ranAt: t.ciRuns.ranAt,
  status: t.ciRuns.status,
  findingsCount: t.ciRuns.findingsCount,
  costUsd: t.ciRuns.costUsd,
  githubUrl: t.ciRuns.githubUrl,
  durationMs: t.agentRuns.durationMs,
  blockers: t.agentRuns.blockers,
  headSha: t.ciRuns.headSha,
  manifestVersion: t.ciRuns.manifestVersion,
};

export class CiRepository implements CiStore {
  constructor(private readonly db: Db) {}

  /** The newest run of each given installation, scoped to the workspace (one query). */
  private async lastRuns(workspaceId: string, installationIds: string[]): Promise<Map<string, CiRun>> {
    if (installationIds.length === 0) return new Map();
    const rows = await this.db
      .selectDistinctOn([t.ciRuns.ciInstallationId], RUN_FIELDS)
      .from(t.ciRuns)
      .innerJoin(t.agentRuns, eq(t.agentRuns.id, t.ciRuns.agentRunId))
      .leftJoin(t.agents, eq(t.agents.id, t.agentRuns.agentId))
      .leftJoin(t.ciInstallations, eq(t.ciInstallations.id, t.ciRuns.ciInstallationId))
      .where(and(eq(t.agentRuns.workspaceId, workspaceId), inArray(t.ciRuns.ciInstallationId, installationIds)))
      .orderBy(t.ciRuns.ciInstallationId, desc(t.ciRuns.ranAt));
    const byInstallation = new Map<string, CiRun>();
    for (const row of rows) if (row.installationId) byInstallation.set(row.installationId, toCiRun(row));
    return byInstallation;
  }

  async listInstallations(workspaceId: string, filter: { agentId?: string } = {}): Promise<CiInstallation[]> {
    return this.installationsWhere(workspaceId, filter.agentId ? eq(t.ciInstallations.agentId, filter.agentId) : undefined);
  }

  async findInstallation(workspaceId: string, agentId: string, repo: string): Promise<CiInstallation | undefined> {
    const [found] = await this.installationsWhere(
      workspaceId,
      and(eq(t.ciInstallations.agentId, agentId), eq(t.ciInstallations.repo, repo)),
    );
    return found;
  }

  private async installationsWhere(
    workspaceId: string,
    extra: ReturnType<typeof and>,
  ): Promise<CiInstallation[]> {
    const rows = await this.db
      .select({ installation: t.ciInstallations })
      .from(t.ciInstallations)
      .innerJoin(t.agents, eq(t.agents.id, t.ciInstallations.agentId))
      .where(and(eq(t.agents.workspaceId, workspaceId), eq(t.ciInstallations.targetType, 'gha'), extra))
      .orderBy(desc(t.ciInstallations.installedAt));
    const last = await this.lastRuns(workspaceId, rows.map((r) => r.installation.id));
    return rows.map(({ installation: i }) =>
      toCiInstallation(
        {
          id: i.id,
          agentId: i.agentId,
          repo: i.repo,
          targetType: i.targetType,
          installedAt: i.installedAt,
          slug: i.slug,
          manifestVersion: i.manifestVersion,
        },
        last.get(i.id) ?? null,
      ),
    );
  }

  async slugOwner(repo: string, slug: string): Promise<string | undefined> {
    const [row] = await this.db
      .select({ agentId: t.ciInstallations.agentId })
      .from(t.ciInstallations)
      .where(and(eq(t.ciInstallations.repo, repo), eq(t.ciInstallations.slug, slug)));
    return row?.agentId;
  }

  async upsertInstallation(values: NewInstallation): Promise<UpsertInstallationResult> {
    try {
      await this.db
        .insert(t.ciInstallations)
        .values({
          agentId: values.agentId,
          repo: values.repo,
          targetType: 'gha',
          slug: values.slug,
          manifestVersion: values.manifestVersion,
        })
        .onConflictDoUpdate({
          target: [t.ciInstallations.agentId, t.ciInstallations.repo, t.ciInstallations.targetType],
          set: { slug: values.slug, manifestVersion: values.manifestVersion },
        });
      return { kind: 'saved' };
    } catch (err) {
      // (repo, slug) taken by another agent between the pre-check and the write.
      if (pgCode(err) === UNIQUE_VIOLATION) return { kind: 'slug_taken' };
      throw err;
    }
  }

  async storedRunKeys(runs: { id: number; attempt: number }[]): Promise<Set<string>> {
    if (runs.length === 0) return new Set();
    const rows = await this.db
      .select({ id: t.ciRuns.githubRunId, attempt: t.ciRuns.runAttempt })
      .from(t.ciRuns)
      .where(inArray(t.ciRuns.githubRunId, runs.map((r) => r.id)));
    return new Set(rows.map((r) => `${r.id}:${r.attempt}`));
  }

  async recordRun(run: NewCiRun): Promise<boolean> {
    return this.db.transaction(async (tx) => {
      // The unique (run id, attempt) is the idempotency key: a duplicate inserts nothing (EC6).
      const [ci] = await tx
        .insert(t.ciRuns)
        .values({
          ciInstallationId: run.installationId,
          prNumber: run.prNumber,
          ranAt: run.ranAt,
          status: run.status,
          findingsCount: run.findingsCount,
          costUsd: run.costUsd,
          githubUrl: run.githubUrl,
          source: 'gha',
          githubRunId: run.githubRunId,
          runAttempt: run.runAttempt,
          headSha: run.headSha,
          manifestVersion: run.manifestVersion,
        })
        .onConflictDoNothing({ target: [t.ciRuns.githubRunId, t.ciRuns.runAttempt] })
        .returning({ id: t.ciRuns.id });
      if (!ci) return false;
      const [agentRun] = await tx
        .insert(t.agentRuns)
        .values({
          workspaceId: run.workspaceId,
          agentId: run.agentId,
          prId: null,
          ranAt: run.ranAt,
          provider: 'openrouter',
          model: run.model,
          durationMs: run.durationMs,
          costUsd: run.costUsd,
          status: run.status === 'failed' ? 'failed' : 'done',
          error: run.error,
          source: 'ci',
          findingsCount: run.findingsCount,
          blockers: run.blockers,
        })
        .returning({ id: t.agentRuns.id });
      if (!agentRun) throw new Error('agent_runs insert returned no row');
      await tx.update(t.ciRuns).set({ agentRunId: agentRun.id }).where(eq(t.ciRuns.id, ci.id));
      return true;
    });
  }

  async listRuns(workspaceId: string, filter: { agentId?: string; limit: number }): Promise<CiRun[]> {
    const rows = await this.db
      .select(RUN_FIELDS)
      .from(t.ciRuns)
      .innerJoin(t.agentRuns, eq(t.agentRuns.id, t.ciRuns.agentRunId))
      .leftJoin(t.agents, eq(t.agents.id, t.agentRuns.agentId))
      .leftJoin(t.ciInstallations, eq(t.ciInstallations.id, t.ciRuns.ciInstallationId))
      .where(
        and(
          eq(t.agentRuns.workspaceId, workspaceId),
          filter.agentId ? eq(t.agentRuns.agentId, filter.agentId) : undefined,
        ),
      )
      .orderBy(desc(t.ciRuns.ranAt))
      .limit(filter.limit);
    return rows.map(toCiRun);
  }
}
