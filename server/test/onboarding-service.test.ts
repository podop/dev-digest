/**
 * OnboardingService with in-memory fakes (no DB, no git, no LLM): the 404 → 409 → 422
 * order, one generation per repo, the previous tour surviving failures, the stale
 * reasons, the model input (secrets never sent) and the single content-free log line.
 */
import { describe, it, expect, vi } from 'vitest';
import type { OnboardingTour } from '@devdigest/shared';
import { OnboardingService } from '../src/modules/onboarding/application/onboarding-service.js';
import type {
  GenerateResult,
  Logger,
  OnboardingModel,
  OnboardingRepo,
  OnboardingStore,
  RepoFiles,
  RepoIndex,
} from '../src/modules/onboarding/application/ports.js';
import { PROMPT_VERSION } from '../src/modules/onboarding/domain/constants.js';
import type { OnboardingLlmOutput } from '../src/modules/onboarding/domain/prompt.js';
import { ExternalServiceError, NotFoundError, ValidationError, ConflictError } from '../src/platform/errors.js';

const REPO: OnboardingRepo = { id: 'r1', owner: 'o', name: 'n', fullName: 'o/n', defaultBranch: 'main' };
const SHA = 'a'.repeat(40);
const INDEXED = ['src/a.ts', 'src/b.ts', 'src/c.ts', 'src/a.test.ts'];
const NOW = new Date('2026-10-01T12:00:00.000Z');

const rejects = async (p: Promise<unknown>) => p.then(() => null, (e: unknown) => e);

function llmOutput(): OnboardingLlmOutput {
  return {
    architecture: {
      summary: 'A server.',
      nodes: [
        { id: 'api', label: 'API', kind: 'entry' },
        { id: 'db', label: 'DB', kind: 'store' },
      ],
      edges: [{ from: 'api', to: 'db' }],
    },
    critical_paths: [
      { path: 'src/a.ts', reason: 'a' },
      { path: 'src/b.ts', reason: 'b' },
      { path: 'src/c.ts', reason: 'c' },
      { path: 'src/invented.ts', reason: 'x' },
    ],
    run_steps: [{ command: 'pnpm dev' }],
    reading_path: [
      { path: 'src/a.ts', reason: 'a' },
      { path: 'src/b.ts', reason: 'b' },
      { path: 'src/c.ts', reason: 'c' },
    ],
    first_tasks: [{ title: 'Test b', path: 'src/b.ts', complexity: 'low' }],
  };
}

function oldTour(over: Partial<OnboardingTour> = {}): OnboardingTour {
  return {
    repo_id: REPO.id,
    generated_at: '2026-09-01T00:00:00.000Z',
    indexed_sha: SHA,
    files_indexed: 4,
    provider: 'openai',
    model: 'm',
    tokens_in: 1,
    tokens_out: 1,
    cost_usd: null,
    prompt_version: PROMPT_VERSION,
    language: 'en',
    architecture: { summary: 'old', nodes: [], edges: [] },
    critical_paths: [],
    run_steps: [],
    reading_path: [],
    first_tasks: [],
    ...over,
  };
}

interface Opts {
  repo?: boolean;
  stored?: OnboardingTour | null;
  filesIndexed?: number;
  sha?: string;
  texts?: Record<string, string>;
  generate?: OnboardingModel['generate'];
  timeoutMs?: number;
}

function build(opts: Opts = {}) {
  let stored: OnboardingTour | null = opts.stored ?? null;
  const store = {
    findRepo: vi.fn(async (_w: string, id: string) => (opts.repo === false ? null : { ...REPO, id })),
    getTour: vi.fn(async () => stored),
    upsertTour: vi.fn(async (_id: string, tour: OnboardingTour) => {
      stored = tour;
    }),
  } satisfies OnboardingStore;
  const index = {
    getIndexState: vi.fn(async () => ({ filesIndexed: opts.filesIndexed ?? 4, lastIndexedSha: opts.sha ?? SHA })),
    getRepoMap: vi.fn(async () => ({ text: 'MAP' })),
    getTopFilesByRank: vi.fn(async () => ['src/a.ts', 'src/b.ts', 'src/c.ts']),
    getCriticalPaths: vi.fn(async () => [['src/a.ts', 'src/b.ts']]),
    listIndexedFiles: vi.fn(async () => INDEXED),
  } satisfies RepoIndex;
  const texts = opts.texts ?? {};
  const files = {
    readMany: vi.fn(async (_r: unknown, _sha: string, paths: readonly string[]) => paths.map((p) => texts[p] ?? null)),
  } satisfies RepoFiles;
  const generate = vi.fn(
    opts.generate ??
      (async (): Promise<GenerateResult> => ({ data: llmOutput(), tokensIn: 100, tokensOut: 50, costUsd: 0.01 })),
  );
  const model = {
    resolve: vi.fn(async () => ({ provider: 'openai' as const, model: 'gpt-4.1' })),
    generate,
  } satisfies OnboardingModel;
  const log = { info: vi.fn(), warn: vi.fn() } satisfies Logger;
  const service = new OnboardingService({
    store,
    index,
    files,
    model,
    clock: () => NOW,
    ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
  });
  return { service, store, index, files, model, generate, log, stored: () => stored };
}

