/**
 * blast data access (infrastructure; implements BlastSource). Reads the PR,
 * its repo and the persisted pr_files — each module owns the reads it needs.
 */
import { and, eq } from 'drizzle-orm';
import type { Db } from '../../../db/client.js';
import * as t from '../../../db/schema.js';
import type { BlastPull, BlastSource } from '../application/ports.js';

export class BlastRepository implements BlastSource {
  constructor(private readonly db: Db) {}

  async findPull(workspaceId: string, prId: string): Promise<BlastPull | null> {
    const [row] = await this.db
      .select({
        repoId: t.pullRequests.repoId,
        number: t.pullRequests.number,
        owner: t.repos.owner,
        name: t.repos.name,
      })
      .from(t.pullRequests)
      .innerJoin(t.repos, eq(t.repos.id, t.pullRequests.repoId))
      .where(and(eq(t.pullRequests.workspaceId, workspaceId), eq(t.pullRequests.id, prId)));
    if (!row) return null;
    const files = await this.db.select({ path: t.prFiles.path }).from(t.prFiles).where(eq(t.prFiles.prId, prId)).orderBy(t.prFiles.path);
    return { ...row, files: files.map((f) => f.path) };
  }
}
