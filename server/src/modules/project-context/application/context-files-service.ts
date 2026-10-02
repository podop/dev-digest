import {
  PROJECT_CONTEXT_MAX_DOC_BYTES,
  PROJECT_CONTEXT_STORE_MAX_FILES,
  PROJECT_CONTEXT_STORE_ROOT,
  type ContextDocPreview,
  type ContextFileCreateInput,
  type ContextFileRenameInput,
  type ContextFileSaveInput,
} from '@devdigest/shared';
import type { TransactionRunner } from '../../../application/transaction.js';
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  PayloadTooLargeError,
  ValidationError,
} from '../../../platform/errors.js';
import { checkPath, isListablePath } from '../domain/paths.js';
import { checkStorePath, hasNul, utf8Bytes, withSuffix } from '../domain/store-files.js';
import { storeDocPreview, usedByPath } from './doc-helpers.js';
import type { CloneDocs, ContextFileRow, ContextRepoRef, ContextStore, Logger } from './ports.js';

export interface ContextFilesDeps {
  store: ContextStore;
  /** create / rename run on a transaction handle, with the repo row locked. */
  tx: TransactionRunner<{ store: ContextStore }>;
  /** Read-only: the FR9 collision check and the read_only / not-found split. */
  docs: CloneDocs;
  /** Listable-document globs (server config): a repo document is anything they accept. */
  globs: readonly string[];
}

/** More suffixed candidates than any repo can have store files + clone collisions worth trying. */
const MAX_SUFFIX = 1000;

/**
 * Write side of the DevDigest-owned `.devdigest/specs/` store: create, save,
 * rename, delete (specs/2026-10-01-project-context-files.md §7). Every path and
 * size is validated before anything is written, and nothing here touches the
 * clone's file system except the read-only collision check.
 */
export class ContextFilesService {
  constructor(private readonly deps: ContextFilesDeps) {}

  /** POST /repos/:id/context/files */
  async create(
    workspaceId: string,
    repoId: string,
    input: ContextFileCreateInput,
    log: Logger,
  ): Promise<ContextDocPreview> {
    const repo = await this.requireRepo(workspaceId, repoId);
    const wanted = input.path ?? `${PROJECT_CONTEXT_STORE_ROOT}untitled.md`;
    const onConflict = input.path === undefined ? 'suffix' : (input.on_conflict ?? 'fail');
    if (!checkStorePath(wanted)) throw invalidPath();
    const content = input.content ?? '';
    const bytes = this.checkContent(content);

    const file = await this.deps.tx.run(async ({ store }) => {
      // The repo row lock serialises the count, the suffix pick and the insert per repo.
      if (!(await store.lockRepo(workspaceId, repoId))) throw repoNotFound();
      const taken = await store.listFiles(repoId);
      if (taken.length >= PROJECT_CONTEXT_STORE_MAX_FILES) {
        throw new ValidationError('A repository holds at most 500 files', undefined, 'too_many_files');
      }
      const inStore = new Set(taken.map((f) => f.path));
      const free = async (p: string) => !inStore.has(p) && !(await this.inClone(repo, p));
      let path = wanted;
      if (!(await free(path))) {
        if (onConflict === 'fail') throw pathExists();
        for (let n = 2; ; n++) {
          if (n > MAX_SUFFIX) throw pathExists();
          path = withSuffix(wanted, n);
          if (!checkStorePath(path)) throw invalidPath();
          if (await free(path)) break;
        }
      }
      return store.insertFile(repoId, path, content, bytes);
    });
    log.info({ repo_id: repoId, operation: 'create', path: file.path, size: file.sizeBytes, version: file.version });
    return this.preview(repoId, file);
  }

  /** PUT /repos/:id/context/files?path= */
  async save(
    workspaceId: string,
    repoId: string,
    path: string,
    input: ContextFileSaveInput,
    log: Logger,
  ): Promise<ContextDocPreview> {
    const repo = await this.requireRepo(workspaceId, repoId);
    const current = await this.deps.store.findFile(repoId, path);
    if (!current) return this.notInStore(repo, path);
    const bytes = this.checkContent(input.content);
    const saved = await this.deps.store.saveFile(repoId, path, input.content, bytes, input.base_version);
    if (!saved) return this.notSaved(repoId, path);
    log.info({ repo_id: repoId, operation: 'save', path, size: saved.sizeBytes, version: saved.version });
    return this.preview(repoId, saved);
  }

