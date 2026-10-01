import { describe, it, expect, vi } from 'vitest';
import { BlastService } from '../src/modules/blast/application/blast-service.js';
import type { MergedPrSummary } from '@devdigest/shared';
import type { BlastPull, BlastSource, PriorPrSource } from '../src/modules/blast/application/ports.js';
import type { BlastResult } from '../src/modules/blast/domain/types.js';
import { NotFoundError } from '../src/platform/errors.js';

const pull: BlastPull = { repoId: 'repo-1', number: 7, owner: 'acme', name: 'api', files: ['src/a.ts', 'src/b.ts'] };

function setup(over: { source?: Partial<BlastSource>; result?: BlastResult; history?: PriorPrSource['listMergedPullRequests'] } = {}) {
  const getBlastRadius = vi.fn(async (): Promise<BlastResult> =>
    over.result ?? {
      changedSymbols: [{ name: 'a', file: 'src/a.ts', kind: 'function' }],
      callers: [{ file: 'src/x.ts', symbol: 'x', viaSymbol: 'a', line: 3, rank: 1 }],
      factsByFile: { 'src/x.ts': { endpoints: ['GET /x'], crons: [] } },
    },
  );
  const log = { info: vi.fn(), warn: vi.fn() };
  const listMergedPullRequests = vi.fn(over.history ?? (async (): Promise<MergedPrSummary[]> => []));
  const service = new BlastService({
    source: { findPull: async () => pull, ...over.source },
    index: { getBlastRadius },
    history: { listMergedPullRequests },
  });
  return { service, getBlastRadius, listMergedPullRequests, log };
}

describe('BlastService.getBlast', () => {
  it('reads the index exactly once with the PR repo and changed files, and logs one info line', async () => {
    const { service, getBlastRadius, log } = setup();
    const out = await service.getBlast('ws-1', 'pr-1', log);
    expect(getBlastRadius).toHaveBeenCalledTimes(1);
    expect(getBlastRadius).toHaveBeenCalledWith('repo-1', ['src/a.ts', 'src/b.ts']);
    expect(out.downstream[0]!.endpoints_affected).toEqual(['GET /x']);
    expect(log.info).toHaveBeenCalledTimes(1);
    expect(log.info).toHaveBeenCalledWith(
      { repoId: 'repo-1', changedFiles: 2, degraded: false, reason: undefined, callers: 1 },
      expect.any(String),
    );
  });

  it('logs degraded and reason', async () => {
    const { service, log } = setup({
      result: { changedSymbols: [], callers: [], degraded: true, reason: 'flag_off' },
    });
    const out = await service.getBlast('ws-1', 'pr-1', log);
    expect(out.degraded).toBe(true);
    expect(log.info).toHaveBeenCalledWith(
      expect.objectContaining({ degraded: true, reason: 'flag_off', callers: 0 }),
      expect.any(String),
    );
  });

  it('throws NotFoundError for an unknown PR and never touches the index', async () => {
    const { service, getBlastRadius, log } = setup({ source: { findPull: async () => null } });
    await expect(service.getBlast('ws-1', 'missing', log)).rejects.toBeInstanceOf(NotFoundError);
    expect(getBlastRadius).not.toHaveBeenCalled();
  });
});

describe('BlastService.getHistory', () => {
  const merged: MergedPrSummary[] = [
    { number: 7, title: 'this PR', author: 'me', merged_at: '2026-01-05T00:00:00Z', files: ['src/a.ts'] },
    { number: 5, title: 'older', author: 'bob', merged_at: '2026-01-02T00:00:00Z', files: ['src/a.ts', 'src/z.ts'] },
    { number: 6, title: 'unrelated', author: 'eve', merged_at: '2026-01-04T00:00:00Z', files: ['src/z.ts'] },
  ];

  it('reads GitHub once for the repo and returns the overlapping prior PRs, excluding itself', async () => {
    const { service, listMergedPullRequests, log } = setup({ history: async () => merged });
    const out = await service.getHistory('ws-1', 'pr-1', log);
    expect(listMergedPullRequests).toHaveBeenCalledTimes(1);
    expect(listMergedPullRequests).toHaveBeenCalledWith({ owner: 'acme', name: 'api' }, { limit: 30 });
    expect(out.history).toEqual([
      { pr_number: 5, title: 'older', merged_at: '2026-01-02T00:00:00Z', author: 'bob', files_overlap: ['src/a.ts'], notes: '' },
    ]);
    expect(log.warn).not.toHaveBeenCalled();
  });

  it('any GitHub error is a warning and an empty list', async () => {
    const { service, log } = setup({
      history: async () => {
        throw new Error('GitHub token is not configured');
      },
    });
    await expect(service.getHistory('ws-1', 'pr-1', log)).resolves.toEqual({ history: [] });
    expect(log.warn).toHaveBeenCalledTimes(1);
  });

  it('a PR without stored files skips GitHub', async () => {
    const { service, listMergedPullRequests, log } = setup({ source: { findPull: async () => ({ ...pull, files: [] }) } });
    await expect(service.getHistory('ws-1', 'pr-1', log)).resolves.toEqual({ history: [] });
    expect(listMergedPullRequests).not.toHaveBeenCalled();
  });

  it('throws NotFoundError for an unknown PR', async () => {
    const { service, listMergedPullRequests, log } = setup({ source: { findPull: async () => null } });
    await expect(service.getHistory('ws-1', 'missing', log)).rejects.toBeInstanceOf(NotFoundError);
    expect(listMergedPullRequests).not.toHaveBeenCalled();
  });
});
