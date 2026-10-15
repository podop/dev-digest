import {
  pgTable,
  uuid,
  text,
  integer,
  boolean,
  jsonb,
  timestamp,
  doublePrecision,
  numeric,
  index,
  uniqueIndex,
  check,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { enumCheck, now } from './_shared';
import { workspaces } from './core';
import { pullRequests } from './pulls';
import { agents } from './agents';
import { skills } from './skills';

// ============================================================ Eval / Conformance / Compose

export const EVAL_OWNER_KINDS = ['skill', 'agent'] as const;
/** Status of one execution of an agent's case set (`eval_suite_runs`). */
export const EVAL_SUITE_RUN_STATUSES = ['running', 'completed', 'failed'] as const;
/** Per-case outcome (`eval_runs.status`). */
export const EVAL_RUN_STATUSES = ['passed', 'failed', 'error'] as const;

/** Config snapshot taken at suite-run start (agent version row may not exist — seeded agents). */
export interface EvalRunConfigSnapshot {
  provider: string;
  model: string;
  system_prompt: string;
  strategy: string;
  skills: Array<{ id: string; name: string; description: string; body: string; version: number }>;
}

export const evalCases = pgTable(
  'eval_cases',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    ownerKind: text('owner_kind', { enum: EVAL_OWNER_KINDS }).notNull(),
    ownerId: uuid('owner_id').notNull(),
    name: text('name').notNull(),
    inputDiff: text('input_diff'),
    inputFiles: jsonb('input_files'),
    inputMeta: jsonb('input_meta'),
    expectedOutput: jsonb('expected_output'),
    notes: text('notes'),
    createdAt: now(),
    // Source of an agent case created from a finding. Deliberately no FKs: the case is a
    // snapshot and must survive deletion of its finding / review / PR.
    sourceFindingId: uuid('source_finding_id'),
    sourceReviewId: uuid('source_review_id'),
    sourcePrId: uuid('source_pr_id'),
    /** Set at the first edit that changes the case's content; null = never edited. */
    contentEditedAt: timestamp('content_edited_at', { withTimezone: true }),
  },
  (t) => [
    enumCheck('eval_cases_owner_kind_chk', t.ownerKind, EVAL_OWNER_KINDS),
    // One case per finding (NULLs — skill cases, legacy rows — stay unconstrained).
    uniqueIndex('eval_cases_source_finding_uq').on(t.sourceFindingId),
    index('eval_cases_owner_created_idx').on(t.ownerKind, t.ownerId, t.createdAt),
  ],
);

/**
 * One execution of an owner's whole case set; per-case results live in `eval_runs`.
 * `owner_kind = 'agent'`: the agent's cases. `'skill'`: the skill's cases, run on the host
 * agent `agent_id` with only that skill attached (`skill_id` / `skill_version`).
 */
