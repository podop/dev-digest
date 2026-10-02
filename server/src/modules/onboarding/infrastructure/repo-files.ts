/**
 * RepoFiles over the container's git client: files are read at the INDEXED commit
 * (`git show`, never the working tree), one process per read, so reads run with
 * bounded concurrency. `readFileAt` throws on a missing or oversize object; that
 * is a normal outcome here (most repos lack a compose file), reported as `null`.
 */
import type { GitClient } from '@devdigest/shared';
import type { RepoFiles } from '../application/ports.js';
import { FILE_FETCH_MAX_BYTES, READ_CONCURRENCY } from '../domain/constants.js';

export type OnboardingGit = Pick<GitClient, 'readFileAt'>;

export class GitRepoFiles implements RepoFiles {
  constructor(private readonly git: OnboardingGit) {}

  async readMany(
    repo: { owner: string; name: string },
    sha: string,
    paths: readonly string[],
    signal?: AbortSignal,
  ): Promise<(string | null)[]> {
    const out = new Array<string | null>(paths.length).fill(null);
    let next = 0;
    const worker = async () => {
      for (let i = next++; i < paths.length; i = next++) {
        if (signal?.aborted) return;
        out[i] = await this.readOne(repo, sha, paths[i] as string);
      }
    };
    await Promise.all(Array.from({ length: Math.min(READ_CONCURRENCY, paths.length) }, worker));
    return out;
  }

  private async readOne(repo: { owner: string; name: string }, sha: string, path: string): Promise<string | null> {
    try {
      const file = await this.git.readFileAt({ owner: repo.owner, name: repo.name }, sha, path, {
        maxBytes: FILE_FETCH_MAX_BYTES,
      });
      return file.content;
    } catch {
      return null;
    }
  }
}
