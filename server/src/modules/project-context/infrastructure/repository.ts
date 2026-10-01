/**
 * project-context data access (infrastructure; implements ContextStore). Reads
 * the repo and the owners it needs itself — each module owns its reads — and
 * owns the two attachment tables. Attachments are never part of agent/skill
 * version snapshots, so nothing here touches `agents.version`.
 */
import { and, asc, eq } from 'drizzle-orm';
import type { DbOrTx } from '../../../db/client.js';
import { NotFoundError } from '../../../platform/errors.js';
import * as t from '../../../db/schema.js';
import type { ContextRepoRef, ContextStore, UsageRow } from '../application/ports.js';

/** pg SQLSTATE of a driver error (Drizzle wraps it: the code is on `cause`). */
function sqlState(err: unknown): string | undefined {
  const e = err as { code?: string; cause?: { code?: string } } | null;
  return e?.cause?.code ?? e?.code;
}

/** The owner or repo was deleted after the existence check: report it as 404, not 500. */
async function insertOrNotFound(insert: Promise<unknown>, code: 'agent_not_found' | 'skill_not_found') {
  try {
    await insert;
  } catch (err) {
    if (sqlState(err) === '23503') throw new NotFoundError('Owner or repository no longer exists', undefined, code);
    throw err;
  }
}

export class ProjectContextRepository implements ContextStore {
  constructor(private readonly db: DbOrTx) {}

  async findRepo(workspaceId: string, repoId: string): Promise<ContextRepoRef | null> {
    const [row] = await this.db
      .select({ id: t.repos.id, owner: t.repos.owner, name: t.repos.name, clonePath: t.repos.clonePath })
      .from(t.repos)
      .where(and(eq(t.repos.workspaceId, workspaceId), eq(t.repos.id, repoId)));
    return row ?? null;
  }

  async agentExists(workspaceId: string, agentId: string): Promise<boolean> {
    const [row] = await this.db
      .select({ id: t.agents.id })
      .from(t.agents)
      .where(and(eq(t.agents.workspaceId, workspaceId), eq(t.agents.id, agentId)));
    return row !== undefined;
  }

  async skillExists(workspaceId: string, skillId: string): Promise<boolean> {
    const [row] = await this.db
      .select({ id: t.skills.id })
      .from(t.skills)
      .where(and(eq(t.skills.workspaceId, workspaceId), eq(t.skills.id, skillId)));
    return row !== undefined;
  }

  async listUsage(repoId: string): Promise<UsageRow[]> {
    const direct = await this.db
      .select({ path: t.agentContextDocs.path, agentId: t.agents.id, agentName: t.agents.name })
      .from(t.agentContextDocs)
      .innerJoin(t.agents, eq(t.agents.id, t.agentContextDocs.agentId))
      .where(eq(t.agentContextDocs.repoId, repoId))
      .orderBy(asc(t.agents.name), asc(t.agents.id));
    // Every linked skill counts, enabled or not (FR10 is literal about "link a skill").
    const viaSkill = await this.db
      .select({
        path: t.skillContextDocs.path,
        agentId: t.agents.id,
        agentName: t.agents.name,
        skillName: t.skills.name,
      })
      .from(t.skillContextDocs)
      .innerJoin(t.agentSkills, eq(t.agentSkills.skillId, t.skillContextDocs.skillId))
      .innerJoin(t.agents, eq(t.agents.id, t.agentSkills.agentId))
      .innerJoin(t.skills, eq(t.skills.id, t.skillContextDocs.skillId))
      .where(eq(t.skillContextDocs.repoId, repoId))
      .orderBy(asc(t.agents.name), asc(t.agents.id), asc(t.skills.name));
    return [
      ...direct.map((r): UsageRow => ({ ...r, via: 'direct', skillName: null })),
      ...viaSkill.map((r): UsageRow => ({ ...r, via: 'skill' })),
    ];
  }

  async getAgentPaths(agentId: string, repoId: string): Promise<string[]> {
    const rows = await this.db
      .select({ path: t.agentContextDocs.path })
      .from(t.agentContextDocs)
      .where(and(eq(t.agentContextDocs.agentId, agentId), eq(t.agentContextDocs.repoId, repoId)))
      .orderBy(asc(t.agentContextDocs.position));
    return rows.map((r) => r.path);
  }

  async getSkillPaths(skillId: string, repoId: string): Promise<string[]> {
    const rows = await this.db
      .select({ path: t.skillContextDocs.path })
      .from(t.skillContextDocs)
      .where(and(eq(t.skillContextDocs.skillId, skillId), eq(t.skillContextDocs.repoId, repoId)))
      .orderBy(asc(t.skillContextDocs.position));
    return rows.map((r) => r.path);
  }

  /**
   * Replace the list. Must run on a transaction handle (see the module's
   * TransactionRunner): the owner row is locked first so two concurrent PUTs
   * for the same owner serialise instead of colliding on the primary key.
   */
  async replaceAgentPaths(agentId: string, repoId: string, paths: readonly string[]): Promise<void> {
    await this.db.select({ id: t.agents.id }).from(t.agents).where(eq(t.agents.id, agentId)).for('update');
    await this.db
      .delete(t.agentContextDocs)
      .where(and(eq(t.agentContextDocs.agentId, agentId), eq(t.agentContextDocs.repoId, repoId)));
    if (paths.length === 0) return;
    await insertOrNotFound(
      this.db.insert(t.agentContextDocs).values(paths.map((path, position) => ({ agentId, repoId, path, position }))),
      'agent_not_found',
    );
  }

  async replaceSkillPaths(skillId: string, repoId: string, paths: readonly string[]): Promise<void> {
    await this.db.select({ id: t.skills.id }).from(t.skills).where(eq(t.skills.id, skillId)).for('update');
    await this.db
      .delete(t.skillContextDocs)
      .where(and(eq(t.skillContextDocs.skillId, skillId), eq(t.skillContextDocs.repoId, repoId)));
    if (paths.length === 0) return;
    await insertOrNotFound(
      this.db.insert(t.skillContextDocs).values(paths.map((path, position) => ({ skillId, repoId, path, position }))),
      'skill_not_found',
    );
  }
}
