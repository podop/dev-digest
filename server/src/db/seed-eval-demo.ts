import { and, eq } from 'drizzle-orm';
import type { Db } from './client.js';
import * as t from './schema.js';

/**
 * Demo data for the eval pipeline (specs/eval-pipeline.md FR26): a second PR on
 * the demo repo, reviewed by the Security Reviewer, with a realistic mix of
 * real issues (accepted) and noise (dismissed) so "Turn into eval case" has
 * both kinds of decided findings to work with.
 *
 * The files are new-file hunks stored in pr_files.patch (the repo is never
 * cloned). Every finding locates its line with `at` — a substring of the added
 * line — so its range always lands inside the stored hunk; the seed throws if
 * an anchor is missing. Idempotent: keyed on the PR number, all-or-nothing in
 * one transaction.
 */

export const EVAL_DEMO_PR_NUMBER = 483;
const REPO_FULL_NAME = 'acme/payments-api';
const SECURITY_AGENT_NAME = 'Security Reviewer';
const DEMO_MODEL = 'seed-eval-demo';

const EXPORT_LINES = [
  "import type { FastifyInstance } from 'fastify';",
  "import { exec } from 'node:child_process';",
  "import { sql } from 'drizzle-orm';",
  "import { db } from '../../db';",
  '',
  'export async function adminExportRoutes(app: FastifyInstance) {',
  "  app.get('/admin/export', async (req, reply) => {",
  '    const { table, format, filter } = req.query as Record<string, string>;',
  `    const rows = await db.execute(sql.raw(\`SELECT * FROM \${table} WHERE \${filter ?? '1=1'}\`));`,
  `    const file = \`/tmp/export-\${table}.\${format}\`;`,
  `    exec(\`node scripts/dump.js \${file} --format \${format}\`, (err) => {`,
  '      if (err) console.error(err);',
  '    });',
  "    reply.header('Access-Control-Allow-Origin', '*');",
  '    return { rows, file };',
  '  });',
  '',
  "  app.get('/admin/export/download', async (req, reply) => {",
  '    const { name } = req.query as { name: string };',
  `    return reply.sendFile(\`../exports/\${name}\`);`,
  '  });',
  '}',
];

const STRIPE_LINES = [
  "import crypto from 'node:crypto';",
  "import type { FastifyRequest, FastifyReply } from 'fastify';",
  "import { config } from '../config';",
  "import { markInvoicePaid } from '../billing/invoices';",
  '',
  'export async function handleStripeEvent(req: FastifyRequest, reply: FastifyReply) {',
  "  const signature = req.headers['stripe-signature'] as string;",
  '  const payload = JSON.stringify(req.body);',
  "  const expected = crypto.createHmac('sha256', config.webhookSecret).update(payload).digest('hex');",
  '  if (signature === expected) {',
  '    await markInvoicePaid(req.body.data.object.id);',
  '  }',
  '  return reply.code(200).send({ received: true });',
  '}',
];

const SESSION_LINES = [
  "import jwt from 'jsonwebtoken';",
  "import { config } from '../config';",
  '',
  'export function createSession(userId: string, role: string) {',
  "  return jwt.sign({ sub: userId, role }, config.jwtSecret ?? 'dev-secret', { expiresIn: '30d' });",
  '}',
  '',
  'export function readSession(token: string) {',
  '  return jwt.decode(token) as { sub: string; role: string } | null;',
  '}',
];

const INVOICES_LINES = [
  "import { eq } from 'drizzle-orm';",
  "import { db } from '../db';",
  "import { invoices } from '../db/schema';",
  '',
  'export async function markInvoicePaid(id: string) {',
  `  console.log(\`marking invoice \${id} paid\`);`,
  `  const receipt = \`rcpt_\${Math.random().toString(36).slice(2)}\`;`,
  "  await db.update(invoices).set({ status: 'paid', receipt }).where(eq(invoices.id, id));",
  '}',
];

