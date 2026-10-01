import { z } from 'zod';
import { ContextAttachments, ContextAttachmentsInput, ContextDocPreview, ContextList } from '@devdigest/shared';

/** GET /repos/:id/context. */
export { ContextList as ContextListResponse };
/** GET /repos/:id/context/doc. */
export { ContextDocPreview as ContextDocResponse };
/** GET/PUT /agents/:id/context and /skills/:id/context. */
export { ContextAttachments as ContextAttachmentsResponse };

/** `?path=` — the shape rule is the domain's (400 invalid_path), not a zod 422. */
export const DocQuery = z.object({ path: z.string().max(4096) });

/** `?repoId=` of GET /…/context. */
export const RepoQuery = z.object({ repoId: z.string().uuid() });

/**
 * PUT body: the shared loose contract, with `repo_id` a uuid so a bad id is a
 * 422 instead of a DB error. `paths` stays loose — the domain owns the
 * `invalid_path` / `duplicate_path` / `too_many_paths` codes.
 */
export const PutContextBody = ContextAttachmentsInput.extend({ repo_id: z.string().uuid() });
