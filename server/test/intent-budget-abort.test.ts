/**
 * Regression: a slow intent model hit the budget (then 30 s) and the refresh failed
 * with the SDK's generic "The user aborted a request.", hiding the real cause.
 * The budget reason must reach the caller (and the 502 message).
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { IntentService } from '../src/modules/intent/application/intent-service.js';
import type { IntentPull, IntentRepo } from '../src/modules/intent/application/ports.js';
import { INTENT_BUDGET_MS, LLM_MAX_OUTPUT_TOKENS } from '../src/modules/intent/domain/constants.js';

afterEach(() => {
  vi.useRealTimers();
});

const pull: IntentPull = {
  id: 'pr-1',
  repoId: 'repo-1',
  number: 7,
  title: 'Add rate limiting',
  body: 'Adds a token bucket in front of the API.',
  branch: 'feat/x',
  headSha: 'sha1',
};
const repo: IntentRepo = { id: 'repo-1', owner: 'acme', name: 'demo' };

/** A model that never answers; on abort it rejects like the openai SDK does. */
function slowModelService() {
  return new IntentService({
    pulls: {
      getPull: async () => pull,
      getRepo: async () => repo,
      getCommits: async () => [],
      getChangedFiles: async () => [],
    },
    model: {
      resolve: async () => ({ provider: 'openrouter', model: 'slow/reasoning-model' }),
      classify: (_resolved, _messages, signal) =>
        new Promise((_, reject) => {
          signal.addEventListener('abort', () => reject(new Error('The user aborted a request.')), { once: true });
        }),
    },
    docs: { read: async () => ({ ok: false, reason: 'no doc refs' }) },
    tickets: { read: async () => ({ ok: false, reason: 'not found' }) },
    store: {
      get: async () => undefined,
      upsert: async () => {
        throw new Error('must not persist');
      },
    },
    clock: () => new Date(),
  });
}

describe('IntentService budget overrun', () => {
  it('the derivation budget is 120 s (slow reasoning models need more than the old 30 s)', () => {
    expect(INTENT_BUDGET_MS).toBe(120_000);
  });

  it('the output cap is 5 000 tokens (a reasoning model spends part of it thinking)', () => {
    expect(LLM_MAX_OUTPUT_TOKENS).toBe(5_000);
  });


  it('refresh reports the exceeded budget, not the SDK abort text', async () => {
    vi.useFakeTimers();
    const service = slowModelService();
    const refreshed = service.refresh('ws', 'pr-1');
    const settled = expect(refreshed).rejects.toMatchObject({
      code: 'intent_unavailable',
      message: `Intent derivation failed: intent derivation exceeded its ${INTENT_BUDGET_MS}ms budget`,
    });
    await vi.advanceTimersByTimeAsync(INTENT_BUDGET_MS);
    await settled;
  });
});
