import { z } from 'zod';
import {
  ContextAttachments,
  ContextAttachmentsInput,
  ContextDocPreview,
  ContextFileCreateInput,
  ContextFileRenameInput,
  ContextFileSaveInput,
  ContextList,
} from '@devdigest/shared';

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

/** POST /repos/:id/context/files — the body is optional (a bare POST creates `untitled.md`). */
export const CreateFileBody = z.preprocess((v) => v ?? {}, ContextFileCreateInput);
/** PUT /repos/:id/context/files?path=. */
export const SaveFileBody = ContextFileSaveInput;
/** POST /repos/:id/context/files/rename. */
export const RenameFileBody = ContextFileRenameInput;
/** `?path=` of PUT / DELETE …/files — the store-path shape rule is the domain's, not a zod 422. */
export const FileQuery = DocQuery;

/** Largest request: 256 KB of text escaped in JSON can reach ~6x (\u00XX); 2 MiB covers it with room. */
export const FILE_BODY_LIMIT = 2 * 1024 * 1024;