  /** POST /repos/:id/context/files/rename */
  async rename(
    workspaceId: string,
    repoId: string,
    input: ContextFileRenameInput,
    log: Logger,
  ): Promise<ContextDocPreview> {
    const repo = await this.requireRepo(workspaceId, repoId);
    const { path, new_path: newPath } = input;
    const current = await this.deps.store.findFile(repoId, path);
    if (!current) return this.notInStore(repo, path);
    if (!checkStorePath(newPath)) throw invalidPath();
    if (newPath === path) return this.preview(repoId, current); // same path: nothing to move
    if (await this.inClone(repo, newPath)) throw pathExists();

    const renamed = await this.deps.tx.run(async ({ store }) => {
      if (!(await store.lockRepo(workspaceId, repoId))) throw repoNotFound();
      if (await store.findFile(repoId, newPath)) throw pathExists();
      const moved = await store.renameFile(repoId, path, newPath, input.base_version);
      if (!moved) return null;
      await store.moveAttachments(repoId, path, newPath);
      return moved;
    });
    if (!renamed) return this.notSaved(repoId, path);
    log.info({ repo_id: repoId, operation: 'rename', path: newPath, size: renamed.sizeBytes, version: renamed.version });
    return this.preview(repoId, renamed);
  }

  /** DELETE /repos/:id/context/files?path= — attachments stay; the document turns `missing` for runs. */
  async delete(workspaceId: string, repoId: string, path: string, log: Logger): Promise<void> {
    const repo = await this.requireRepo(workspaceId, repoId);
    const current = await this.deps.store.findFile(repoId, path);
    if (!current) return this.notInStore(repo, path);
    if (!(await this.deps.store.deleteFile(repoId, path))) throw docNotFound();
    log.info({ repo_id: repoId, operation: 'delete', path, size: current.sizeBytes, version: current.version });
  }

  /** Content gate of every write: no NUL (422), at most 256 KB of UTF-8 (413). Returns its byte size. */
  private checkContent(content: string): number {
    if (hasNul(content)) throw new ValidationError('The content holds a NUL character', undefined, 'invalid_content');
    const bytes = utf8Bytes(content);
    if (bytes > PROJECT_CONTEXT_MAX_DOC_BYTES) {
      throw new PayloadTooLargeError('The file is larger than 256 KB', undefined, 'doc_too_large');
    }
    return bytes;
  }

  /** FR9: the clone already holds a file at this (store-shaped) path. Read-only; no clone → false. */
  private async inClone(repo: ContextRepoRef, path: string): Promise<boolean> {
    if (!repo.clonePath || !checkPath(path)) return false;
    return (await this.deps.docs.read(repo.clonePath, path)).status !== 'not_found';
  }

  /** The path is not a store file: a repository document is 403, anything else 404. */
  private async notInStore(repo: ContextRepoRef, path: string): Promise<never> {
    const repoDoc =
      (isListablePath(path, this.deps.globs) || checkStorePath(path)) && (await this.inClone(repo, path));
    if (repoDoc) throw new ForbiddenError('Repository files are read-only', undefined, 'read_only');
    throw docNotFound();
  }

  /** A conditional write matched no row: the version moved on (409) or the file is gone (404). */
  private async notSaved(repoId: string, path: string): Promise<never> {
    const now = await this.deps.store.findFile(repoId, path);
    if (!now) throw docNotFound();
    throw new ConflictError(
      `The file changed since you opened it (current is v${now.version})`,
      { current_version: now.version },
      'stale_version',
    );
  }

  private async preview(repoId: string, file: ContextFileRow): Promise<ContextDocPreview> {
    const usedBy = usedByPath(await this.deps.store.listUsage(repoId)).get(file.path) ?? [];
    return storeDocPreview(file, usedBy);
  }

  private async requireRepo(workspaceId: string, repoId: string): Promise<ContextRepoRef> {
    const repo = await this.deps.store.findRepo(workspaceId, repoId);
    if (!repo) throw repoNotFound();
    return repo;
  }
}

const invalidPath = () => new ValidationError('Not a valid store file path', undefined, 'invalid_path');
const pathExists = () => new ConflictError('A file already exists at this path', undefined, 'path_exists');
const docNotFound = () => new NotFoundError('Document not found', undefined, 'doc_not_found');
const repoNotFound = () => new NotFoundError('Repository not found', undefined, 'repo_not_found');
