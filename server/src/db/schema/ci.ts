import { pgTable, uuid, text, integer, timestamp, numeric, bigint, unique } from 'drizzle-orm/pg-core';
import { enumCheck } from './_shared';
import { agents } from './agents';
import { agentRuns } from './runs';

export const CI_TARGET_TYPES = ['gha', 'circle', 'jenkins', 'cli'] as const;

export const ciInstallations = pgTable(
  'ci_installations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    agentId: uuid('agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),
    repo: text('repo').notNull(),
    targetType: text('target_type', { enum: CI_TARGET_TYPES }).notNull(),
    installedAt: timestamp('installed_at', { withTimezone: true }).defaultNow().notNull(),
    /** Agent slug fixed at first export: names the manifest, workflow, check and artifact. */
    slug: text('slug'),
    /** Agent version deployed by the last export ("outdated" when the agent is newer). */
    manifestVersion: integer('manifest_version'),
  },
  (t) => [
    enumCheck('ci_installations_target_type_chk', t.targetType, CI_TARGET_TYPES),
    unique('ci_installations_agent_repo_target_uq').on(t.agentId, t.repo, t.targetType),
    unique('ci_installations_repo_slug_uq').on(t.repo, t.slug),
  ],
);

export const ciRuns = pgTable('ci_runs', {
  id: uuid('id').primaryKey().defaultRandom(),
  ciInstallationId: uuid('ci_installation_id').references(() => ciInstallations.id, {
    onDelete: 'set null',
  }),
  prNumber: integer('pr_number'),
  ranAt: timestamp('ran_at', { withTimezone: true }),
  status: text('status'),
  findingsCount: integer('findings_count'),
  /** USD — exact decimal (money), read back as a JS number. */
  costUsd: numeric('cost_usd', { precision: 12, scale: 6, mode: 'number' }),
  githubUrl: text('github_url'),
  source: text('source'),
  /** The agent_runs row (source='ci') this ingest wrote. */
  agentRunId: uuid('agent_run_id').references(() => agentRuns.id, { onDelete: 'set null' }),
  /** GitHub workflow run id + attempt: the idempotency key of the pull-based ingest. */
  githubRunId: bigint('github_run_id', { mode: 'number' }),
  runAttempt: integer('run_attempt'),
  headSha: text('head_sha'),
  manifestVersion: integer('manifest_version'),
}, (t) => [unique('ci_runs_github_run_attempt_uq').on(t.githubRunId, t.runAttempt)]);
