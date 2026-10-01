/**
 * blast use case (server/specs/07-blast-radius.md): the PR's changed files →
 * ONE read of the repo-intel index → the `BlastRadius` contract. Reads only:
 * nothing is re-indexed and no model is called.
 */
import type { BlastRadius, PrHistory } from '@devdigest/shared';
import { NotFoundError } from '../../../platform/errors.js';
import { buildBlastRadius } from '../domain/blast-radius.js';
import { HISTORY_SCAN_LIMIT } from '../domain/constants.js';
import { selectPriorPrs } from '../domain/history.js';
import type { BlastIndexReader, BlastSource, Logger, PriorPrSource } from './ports.js';

export interface BlastServiceDeps {
  source: BlastSource;
  index: BlastIndexReader;
  history: PriorPrSource;
}

export class BlastService {
  constructor(private readonly deps: BlastServiceDeps) {}

  /** GET /pulls/:id/blast. */
  async getBlast(workspaceId: string, prId: string, log: Logger): Promise<BlastRadius> {
    const pull = await this.deps.source.findPull(workspaceId, prId);
    if (!pull) throw new NotFoundError('Pull request not found');
    const result = await this.deps.index.getBlastRadius(pull.repoId, pull.files);
    const blast = buildBlastRadius(result);
    log.info(
      {
        repoId: pull.repoId,
        changedFiles: pull.files.length,
        degraded: blast.degraded ?? false,
        reason: blast.reason,
        callers: result.callers.length,
      },
      'blast radius read from index',
    );
    return blast;
  }

  /**
   * GET /pulls/:id/history — prior merged PRs touching this PR's files, from
   * GitHub. Best effort: no token, a GitHub error or a timeout is a warning and
   * an empty list, never a failed request.
   */
  async getHistory(workspaceId: string, prId: string, log: Logger): Promise<PrHistory> {
    const pull = await this.deps.source.findPull(workspaceId, prId);
    if (!pull) throw new NotFoundError('Pull request not found');
    if (pull.files.length === 0) return { history: [] };
    try {
      const merged = await this.deps.history.listMergedPullRequests(
        { owner: pull.owner, name: pull.name },
        { limit: HISTORY_SCAN_LIMIT },
      );
      return { history: selectPriorPrs(merged, { number: pull.number, files: pull.files }) };
    } catch (err) {
      log.warn({ err, repoId: pull.repoId }, 'prior PR history unavailable; returning an empty list');
      return { history: [] };
    }
  }
}
