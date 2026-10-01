/**
 * project-context data access (infrastructure; implements ContextStore). Reads
 * the repo and the owners it needs itself — each module owns its reads — and
 * owns the two attachment tables. Attachments are never part of agent/skill
 * version snapshots, so nothing here touches `agents.version`.
 */
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import type { DbOrTx } from '../../../db/client.js';
import { ConflictError, NotFoundError } from '../../../platform/errors.js';
import * as t from '../../../db/schema.js';
import type {
  ContextFileInfo,
  ContextFileRow,
  ContextRepoRef,
  ContextStore,
  UsageRow,
} from '../application/ports.js';

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

const FILE_COLS = {
  path: t.contextFiles.path,
  content: t.contextFiles.content,
  sizeBytes: t.contextFiles.sizeBytes,
  version: t.contextFiles.version,
  updatedAt: t.contextFiles.updatedAt,
};

/** A taken (repo, path) is a 409, not a 500 (a concurrent writer got there first). */
const pathExists = () => new ConflictError('A file already exists at this path', undefined, 'path_exists');

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

  async listFiles(repoId: string): Promise<ContextFileInfo[]> {
    return this.db
      .select({
        path: t.contextFiles.path,
        sizeBytes: t.contextFiles.sizeBytes,
        chars: sql<number>`length(${t.contextFiles.content})`.mapWith(Number),
        version: t.contextFiles.version,
        updatedAt: t.contextFiles.updatedAt,
      })
      .from(t.contextFiles)
      .where(eq(t.contextFiles.repoId, repoId))
      .orderBy(sql`${t.contextFiles.path} COLLATE "C"`);
  }

  async findFile(repoId: string, path: string): Promise<ContextFileRow | null> {
    const [row] = await this.db
      .select(FILE_COLS)
      .from(t.contextFiles)
      .where(and(eq(t.contextFiles.repoId, repoId), eq(t.contextFiles.path, path)));
    return row ?? null;
  }

  async findFiles(repoId: string, paths: readonly string[]): Promise<ContextFileRow[]> {
    if (paths.length === 0) return [];
    return this.db
      .select(FILE_COLS)
      .from(t.contextFiles)
      .where(and(eq(t.contextFiles.repoId, repoId), inArray(t.contextFiles.path, [...paths])));
  }

  async lockRepo(workspaceId: string, repoId: string): Promise<ContextRepoRef | null> {
    const [row] = await this.db
      .select({ id: t.repos.id, owner: t.repos.owner, name: t.repos.name, clonePath: t.repos.clonePath })
      .from(t.repos)
      .where(and(eq(t.repos.workspaceId, workspaceId), eq(t.repos.id, repoId)))
      .for('update');
    return row ?? null;
  }

  async insertFile(repoId: string, path: string, content: string, sizeBytes: number): Promise<ContextFileRow> {
    try {
      const [row] = await this.db
        .insert(t.contextFiles)
        .values({ repoId, path, content, sizeBytes })
        .returning(FILE_COLS);
      return row!;
    } catch (err) {
      if (sqlState(err) === '23505') throw pathExists();
      if (sqlState(err) === '23503') throw new NotFoundError('Repository not found', undefined, 'repo_not_found');
      throw err;
    }
  }

  async saveFile(
    repoId: string,
    path: string,
    content: string,
    sizeBytes: number,
    baseVersion: number,
  ): Promise<ContextFileRow | null> {
    const [row] = await this.db
      .update(t.contextFiles)
      .set({ content, sizeBytes, version: sql`${t.contextFiles.version} + 1`, updatedAt: sql`now()` })
      .where(
        and(
          eq(t.contextFiles.repoId, repoId),
          eq(t.contextFiles.path, path),
          eq(t.contextFiles.version, baseVersion),
        ),
      )
      .returning(FILE_COLS);
    return row ?? null;
  }

  async renameFile(
    repoId: string,
    path: string,
    newPath: string,
    baseVersion: number,
  ): Promise<ContextFileRow | null> {
    try {
      const [row] = await this.db
        .update(t.contextFiles)
        .set({ path: newPath, version: sql`${t.contextFiles.version} + 1`, updatedAt: sql`now()` })
        .where(
          and(
            eq(t.contextFiles.repoId, repoId),
            eq(t.contextFiles.path, path),
            eq(t.contextFiles.version, baseVersion),
          ),
        )
        .returning(FILE_COLS);
      return row ?? null;
    } catch (err) {
      if (sqlState(err) === '23505') throw pathExists();
      throw err;
    }
  }

  /**
   * An owner that already has `to` attached keeps one row: the old `to` row is
   * dropped and the moved row keeps its own position. Run in the rename's transaction.
   */
  async moveAttachments(repoId: string, from: string, to: string): Promise<void> {
    const a = t.agentContextDocs;
    await this.db
      .delete(a)
      .where(
        and(
          eq(a.repoId, repoId),
          eq(a.path, to),
          inArray(a.agentId, this.db.select({ id: a.agentId }).from(a).where(and(eq(a.repoId, repoId), eq(a.path, from)))),
        ),
      );
    await this.db.update(a).set({ path: to }).where(and(eq(a.repoId, repoId), eq(a.path, from)));
    const s = t.skillContextDocs;
    await this.db
      .delete(s)
      .where(
        and(
          eq(s.repoId, repoId),
          eq(s.path, to),
          inArray(s.skillId, this.db.select({ id: s.skillId }).from(s).where(and(eq(s.repoId, repoId), eq(s.path, from)))),
        ),
      );
    await this.db.update(s).set({ path: to }).where(and(eq(s.repoId, repoId), eq(s.path, from)));
  }

  async deleteFile(repoId: string, path: string): Promise<boolean> {
    const rows = await this.db
      .delete(t.contextFiles)
      .where(and(eq(t.contextFiles.repoId, repoId), eq(t.contextFiles.path, path)))
      .returning({ id: t.contextFiles.id });
    return rows.length > 0;
  }
}
