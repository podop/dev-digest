import type { ProjectContextDocStatus, ProjectContextOrigin } from '@devdigest/shared';

/** What one attachment-path check found; `ok` carries no data. */
export type PathCheckCode = 'invalid_path' | 'duplicate_path' | 'too_many_paths';

export type AttachmentValidation = { ok: true } | { ok: false; code: PathCheckCode };

/** The attached paths of one skill that is linked to the running agent. */
export interface SkillAttachmentSet {
  skillId: string;
  skillName: string;
  /** A disabled skill contributes nothing (EC10). */
  enabled: boolean;
  paths: readonly string[];
}

/** One document of a run, before it is read: where it came from. */
export interface RunDocRef {
  path: string;
  origin: ProjectContextOrigin;
}

/** Result of reading one document at the PR base commit. */
export type ReadOutcome =
  | { status: 'ok'; text: string }
  | { status: 'missing' | 'too_large' | 'unreadable' };

/** One document of a run's project context, in prompt order (trace record). */
export interface RunDoc {
  path: string;
  doc_type: string;
  origin: ProjectContextOrigin;
  tokens: number;
  status: ProjectContextDocStatus;
  /** The text as sent — only for `included` documents. */
  text?: string;
}