export const evalSuiteRuns = pgTable(
  'eval_suite_runs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    agentId: uuid('agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),
    agentVersion: integer('agent_version').notNull(),
    /** Agent name frozen at run start (the host agent's, for a skill run). */
    agentName: text('agent_name').notNull().default(''),
    ownerKind: text('owner_kind', { enum: EVAL_OWNER_KINDS }).notNull().default('agent'),
    skillId: uuid('skill_id').references(() => skills.id, { onDelete: 'cascade' }),
    skillVersion: integer('skill_version'),
    config: jsonb('config').$type<EvalRunConfigSnapshot>().notNull(),
    caseIds: jsonb('case_ids').$type<string[]>().notNull(),
    status: text('status', { enum: EVAL_SUITE_RUN_STATUSES }).notNull().default('running'),
    startedAt: timestamp('started_at', { withTimezone: true }).defaultNow().notNull(),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    casesTotal: integer('cases_total').notNull().default(0),
    casesFinished: integer('cases_finished').notNull().default(0),
    casesPassed: integer('cases_passed').notNull().default(0),
    casesErrored: integer('cases_errored').notNull().default(0),
    recall: doublePrecision('recall'),
    precision: doublePrecision('precision'),
    citationAccuracy: doublePrecision('citation_accuracy'),
    unlabeledFindings: integer('unlabeled_findings').notNull().default(0),
    /** USD — exact decimal (money), read back as a JS number. */
    costUsd: numeric('cost_usd', { precision: 12, scale: 6, mode: 'number' }),
    durationMs: integer('duration_ms'),
    error: text('error'),
  },
  (t) => [
    // At most one running suite run per owner (a second start → 409 eval_run_active).
    uniqueIndex('eval_suite_runs_one_running_agent_uq')
      .on(t.agentId)
      .where(sql`${t.status} = 'running' and ${t.ownerKind} = 'agent'`),
    uniqueIndex('eval_suite_runs_one_running_skill_uq')
      .on(t.skillId)
      .where(sql`${t.status} = 'running' and ${t.ownerKind} = 'skill'`),
    index('eval_suite_runs_agent_started_idx').on(t.agentId, t.startedAt),
    index('eval_suite_runs_skill_started_idx').on(t.skillId, t.startedAt),
    enumCheck('eval_suite_runs_owner_kind_chk', t.ownerKind, EVAL_OWNER_KINDS),
    // A skill run names its skill; an agent run has none.
    check(
      'eval_suite_runs_owner_consistency_chk',
      sql`(${t.ownerKind} = 'agent' and ${t.skillId} is null) or (${t.ownerKind} = 'skill' and ${t.skillId} is not null)`,
    ),
    index('eval_suite_runs_ws_started_idx').on(t.workspaceId, t.startedAt),
    enumCheck('eval_suite_runs_status_chk', t.status, EVAL_SUITE_RUN_STATUSES),
  ],
);

export const evalRuns = pgTable(
  'eval_runs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    caseId: uuid('case_id')
      .notNull()
      .references(() => evalCases.id, { onDelete: 'cascade' }),
    ranAt: timestamp('ran_at', { withTimezone: true }).defaultNow().notNull(),
    actualOutput: jsonb('actual_output'),
    pass: boolean('pass'),
    recall: doublePrecision('recall'),
    precision: doublePrecision('precision'),
    citationAccuracy: doublePrecision('citation_accuracy'),
    durationMs: integer('duration_ms'),
    /** USD — exact decimal (money), read back as a JS number. */
    costUsd: numeric('cost_usd', { precision: 12, scale: 6, mode: 'number' }),
    // Suite-run link + per-case outcome. Nullable: legacy single-case rows predate them.
    runId: uuid('run_id').references(() => evalSuiteRuns.id, { onDelete: 'cascade' }),
    status: text('status', { enum: EVAL_RUN_STATUSES }),
    error: text('error'),
    droppedCount: integer('dropped_count').notNull().default(0),
    hitCount: integer('hit_count').notNull().default(0),
    violationCount: integer('violation_count').notNull().default(0),
    unlabeledCount: integer('unlabeled_count').notNull().default(0),
  },
  (t) => [
    index('eval_runs_case_idx').on(t.caseId),
    // One result per case per suite run (NULL run_id — legacy rows — unconstrained).
    uniqueIndex('eval_runs_run_case_uq').on(t.runId, t.caseId),
    enumCheck('eval_runs_status_chk', t.status, EVAL_RUN_STATUSES),
  ],
);

export const conformanceChecks = pgTable('conformance_checks', {
  id: uuid('id').primaryKey().defaultRandom(),
  prId: uuid('pr_id')
    .notNull()
    .references(() => pullRequests.id, { onDelete: 'cascade' }),
  specId: text('spec_id').notNull(),
  completenessPct: doublePrecision('completeness_pct'),
  items: jsonb('items'),
});

export const composedReviews = pgTable('composed_reviews', {
  id: uuid('id').primaryKey().defaultRandom(),
  prId: uuid('pr_id')
    .notNull()
    .references(() => pullRequests.id, { onDelete: 'cascade' }),
  body: text('body').notNull(),
  verdict: text('verdict'),
  postedAt: timestamp('posted_at', { withTimezone: true }),
  githubReviewId: text('github_review_id'),
});
