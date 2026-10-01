/**
 * ProjectContextService with in-memory fakes (no DB, no fs): the 404 order
 * (workspace checks first), the 422 path codes, used_by aggregation and the
 * PROJECT_CONTEXT_GLOBS parsing.
 */
import { describe, it, expect, vi } from 'vitest';
import { PROJECT_CONTEXT_DEFAULT_GLOBS } from '@devdigest/shared';
import { ProjectContextService } from '../src/modules/project-context/application/project-context-service.js';
import type { CloneDocs, ContextStore, UsageRow } from '../src/modules/project-context/application/ports.js';
import { loadConfig, parseGlobList } from '../src/platform/config.js';
import { NotFoundError, ValidationError } from '../src/platform/errors.js';

const GLOBS = ['**/{specs,docs,insights}/**/*.md'];

function fakeStore(opts: { agent?: boolean; skill?: boolean; repo?: boolean; usage?: UsageRow[] } = {}) {
  const store = {
    findRepo: vi.fn(async (_w: string, id: string) =>
      opts.repo === false ? null : { id, owner: 'o', name: 'n', clonePath: '/clone' },
    ),
    agentExists: vi.fn(async () => opts.agent !== false),
    skillExists: vi.fn(async () => opts.skill !== false),
    listUsage: vi.fn(async () => opts.usage ?? []),
    getAgentPaths: vi.fn(async () => ['specs/a.md']),
    getSkillPaths: vi.fn(async () => ['specs/a.md']),
    replaceAgentPaths: vi.fn(async () => undefined),
    replaceSkillPaths: vi.fn(async () => undefined),
  } satisfies ContextStore;
  return store;
}

function build(store: ContextStore, docs: Partial<CloneDocs> = {}) {
  const tx = { run: vi.fn(async <T>(work: (r: { store: ContextStore }) => Promise<T>) => work({ store })) };
  const service = new ProjectContextService({
    store,
    tx,
    docs: { list: async () => null, read: async () => ({ status: 'not_found' }), ...docs },
    git: { resolveBaseCommit: async () => null, readFileAt: async () => { throw new Error('not used'); } },
    globs: GLOBS,
  });
  return { service, tx };
}

const rejects = async (p: Promise<unknown>) => p.then(() => null, (e: unknown) => e);

describe('ProjectContextService attachments', () => {
  it('unknown agent → 404 agent_not_found before anything else is read or written', async () => {
    const store = fakeStore({ agent: false });
    const { service, tx } = build(store);
    const err = await rejects(service.putAgentContext('w', 'a', { repo_id: 'r', paths: ['bad'] }));
    expect(err).toBeInstanceOf(NotFoundError);
    expect(err).toMatchObject({ code: 'agent_not_found' });
    expect(store.findRepo).not.toHaveBeenCalled();
    expect(tx.run).not.toHaveBeenCalled();
    expect(await rejects(service.getAgentContext('w', 'a', 'r'))).toMatchObject({ code: 'agent_not_found' });
  });

  it('unknown skill → 404 skill_not_found', async () => {
    const { service, tx } = build(fakeStore({ skill: false }));
    expect(await rejects(service.putSkillContext('w', 's', { repo_id: 'r', paths: [] }))).toMatchObject({
      code: 'skill_not_found',
    });
    expect(await rejects(service.getSkillContext('w', 's', 'r'))).toMatchObject({ code: 'skill_not_found' });
    expect(tx.run).not.toHaveBeenCalled();
  });

  it('unknown repo → 404 repo_not_found, workspace check beats the path check', async () => {
    const { service } = build(fakeStore({ repo: false }));
    expect(await rejects(service.putAgentContext('w', 'a', { repo_id: 'r', paths: ['../x'] }))).toMatchObject({
      code: 'repo_not_found',
    });
    expect(await rejects(service.getSkillContext('w', 's', 'r'))).toMatchObject({ code: 'repo_not_found' });
  });

  it('path errors are 422 ValidationErrors carrying the domain code; nothing is written', async () => {
    const { service, tx } = build(fakeStore());
    const cases: [string[], string][] = [
      [['specs/a.md', 'specs/a.md'], 'duplicate_path'],
      [['src/d.md'], 'invalid_path'],
      [Array.from({ length: 51 }, (_, i) => `specs/${i}.md`), 'too_many_paths'],
    ];
    for (const [paths, code] of cases) {
      const err = await rejects(service.putAgentContext('w', 'a', { repo_id: 'r', paths }));
      expect(err).toBeInstanceOf(ValidationError);
      expect(err).toMatchObject({ code });
    }
    expect(tx.run).not.toHaveBeenCalled();
  });

  it('a valid PUT replaces inside the transaction and echoes the list', async () => {
    const store = fakeStore();
    const { service, tx } = build(store);
    const res = await service.putSkillContext('w', 's', { repo_id: 'r', paths: ['docs/b.md', 'specs/a.md'] });
    expect(res).toEqual({ repo_id: 'r', paths: ['docs/b.md', 'specs/a.md'] });
    expect(tx.run).toHaveBeenCalledTimes(1);
    expect(store.replaceSkillPaths).toHaveBeenCalledWith('s', 'r', ['docs/b.md', 'specs/a.md']);
  });
});

