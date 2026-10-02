import { sql } from 'drizzle-orm';
import {
  pgTable,
  uuid,
  text,
  integer,
  timestamp,
  primaryKey,
  index,
  check,
  unique,
} from 'drizzle-orm/pg-core';
import { now } from './_shared';
import { repos } from './repos';
import { agents } from './agents';
import { skills } from './skills';

// ====================================================== Project Context
// Per-repo, ordered attachments of repo markdown docs to an agent or a skill.
// Not part of agent/skill version snapshots. Documents are never stored: only
// the repo-relative path (read from the clone / the PR base commit on demand).
// No workspace_id: owner and repo both cascade, like agent_skills.

export const agentContextDocs = pgTable(
  'agent_context_docs',
  {
    agentId: uuid('agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),
    repoId: uuid('repo_id')
      .notNull()
      .references(() => repos.id, { onDelete: 'cascade' }),
    path: text('path').notNull(),
    position: integer('position').notNull(),
    createdAt: now(),
  },
  (t) => [
    primaryKey({ columns: [t.agentId, t.repoId, t.path] }),
    // PK leads with agent_id; the repo FK (cascade, "docs of repo X") needs this.
    index('agent_context_docs_repo_idx').on(t.repoId),
    check('agent_context_docs_path_len_chk', sql`length(${t.path}) BETWEEN 1 AND 512`),
  ],
);

export const skillContextDocs = pgTable(
  'skill_context_docs',
  {
    skillId: uuid('skill_id')
      .notNull()
      .references(() => skills.id, { onDelete: 'cascade' }),
    repoId: uuid('repo_id')
      .notNull()
      .references(() => repos.id, { onDelete: 'cascade' }),
    path: text('path').notNull(),
    position: integer('position').notNull(),
    createdAt: now(),
  },
  (t) => [
    primaryKey({ columns: [t.skillId, t.repoId, t.path] }),
    index('skill_context_docs_repo_idx').on(t.repoId),
    check('skill_context_docs_path_len_chk', sql`length(${t.path}) BETWEEN 1 AND 512`),
  ],
);

// DevDigest-owned markdown files under `.devdigest/specs/`, per repo. The text
// lives here (never in the clone). `version` starts at 1 and is bumped on every
// content save or rename; deleted with the repo. Attachments reference `path`.
export const contextFiles = pgTable(
  'context_files',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    repoId: uuid('repo_id')
      .notNull()
      .references(() => repos.id, { onDelete: 'cascade' }),
    path: text('path').notNull(),
    content: text('content').notNull(),
    sizeBytes: integer('size_bytes').notNull(),
    version: integer('version').notNull().default(1),
    createdAt: now(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    // The unique constraint's index leads with repo_id, so it also serves the repo FK.
    unique('context_files_repo_path_uq').on(t.repoId, t.path),
    check('context_files_path_len_chk', sql`length(${t.path}) BETWEEN 1 AND 512`),
  ],
);