const DEMO_FILES_LINES: Record<string, string[]> = {
  'src/api/admin/export.ts': EXPORT_LINES,
  'src/webhooks/stripe.ts': STRIPE_LINES,
  'src/auth/session.ts': SESSION_LINES,
  'src/billing/invoices.ts': INVOICES_LINES,
};

/** path → unified-diff hunk (a brand-new file, so every line is an added line). */
export const SEED_EVAL_DEMO_PATCHES: Record<string, string> = Object.fromEntries(
  Object.entries(DEMO_FILES_LINES).map(([path, lines]) => [
    path,
    [`@@ -0,0 +1,${lines.length} @@`, ...lines.map((l) => `+${l}`)].join('\n'),
  ]),
);

type Fate = 'accepted' | 'dismissed' | 'pending';

interface DemoFinding {
  file: string;
  /** Substring of the added line the finding points at (first match wins). */
  at: string;
  severity: (typeof t.findings.$inferInsert)['severity'];
  category: (typeof t.findings.$inferInsert)['category'];
  title: string;
  rationale: string;
  suggestion: string;
  confidence: number;
  fate: Fate;
}

const EXPORT = 'src/api/admin/export.ts';
const STRIPE = 'src/webhooks/stripe.ts';
const SESSION = 'src/auth/session.ts';
const INVOICES = 'src/billing/invoices.ts';

