/**
 * Onboarding infrastructure without Docker: the git file reader (missing/oversize →
 * null, bounded concurrency), the LLM adapter's error mapping, the repo-intel
 * `listIndexedFiles` facade read and the repository's safeParse-on-read.
 */
import { describe, it, expect, vi } from 'vitest';
import type { LLMProvider, StructuredRequest } from '@devdigest/shared';
import type { DbOrTx } from '../src/db/client.js';
import { ConfigError, ExternalServiceError, ValidationError } from '../src/platform/errors.js';
import { FILE_FETCH_MAX_BYTES, LLM_MAX_RETRIES, ONBOARDING_SCHEMA_NAME, READ_CONCURRENCY } from '../src/modules/onboarding/domain/constants.js';
import { LlmOnboardingModel } from '../src/modules/onboarding/infrastructure/llm-model.js';
import { OnboardingRepository } from '../src/modules/onboarding/infrastructure/repository.js';
import { GitRepoFiles } from '../src/modules/onboarding/infrastructure/repo-files.js';
import type { RepoIntelDeps } from '../src/modules/repo-intel/application/ports.js';
import { RepoIntelService } from '../src/modules/repo-intel/service.js';

const REPO = { owner: 'o', name: 'n' };
const rejects = async (p: Promise<unknown>) => p.then(() => null, (e: unknown) => e);

describe('GitRepoFiles', () => {
  it('reads at the sha with the size cap; a missing or oversize file is null', async () => {
    const readFileAt = vi.fn(async (_r: unknown, _sha: string, path: string) => {
      if (path === 'big.md') throw new Error('too large');
      if (path === 'gone.md') throw new Error('not found');
      return { path, content: `text of ${path}`, size: 1 };
    });
    const files = new GitRepoFiles({ readFileAt });
    const out = await files.readMany(REPO, 'abc123', ['README.md', 'gone.md', 'big.md']);
    expect(out).toEqual(['text of README.md', null, null]);
    expect(readFileAt).toHaveBeenCalledWith(REPO, 'abc123', 'README.md', { maxBytes: FILE_FETCH_MAX_BYTES });
  });

  it('never has more than READ_CONCURRENCY reads in flight and keeps the order', async () => {
    let inFlight = 0;
    let peak = 0;
    const readFileAt = vi.fn(async (_r: unknown, _sha: string, path: string) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 1));
      inFlight--;
      return { path, content: path, size: 1 };
    });
    const paths = Array.from({ length: 40 }, (_, i) => `f${i}.ts`);
    const out = await new GitRepoFiles({ readFileAt }).readMany(REPO, 'abc', paths);
    expect(out).toEqual(paths);
    expect(peak).toBe(READ_CONCURRENCY);
  });

  it('an aborted signal stops further reads (rest stay null)', async () => {
    const readFileAt = vi.fn(async (_r: unknown, _sha: string, path: string) => ({ path, content: path, size: 1 }));
    const ctl = new AbortController();
    ctl.abort();
    const out = await new GitRepoFiles({ readFileAt }).readMany(REPO, 'abc', ['a', 'b'], ctl.signal);
    expect(out).toEqual([null, null]);
    expect(readFileAt).not.toHaveBeenCalled();
  });
});

function llmWith(completeStructured: LLMProvider['completeStructured']): LLMProvider {
  return { id: 'openai', completeStructured } as unknown as LLMProvider;
}

const RESOLVED = { provider: 'openai' as const, model: 'gpt-4.1' };
const MESSAGES = [{ role: 'user' as const, content: 'x' }];