describe('ProjectContextService used_by', () => {
  const usage: UsageRow[] = [
    { path: 'specs/a.md', agentId: 'a2', agentName: 'Zed', via: 'skill', skillName: 'S1' },
    { path: 'specs/a.md', agentId: 'a2', agentName: 'Zed', via: 'skill', skillName: 'S2' },
    { path: 'specs/a.md', agentId: 'a1', agentName: 'Amy', via: 'skill', skillName: 'S1' },
    { path: 'specs/a.md', agentId: 'a1', agentName: 'Amy', via: 'direct', skillName: null },
  ];

  it('counts each agent once, a direct attachment wins over a skill, ordered by name', async () => {
    const { service } = build(fakeStore({ usage }), {
      read: async () => ({ status: 'ok', content: 'text', sizeBytes: 4 }),
    });
    const res = await service.previewDoc('w', 'r', 'specs/a.md');
    expect(res.used_by).toBe(2);
    expect(res.used_by_agents).toEqual([
      { id: 'a1', name: 'Amy', via: 'direct' },
      { id: 'a2', name: 'Zed', via: 'skill', skill_name: 'S1' },
    ]);
  });

  it('the list reports 0 for a path nobody uses and not_cloned without a clone dir', async () => {
    const store = fakeStore({ usage });
    const date = new Date('2026-01-02T03:04:05.000Z');
    const { service } = build(store, {
      list: async () => ({
        docs: [
          { path: 'docs/b.md', sizeBytes: 5, chars: 5, updatedAt: date },
          { path: 'specs/a.md', sizeBytes: 1, chars: 1, updatedAt: date },
        ],
        truncated: false,
      }),
    });
    const res = await service.listDocs('w', 'r');
    expect(res.docs.map((d) => [d.path, d.used_by, d.tokens, d.updated_at])).toEqual([
      ['docs/b.md', 0, 2, '2026-01-02T03:04:05.000Z'],
      ['specs/a.md', 2, 1, '2026-01-02T03:04:05.000Z'],
    ]);
    expect(res.tokens_total).toBe(3);
    const none = await build(store).service.listDocs('w', 'r');
    expect(none).toEqual({ clone_status: 'not_cloned', globs: GLOBS, docs: [], tokens_total: 0 });
  });
});

describe('PROJECT_CONTEXT_GLOBS', () => {
  it('splits on commas outside braces and trims', () => {
    expect(parseGlobList('**/{specs,docs}/**/*.md, rules/*.md,,')).toEqual(['**/{specs,docs}/**/*.md', 'rules/*.md']);
    expect(parseGlobList(undefined)).toEqual([]);
    expect(parseGlobList('  ')).toEqual([]);
  });

  it('defaults when unset or blank, otherwise uses the env', () => {
    const base = { NODE_ENV: 'test' } as NodeJS.ProcessEnv;
    expect(loadConfig(base).projectContextGlobs).toEqual(PROJECT_CONTEXT_DEFAULT_GLOBS);
    expect(loadConfig({ ...base, PROJECT_CONTEXT_GLOBS: ' ' }).projectContextGlobs).toEqual(PROJECT_CONTEXT_DEFAULT_GLOBS);
    expect(loadConfig({ ...base, PROJECT_CONTEXT_GLOBS: 'a/*.md,b/**/*.md' }).projectContextGlobs).toEqual([
      'a/*.md',
      'b/**/*.md',
    ]);
  });
});

describe('ProjectContextService.resolveForRun without a base commit', () => {
  const input = {
    workspaceId: 'w',
    repoId: 'r',
    repo: { owner: 'o', name: 'n' },
    base: 'main',
    headSha: 'a'.repeat(40),
    agentId: 'a',
    skills: [],
  };

  it('a repo that was never cloned → every document is missing', async () => {
    const store = fakeStore();
    store.findRepo.mockResolvedValue({ id: 'r', owner: 'o', name: 'n', clonePath: null });
    const { service } = build(store);
    const res = await service.resolveForRun(input);
    expect(res.docs.map((d) => d.status)).toEqual(['missing']);
    expect(res.included).toEqual([]);
  });

  it('a clone whose base commit cannot be resolved → every document is unreadable', async () => {
    const { service } = build(fakeStore());
    const res = await service.resolveForRun(input);
    expect(res.docs.map((d) => d.status)).toEqual(['unreadable']);
  });
});
