/**
 * brief data access (infrastructure; implements BriefStore). The brief lives in
 * `pr_brief.json` (one row per PR). A stored value that no longer matches the
 * contract (an older shape) reads as "no brief": it is parsed with `safeParse`,
 * never thrown on. Each module owns the reads it needs, so the PR, its files and
 * the current reviews are read here directly.
 */
import { and, desc, eq, inArray } from 'drizzle-orm';
import { PrBrief } from '@devdigest/shared';
import type { DbOrTx } from '../../../db/client.js';
import * as t from '../../../db/schema.js';
import type { BriefFileRow, BriefPull, BriefStore, CurrentReview } from '../application/ports.js';

export class BriefRepository implements BriefStore {
  constructor(private readonly db: DbOrTx) {}

  async findPull(workspaceId: string, prId: string): Promise<BriefPull | null> {
    const [row] = await this.db
      .select({
        id: t.pullRequests.id,
        repoId: t.pullRequests.repoId,
        owner: t.repos.owner,
        name: t.repos.name,
        title: t.pullRequests.title,
        body: t.pullRequests.body,
        base: t.pullRequests.base,
        headSha: t.pullRequests.headSha,
      })
      .from(t.pullRequests)
      .innerJoin(t.repos, eq(t.repos.id, t.pullRequests.repoId))
      .where(and(eq(t.pullRequests.workspaceId, workspaceId), eq(t.pullRequests.id, prId)));
    if (!row) return null;
    const { owner, name, ...pull } = row;
    return { ...pull, repo: { owner, name } };
  }

  async listFiles(prId: string): Promise<BriefFileRow[]> {
    return this.db
      .select({ path: t.prFiles.path, additions: t.prFiles.additions, deletions: t.prFiles.deletions, patch: t.prFiles.patch })
      .from(t.prFiles)
      .where(eq(t.prFiles.prId, prId))
      .orderBy(t.prFiles.path);
  }

  /** The newest `kind='review'` row of EACH agent (DISTINCT ON agent), with its findings (dismissed too), newest first. */
  async currentReviews(prId: string): Promise<CurrentReview[]> {
    const current = await this.db
      .selectDistinctOn([t.reviews.agentId], { id: t.reviews.id, agentId: t.reviews.agentId, createdAt: t.reviews.createdAt })
      .from(t.reviews)
      .where(and(eq(t.reviews.prId, prId), eq(t.reviews.kind, 'review')))
      .orderBy(t.reviews.agentId, desc(t.reviews.createdAt));
    if (current.length === 0) return [];
    const rows = await this.db
      .select({
        reviewId: t.findings.reviewId,
        severity: t.findings.severity,
        file: t.findings.file,
        startLine: t.findings.startLine,
        endLine: t.findings.endLine,
        title: t.findings.title,
      })
      .from(t.findings)
      .where(inArray(t.findings.reviewId, current.map((r) => r.id)))
      .orderBy(t.findings.file, t.findings.startLine);
    return current
      .map((r) => ({
        agentId: r.agentId,
        createdAt: r.createdAt,
        findings: rows.filter((f) => f.reviewId === r.id).map(({ reviewId: _reviewId, ...f }) => f),
      }))
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  }

  /** The agent's linked, ENABLED skills in link order (a disabled skill stays linked but is skipped). */
  async enabledSkills(agentId: string): Promise<{ id: string; name: string }[]> {
    return this.db
      .select({ id: t.skills.id, name: t.skills.name })
      .from(t.agentSkills)
      .innerJoin(t.skills, eq(t.skills.id, t.agentSkills.skillId))
      .where(and(eq(t.agentSkills.agentId, agentId), eq(t.skills.enabled, true)))
      .orderBy(t.agentSkills.order);
  }

  async getBrief(prId: string): Promise<PrBrief | null> {
    const [row] = await this.db.select({ json: t.prBrief.json }).from(t.prBrief).where(eq(t.prBrief.prId, prId));
    if (!row) return null;
    const parsed = PrBrief.safeParse(row.json);
    return parsed.success ? parsed.data : null;
  }

  async upsertBrief(prId: string, brief: PrBrief): Promise<void> {
    await this.db
      .insert(t.prBrief)
      .values({ prId, json: brief })
      .onConflictDoUpdate({ target: t.prBrief.prId, set: { json: brief } });
  }
}
