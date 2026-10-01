import { describe, expect, it } from 'vitest';
import { createHttpApi } from '../src/api.js';
import { ToolError } from '../src/errors.js';
import { agent, blast } from './helpers.js';

function apiReturning(body: unknown, status = 200) {
  const fetch = (async () => new Response(JSON.stringify(body), { status })) as typeof globalThis.fetch;
  return createHttpApi({ baseUrl: 'http://127.0.0.1:3001', requestTimeoutMs: 1_000, fetch });
}

describe('api response contract', () => {
  it('passes a response that has the fields the tools read', async () => {
    await expect(apiReturning([agent()]).listAgents()).resolves.toHaveLength(1);
  });

  it('turns a list with a missing field into api_contract, not a TypeError in a tool', async () => {
    const { name: _name, ...nameless } = agent();
    const err = await apiReturning([nameless]).listAgents().catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ToolError);
    expect(err).toMatchObject({ code: 'api_contract', nextStep: expect.stringContaining('same checkout') });
  });

  it('rejects an object where a list is expected, and vice versa', async () => {
    await expect(apiReturning({ agents: [] }).listAgents()).rejects.toMatchObject({ code: 'api_contract' });
    await expect(apiReturning([]).getConventions('r')).rejects.toMatchObject({ code: 'api_contract' });
  });

  it('keeps HTTP errors on the error path (checked before the contract)', async () => {
    const err = apiReturning({ error: { code: 'not_found', message: 'Agent not found' } }, 404).listAgents();
    await expect(err).rejects.toMatchObject({ code: 'not_found' });
  });
});

describe('getBlastRadius contract', () => {
  it('passes a BlastRadius and calls GET /pulls/:id/blast', async () => {
    const calls: string[] = [];
    const fetch = (async (url: string) => {
      calls.push(url);
      return new Response(JSON.stringify(blast()), { status: 200 });
    }) as unknown as typeof globalThis.fetch;
    const api = createHttpApi({ baseUrl: 'http://127.0.0.1:3001', requestTimeoutMs: 1_000, fetch });

    await expect(api.getBlastRadius('pr-1')).resolves.toMatchObject({ summary: expect.any(String) });
    expect(calls).toEqual(['http://127.0.0.1:3001/pulls/pr-1/blast']);
  });

  it('turns a response without the fields or arrays the tool reads into api_contract', async () => {
    await expect(apiReturning({ summary: 's' }).getBlastRadius('p')).rejects.toMatchObject({ code: 'api_contract' });
    await expect(apiReturning({ summary: 's', changed_symbols: {}, downstream: [] }).getBlastRadius('p')).rejects.toMatchObject({ code: 'api_contract' });
    await expect(apiReturning([]).getBlastRadius('p')).rejects.toMatchObject({ code: 'api_contract' });
  });

  it('keeps a 404 on the error path', async () => {
    await expect(apiReturning({ error: { code: 'not_found', message: 'Pull request not found' } }, 404).getBlastRadius('p')).rejects.toMatchObject({ code: 'not_found' });
  });
});