describe('getTour (AC12 stale reasons)', () => {
  it('unknown repo → 404 repo_not_found', async () => {
    const err = await rejects(build({ repo: false }).service.getTour('w', 'r1'));
    expect(err).toBeInstanceOf(NotFoundError);
    expect((err as NotFoundError).code).toBe('repo_not_found');
  });

  it('no stored tour → none', async () => {
    await expect(build().service.getTour('w', 'r1')).resolves.toEqual({ status: 'none' });
  });

  it('same sha and prompt version → ready, not stale', async () => {
    const tour = oldTour();
    await expect(build({ stored: tour }).service.getTour('w', 'r1')).resolves.toEqual({
      status: 'ready',
      stale: false,
      tour,
    });
  });

  it('another indexed sha → stale index_changed', async () => {
    const res = await build({ stored: oldTour(), sha: 'b'.repeat(40) }).service.getTour('w', 'r1');
    expect(res).toMatchObject({ status: 'ready', stale: true, stale_reason: 'index_changed' });
  });

  it('another prompt version → stale prompt_changed', async () => {
    const res = await build({ stored: oldTour({ prompt_version: PROMPT_VERSION - 1 }) }).service.getTour('w', 'r1');
    expect(res).toMatchObject({ stale: true, stale_reason: 'prompt_changed' });
  });

  it('both changed → index_changed; an index that vanished counts as changed', async () => {
    const both = await build({ stored: oldTour({ prompt_version: 0 }), sha: 'b'.repeat(40) }).service.getTour('w', 'r1');
    expect(both).toMatchObject({ stale: true, stale_reason: 'index_changed' });
    const gone = await build({ stored: oldTour(), sha: '' }).service.getTour('w', 'r1');
    expect(gone).toMatchObject({ stale: true, stale_reason: 'index_changed' });
  });
});

