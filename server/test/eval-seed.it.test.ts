import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { and, eq, isNotNull } from 'drizzle-orm';
import { groundFindings } from '@devdigest/reviewer-core';
import type { Finding } from '@devdigest/shared';
import { startPg, dockerAvailable, type PgFixture } from './helpers/pg.js';
import { parseUnifiedDiff } from '../src/adapters/git/diff-parser.js';
import { seed } from '../src/db/seed.js';
import { EVAL_DEMO_PR_NUMBER } from '../src/db/seed-eval-demo.js';
import * as t from '../src/db/schema.js';

const hasDocker = await dockerAvailable();
const d = hasDocker ? describe : describe.skip;

/** Eval demo seed (FR26 / AC24): Security Reviewer review on a demo PR, idempotent. */
d('eval demo seed (Testcontainers pg)', () => {
  let pg: PgFixture;
  let workspaceId: string;
  let prId: string;

  beforeAll(async () => {
    pg = await startPg();
    ({ workspaceId } = await seed(pg.handle.db));
    await seed(pg.handle.db); // twice: still exactly one review
    const [pr] = await pg.handle.db
      .select({ id: t.pullRequests.id })
      .from(t.pullRequests)
      .where(eq(t.pullRequests.number, EVAL_DEMO_PR_NUMBER));
    prId = pr!.id;
  });
  afterAll(async () => {
    await pg?.stop();
  });

  async function reviews() {
    const [agent] = await pg.handle.db
      .select({ id: t.agents.id })
      .from(t.agents)
      .where(and(eq(t.agents.workspaceId, workspaceId), eq(t.agents.name, 'Security Reviewer')));
    return pg.handle.db
      .select()
      .from(t.reviews)
      .where(and(eq(t.reviews.prId, prId), eq(t.reviews.agentId, agent!.id)));
  }

  it('has exactly one Security Reviewer review after seeding twice', async () => {
    expect(await reviews()).toHaveLength(1);
    const prs = await pg.handle.db
      .select({ id: t.pullRequests.id })
      .from(t.pullRequests)
      .where(eq(t.pullRequests.number, EVAL_DEMO_PR_NUMBER));
    expect(prs).toHaveLength(1);
  });

  it('has >= 10 findings, >= 6 accepted and >= 4 dismissed', async () => {
    const [review] = await reviews();
    const rows = await pg.handle.db.select().from(t.findings).where(eq(t.findings.reviewId, review!.id));
    expect(rows.length).toBeGreaterThanOrEqual(10);
    expect(rows.filter((f) => f.acceptedAt !== null).length).toBeGreaterThanOrEqual(6);
    expect(rows.filter((f) => f.dismissedAt !== null).length).toBeGreaterThanOrEqual(4);
    expect(rows.filter((f) => f.acceptedAt !== null && f.dismissedAt !== null)).toHaveLength(0);
  });

  it("every finding's lines lie inside a hunk of its file's stored patch", async () => {
    const [review] = await reviews();
    const rows = await pg.handle.db.select().from(t.findings).where(eq(t.findings.reviewId, review!.id));
    const files = await pg.handle.db
      .select({ path: t.prFiles.path, patch: t.prFiles.patch })
      .from(t.prFiles)
      .where(and(eq(t.prFiles.prId, prId), isNotNull(t.prFiles.patch)));
    const diff = parseUnifiedDiff(
      files
        .flatMap((f) => [`diff --git a/${f.path} b/${f.path}`, `--- a/${f.path}`, `+++ b/${f.path}`, f.patch!])
        .join('\n'),
    );
    const asFindings = rows.map(
      (r) =>
        ({
          file: r.file,
          start_line: r.startLine,
          end_line: r.endLine,
          severity: r.severity,
          category: r.category,
          title: r.title,
          rationale: r.rationale,
          confidence: r.confidence,
          kind: r.kind,
        }) as unknown as Finding,
    );
    const result = groundFindings(asFindings, diff);
    expect(result.dropped).toEqual([]);
    expect(result.kept).toHaveLength(rows.length);
  });

  it('links the review to a finished agent run', async () => {
    const [review] = await reviews();
    const [run] = await pg.handle.db.select().from(t.agentRuns).where(eq(t.agentRuns.id, review!.runId!));
    expect(run?.status).toBe('done');
  });
});