const DEMO_FINDINGS: DemoFinding[] = [
  {
    file: EXPORT,
    at: 'sql.raw(',
    severity: 'CRITICAL',
    category: 'security',
    title: 'SQL injection through table and filter query parameters',
    rationale:
      '`table` and `filter` come straight from the query string and are interpolated into a raw SQL string, so any caller can read or modify arbitrary tables.',
    suggestion: 'Allow-list the table name and pass the filter as bound parameters instead of `sql.raw`.',
    confidence: 0.97,
    fate: 'accepted',
  },
  {
    file: EXPORT,
    at: 'exec(`node scripts/dump.js',
    severity: 'CRITICAL',
    category: 'security',
    title: 'Command injection in export shell command',
    rationale:
      '`file` and `format` are user-controlled and concatenated into a shell command passed to `exec`, which allows arbitrary command execution on the API host.',
    suggestion: 'Use `execFile` with an argument array and validate `format` against a fixed list.',
    confidence: 0.96,
    fate: 'accepted',
  },
  {
    file: EXPORT,
    at: 'sendFile(`../exports/',
    severity: 'CRITICAL',
    category: 'security',
    title: 'Path traversal in export download',
    rationale: '`name` is joined into a relative path without normalisation, so `../../etc/passwd` escapes the exports directory.',
    suggestion: 'Resolve the path and reject anything outside the exports directory, or serve by an opaque id.',
    confidence: 0.94,
    fate: 'accepted',
  },
  {
    file: EXPORT,
    at: "app.get('/admin/export', async",
    severity: 'CRITICAL',
    category: 'security',
    title: 'Admin export endpoints have no authentication',
    rationale: 'Neither /admin/export route registers an auth or role check, so any unauthenticated client can dump data.',
    suggestion: 'Register the routes behind the admin auth hook and require the admin role.',
    confidence: 0.91,
    fate: 'accepted',
  },
  {
    file: EXPORT,
    at: 'Access-Control-Allow-Origin',
    severity: 'WARNING',
    category: 'security',
    title: 'Wildcard CORS on an admin endpoint',
    rationale: 'Allowing every origin on a data-export route lets any web page read the response from a logged-in admin browser.',
    suggestion: 'Drop the header or restrict it to the admin app origin.',
    confidence: 0.82,
    fate: 'accepted',
  },
  {
    file: STRIPE,
    at: 'signature === expected',
    severity: 'WARNING',
    category: 'security',
    title: 'Webhook signature compared with a non-constant-time check',
    rationale: 'A plain string comparison of the HMAC leaks timing information that can help forge a valid signature.',
    suggestion: 'Compare with `crypto.timingSafeEqual` on equal-length buffers.',
    confidence: 0.85,
    fate: 'accepted',
  },
  {
    file: SESSION,
    at: "?? 'dev-secret'",
    severity: 'CRITICAL',
    category: 'security',
    title: 'JWT signed with a hardcoded fallback secret',
    rationale: 'When `jwtSecret` is unset the token is signed with a guessable constant, so anyone can mint valid sessions.',
    suggestion: 'Fail fast at startup when the secret is missing; never fall back to a literal.',
    confidence: 0.95,
    fate: 'accepted',
  },
  {
    file: SESSION,
    at: 'jwt.decode(token)',
    severity: 'CRITICAL',
    category: 'security',
    title: 'Session token read with decode instead of verify',
    rationale: '`jwt.decode` does not check the signature or expiry, so a forged token is accepted as a valid session.',
    suggestion: 'Use `jwt.verify` with the server secret and the expected algorithm.',
    confidence: 0.96,
    fate: 'accepted',
  },
  {
    file: STRIPE,
    at: 'markInvoicePaid(req.body',
    severity: 'WARNING',
    category: 'security',
    title: 'No replay protection on Stripe events',
    rationale: 'The handler ignores the event timestamp and id, so a captured webhook can be replayed to mark an invoice paid again.',
    suggestion: 'Reject events older than a few minutes and store processed event ids.',
    confidence: 0.7,
    fate: 'pending',
  },
  {
    file: EXPORT,
    at: 'if (err) console.error(err)',
    severity: 'SUGGESTION',
    category: 'security',
    title: 'Error object logged to the console',
    rationale: 'Logging the raw error could expose internal paths in logs.',
    suggestion: 'Use the structured logger and log only the message.',
    confidence: 0.35,
    fate: 'dismissed',
  },
  {
    file: EXPORT,
    at: 'const file = `/tmp/export-',
    severity: 'SUGGESTION',
    category: 'security',
    title: 'Predictable temporary file name',
    rationale: 'The export file name is derived from the table name, so another local user could pre-create it.',
    suggestion: 'Create the file with `mkdtemp` or a random suffix.',
    confidence: 0.42,
    fate: 'dismissed',
  },
  {
    file: SESSION,
    at: "expiresIn: '30d'",
    severity: 'SUGGESTION',
    category: 'security',
    title: 'Session lifetime of 30 days is long',
    rationale: 'A long-lived token stays valid after a role change or logout.',
    suggestion: 'Shorten the lifetime and add a refresh flow.',
    confidence: 0.4,
    fate: 'dismissed',
  },
  {
    file: INVOICES,
    at: 'Math.random()',
    severity: 'WARNING',
    category: 'security',
    title: 'Insecure random number generator for receipt id',
    rationale: '`Math.random` is not cryptographically secure, so receipt ids may be guessable.',
    suggestion: 'Use `crypto.randomUUID()`.',
    confidence: 0.5,
    fate: 'dismissed',
  },
  {
    file: INVOICES,
    at: 'console.log(`marking invoice',
    severity: 'SUGGESTION',
    category: 'security',
    title: 'Invoice id written to logs',
    rationale: 'Identifiers in logs can aid enumeration if logs are exposed.',
    suggestion: 'Drop the log line or move it to debug level.',
    confidence: 0.3,
    fate: 'dismissed',
  },
];

/** 1-based line of the first added line containing `at` — throws on a stale anchor. */
function lineOf(file: string, at: string): number {
  const idx = (DEMO_FILES_LINES[file] ?? []).findIndex((l) => l.includes(at));
  if (idx < 0) throw new Error(`seed-eval-demo: anchor "${at}" not found in ${file}`);
  return idx + 1;
}

function countAdditions(): number {
  return Object.values(DEMO_FILES_LINES).reduce((n, lines) => n + lines.length, 0);
}

/**
 * Seed the demo PR + its Security Reviewer review. No-op once PR #483 exists
 * (a re-seed adds nothing), or when the demo repo / Security Reviewer is absent.
 */