describe('generate', () => {
  it('stores a verified tour read at the indexed sha and returns it fresh', async () => {
    const t = build({ texts: { 'README.md': '# Hello readme', 'package.json': '{"scripts":{"dev":"vite"}}' } });
    const res = await t.service.generate('w', 'r1', t.log);
    expect(res.status).toBe('ready');
    expect(res.stale).toBe(false);
    expect(res.tour).toMatchObject({
      repo_id: 'r1',
      indexed_sha: SHA,
      files_indexed: 4,
      provider: 'openai',
      model: 'gpt-4.1',
      tokens_in: 100,
      tokens_out: 50,
      cost_usd: 0.01,
      prompt_version: PROMPT_VERSION,
      language: 'en',
      generated_at: NOW.toISOString(),
    });
    // the invented path is dropped, the three real ones stay (AC3)
    expect(res.tour.critical_paths.map((p) => p.path)).toEqual(['src/a.ts', 'src/b.ts', 'src/c.ts']);
    expect(t.stored()).toEqual(res.tour);
    expect(t.files.readMany.mock.calls.every((c) => c[1] === SHA)).toBe(true);
    const messages = t.generate.mock.calls[0]![1];
    const user = messages.find((m) => m.role === 'user')!.content;
    expect(user).toContain('# Hello readme');
    expect(user).toContain('"dev": "vite"');
  });

  it('never sends .env.example values — names only (AC9)', async () => {
    const t = build({ texts: { '.env.example': 'API_TOKEN=hunter2-secret\nPORT=3001\n' } });
    await t.service.generate('w', 'r1', t.log);
    const user = t.generate.mock.calls[0]![1].find((m) => m.role === 'user')!.content;
    expect(user).toContain('API_TOKEN');
    expect(user).not.toContain('hunter2-secret');
  });

  it('unknown repo → 404 before anything is read', async () => {
    const t = build({ repo: false });
    expect(await rejects(t.service.generate('w', 'r1', t.log))).toBeInstanceOf(NotFoundError);
    expect(t.index.getIndexState).not.toHaveBeenCalled();
    expect(t.log.info).not.toHaveBeenCalled();
    expect(t.log.warn).not.toHaveBeenCalled();
  });

  it('index with no files → 422 index_not_ready, no model call, repo is free again', async () => {
    const t = build({ filesIndexed: 0 });
    const err = await rejects(t.service.generate('w', 'r1', t.log));
    expect(err).toBeInstanceOf(ValidationError);
    expect((err as ValidationError).code).toBe('index_not_ready');
    expect(t.generate).not.toHaveBeenCalled();
    expect(t.stored()).toBeNull();
    // the in-flight mark was released: a second attempt reaches the same 422, not a 409
    expect(await rejects(t.service.generate('w', 'r1', t.log))).toBeInstanceOf(ValidationError);
  });

  it('a second call while one runs → 409 generation_in_progress; other repos and later calls are fine (AC7)', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const t = build({
      generate: async () => {
        await gate;
        return { data: llmOutput(), tokensIn: 1, tokensOut: 1, costUsd: null };
      },
    });
    const first = t.service.generate('w', 'r1', t.log);
    await vi.waitFor(() => expect(t.generate).toHaveBeenCalledTimes(1));
    const err = await rejects(t.service.generate('w', 'r1', t.log));
    expect(err).toBeInstanceOf(ConflictError);
    expect((err as ConflictError).code).toBe('generation_in_progress');
    expect(t.generate).toHaveBeenCalledTimes(1);
    const other = t.service.generate('w', 'r2', t.log);
    await vi.waitFor(() => expect(t.generate).toHaveBeenCalledTimes(2));
    release();
    await Promise.all([first, other]);
    await expect(t.service.generate('w', 'r1', t.log)).resolves.toMatchObject({ status: 'ready' });
  });

  it('a failed generation keeps the previous tour and frees the repo (AC6)', async () => {
    const previous = oldTour();
    const t = build({
      stored: previous,
      generate: async () => {
        throw new ExternalServiceError('The model call failed', undefined, 'generation_failed');
      },
    });
    const err = await rejects(t.service.generate('w', 'r1', t.log));
    expect((err as ExternalServiceError).code).toBe('generation_failed');
    expect(t.store.upsertTour).not.toHaveBeenCalled();
    expect(t.stored()).toBe(previous);
    expect(await rejects(t.service.generate('w', 'r1', t.log))).toBeInstanceOf(ExternalServiceError); // not a 409
  });

  it('a generation past the time budget fails with generation_failed and stores nothing', async () => {
    const t = build({
      timeoutMs: 5,
      generate: (_resolved, _messages, signal) =>
        new Promise<GenerateResult>((_res, rej) => {
          signal.addEventListener('abort', () =>
            rej(new ExternalServiceError('The model call failed', undefined, 'generation_failed')),
          );
        }),
    });
    const err = await rejects(t.service.generate('w', 'r1', t.log));
    expect((err as ExternalServiceError).code).toBe('generation_failed');
    expect(t.store.upsertTour).not.toHaveBeenCalled();
  });

  it('writes ONE log line with ids, usage and counts but no repo text (AC13)', async () => {
    const t = build({ texts: { 'README.md': 'SECRET-README-TEXT' } });
    await t.service.generate('w', 'r1', t.log);
    expect(t.log.info).toHaveBeenCalledTimes(1);
    expect(t.log.warn).not.toHaveBeenCalled();
    const line = t.log.info.mock.calls[0]![0] as Record<string, unknown>;
    expect(Object.keys(line).sort()).toEqual(
      ['costUsd', 'dropped', 'durationMs', 'model', 'outcome', 'provider', 'repoId', 'tokensIn', 'tokensOut'].sort(),
    );
    expect(line).toMatchObject({
      repoId: 'r1',
      provider: 'openai',
      model: 'gpt-4.1',
      tokensIn: 100,
      tokensOut: 50,
      costUsd: 0.01,
      outcome: 'ok',
      dropped: { critical_paths: 1 },
    });
    expect(typeof line.durationMs).toBe('number');
    expect(JSON.stringify(t.log.info.mock.calls)).not.toContain('SECRET-README-TEXT');
  });

  it('a failure also logs exactly one line, carrying the error code only', async () => {
    const t = build({
      generate: async () => {
        throw new ValidationError('x with repo text', undefined, 'provider_not_configured');
      },
    });
    await rejects(t.service.generate('w', 'r1', t.log));
    expect(t.log.warn).toHaveBeenCalledTimes(1);
    expect(t.log.info).not.toHaveBeenCalled();
    const line = t.log.warn.mock.calls[0]![0] as Record<string, unknown>;
    expect(line).toMatchObject({ repoId: 'r1', provider: 'openai', outcome: 'provider_not_configured' });
    expect(JSON.stringify(line)).not.toContain('repo text');
  });
});