describe('LlmOnboardingModel', () => {
  it('resolves the workspace choice', async () => {
    const model = new LlmOnboardingModel({
      resolveModel: async () => ({ provider: 'anthropic', model: 'claude' }),
      llm: async () => llmWith(vi.fn()),
    });
    await expect(model.resolve('w')).resolves.toEqual({ provider: 'anthropic', model: 'claude' });
  });

  it('calls once with the schema name, one retry and the signal, and returns usage', async () => {
    const data = { architecture: { summary: '', nodes: [], edges: [] }, critical_paths: [], run_steps: [], reading_path: [], first_tasks: [] };
    const completeStructured = vi.fn(async (_req: StructuredRequest<unknown>) => ({
      data,
      model: 'gpt-4.1',
      tokensIn: 10,
      tokensOut: 5,
      costUsd: null,
    }));
    const model = new LlmOnboardingModel({
      resolveModel: async () => RESOLVED,
      llm: async () => llmWith(completeStructured as unknown as LLMProvider['completeStructured']),
    });
    const signal = new AbortController().signal;
    const res = await model.generate(RESOLVED, MESSAGES, signal);
    expect(res).toEqual({ data, tokensIn: 10, tokensOut: 5, costUsd: null });
    const req = completeStructured.mock.calls[0]![0];
    expect(req.schemaName).toBe(ONBOARDING_SCHEMA_NAME);
    expect(req.maxRetries).toBe(LLM_MAX_RETRIES);
    expect(req.signal).toBe(signal);
  });

  it('a missing key (ConfigError, from llm()) → 422 provider_not_configured', async () => {
    const model = new LlmOnboardingModel({
      resolveModel: async () => RESOLVED,
      llm: async () => {
        throw new ConfigError('OPENAI_API_KEY is not configured');
      },
    });
    const err = await rejects(model.generate(RESOLVED, MESSAGES, new AbortController().signal));
    expect(err).toBeInstanceOf(ValidationError);
    expect((err as ValidationError).code).toBe('provider_not_configured');
  });

  it('a provider failure → 502 generation_failed without echoing the provider text', async () => {
    const model = new LlmOnboardingModel({
      resolveModel: async () => RESOLVED,
      llm: async () => llmWith(async () => { throw new Error('boom: secret repo text'); }),
    });
    const err = await rejects(model.generate(RESOLVED, MESSAGES, new AbortController().signal));
    expect(err).toBeInstanceOf(ExternalServiceError);
    expect((err as ExternalServiceError).code).toBe('generation_failed');
    expect((err as Error).message).not.toContain('secret');
  });

  it('an abort → 502 generation_failed', async () => {
    const ctl = new AbortController();
    ctl.abort();
    const model = new LlmOnboardingModel({
      resolveModel: async () => RESOLVED,
      llm: async () => llmWith(async (req) => { req.signal?.throwIfAborted(); throw new Error('unreachable'); }),
    });
    const err = await rejects(model.generate(RESOLVED, MESSAGES, ctl.signal));
    expect((err as ExternalServiceError).code).toBe('generation_failed');
  });
});

function intelService(opts: { enabled: boolean; ranked: Array<{ path: string; rank: number }> }) {
  const noop = async () => {};
  const deps = {
    enabled: opts.enabled,
    reader: {
      getRepoBasics: async () => null,
      tryGetIndexState: async () => null,
      getSymbolRows: async () => [],
      getResolvedCallers: async () => [],
      getFileFacts: async () => [],
      getFileRankFor: async () => [],
      getRankedPaths: async () => opts.ranked,
      getEdges: async () => [],
      getRepoMapCache: async () => null,
    },
    state: { upsertIndexState: noop, touchIndexState: noop, advanceSha: noop },
    tx: { run: async () => { throw new Error('no writes expected'); } },
    git: {} as never,
    codeIndex: { grep: async () => [], symbols: async () => [], references: async () => [] },
    analyzer: {} as never,
    files: { walk: async () => ({ files: [], stats: { totalCandidates: 0, skippedTooLarge: 0, bounded: 0 } }), read: async () => { throw new Error('no clone'); } },
    graph: { buildEdges: async () => [] },
    tokenizer: { count: () => 0 },
    jobs: { enqueue: async () => ({ id: 'j' }) },
    parseConcurrency: 1,
  } satisfies RepoIntelDeps;
  return new RepoIntelService(deps);
}

describe('RepoIntel.listIndexedFiles', () => {
  it('returns every ranked path in rank order, tests included', async () => {
    const svc = intelService({
      enabled: true,
      ranked: [
        { path: 'src/a.ts', rank: 0.9 },
        { path: 'src/a.test.ts', rank: 0.5 },
        { path: 'src/b.ts', rank: 0.1 },
      ],
    });
    await expect(svc.listIndexedFiles('r')).resolves.toEqual(['src/a.ts', 'src/a.test.ts', 'src/b.ts']);
  });

  it('is [] when repo-intel is off', async () => {
    const svc = intelService({ enabled: false, ranked: [{ path: 'src/a.ts', rank: 1 }] });
    await expect(svc.listIndexedFiles('r')).resolves.toEqual([]);
  });
});

/** A db whose `select().from().where()` chain resolves to `rows` (the repository only reads this way). */
function dbReturning(rows: unknown[]): DbOrTx {
  const chain = { from: () => chain, where: async () => rows };
  return { select: () => chain } as unknown as DbOrTx;
}

describe('OnboardingRepository.getTour', () => {
  it('a stored value of an older shape reads as no tour (safeParse, no throw)', async () => {
    const repo = new OnboardingRepository(dbReturning([{ json: { sections: [] } }]));
    await expect(repo.getTour('r')).resolves.toBeNull();
  });

  it('no row → null', async () => {
    await expect(new OnboardingRepository(dbReturning([])).getTour('r')).resolves.toBeNull();
  });
});