export async function seedEvalDemo(db: Db, workspaceId: string): Promise<void> {
  const [repo] = await db
    .select({ id: t.repos.id })
    .from(t.repos)
    .where(and(eq(t.repos.workspaceId, workspaceId), eq(t.repos.fullName, REPO_FULL_NAME)));
  const [agent] = await db
    .select()
    .from(t.agents)
    .where(and(eq(t.agents.workspaceId, workspaceId), eq(t.agents.name, SECURITY_AGENT_NAME)));
  if (!repo || !agent) return;

  const [existing] = await db
    .select({ id: t.pullRequests.id })
    .from(t.pullRequests)
    .where(and(eq(t.pullRequests.repoId, repo.id), eq(t.pullRequests.number, EVAL_DEMO_PR_NUMBER)));
  if (existing) return;

  const now = new Date();

  await db.transaction(async (tx) => {
    const [pr] = await tx
      .insert(t.pullRequests)
      .values({
        workspaceId,
        repoId: repo.id,
        number: EVAL_DEMO_PR_NUMBER,
        title: 'Add admin data export and Stripe webhook verification',
        author: 'dev.rivera',
        branch: 'feat/admin-export',
        base: 'main',
        headSha: 'c3d4e5f6a7b8',
        additions: countAdditions(),
        deletions: 0,
        filesCount: Object.keys(DEMO_FILES_LINES).length,
        status: 'needs_review',
        body: 'Adds an admin CSV/JSON export, verifies Stripe webhook signatures and issues session tokens for the admin app.',
      })
      .returning({ id: t.pullRequests.id });

    await tx.insert(t.prFiles).values(
      Object.entries(DEMO_FILES_LINES).map(([path, lines]) => ({
        prId: pr!.id,
        path,
        additions: lines.length,
        deletions: 0,
        patch: SEED_EVAL_DEMO_PATCHES[path] ?? null,
      })),
    );
    await tx.insert(t.prCommits).values({
      prId: pr!.id,
      sha: 'c3d4e5f6a7b8',
      message: 'Add admin export, Stripe webhook handler and session tokens',
      author: 'dev.rivera',
    });

    const [run] = await tx
      .insert(t.agentRuns)
      .values({
        workspaceId,
        agentId: agent.id,
        prId: pr!.id,
        ranAt: now,
        provider: agent.provider,
        model: agent.model,
        durationMs: 21_350,
        tokensIn: 5_870,
        tokensOut: 1_460,
        costUsd: 0.002412,
        status: 'done',
        source: 'local',
        findingsCount: DEMO_FINDINGS.length,
        grounding: `${DEMO_FINDINGS.length}/${DEMO_FINDINGS.length} passed`,
        score: 34,
        blockers: DEMO_FINDINGS.filter((f) => f.severity === 'CRITICAL').length,
      })
      .returning({ id: t.agentRuns.id });

    const [review] = await tx
      .insert(t.reviews)
      .values({
        workspaceId,
        prId: pr!.id,
        agentId: agent.id,
        runId: run!.id,
        kind: 'review',
        verdict: 'request_changes',
        summary:
          'Several exploitable issues: injection and missing auth on the admin export, and unverified JWT handling. A few lower-confidence notes are style-level.',
        score: 34,
        model: DEMO_MODEL,
        createdAt: now,
      })
      .returning({ id: t.reviews.id });

    await tx.insert(t.findings).values(
      DEMO_FINDINGS.map((f) => {
        const line = lineOf(f.file, f.at);
        return {
          reviewId: review!.id,
          file: f.file,
          startLine: line,
          endLine: line,
          severity: f.severity,
          category: f.category,
          title: f.title,
          rationale: f.rationale,
          suggestion: f.suggestion,
          confidence: f.confidence,
          acceptedAt: f.fate === 'accepted' ? now : null,
          dismissedAt: f.fate === 'dismissed' ? now : null,
        };
      }),
    );
  });
}
