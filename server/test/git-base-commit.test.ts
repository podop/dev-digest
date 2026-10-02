import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { simpleGit } from 'simple-git';
import { SimpleGitClient } from '../src/adapters/git/simple-git.js';

/**
 * resolveBaseCommit on real git: merge-base when the PR head is in the clone,
 * else the tip of the base branch; never a throw, never a fetch.
 */

describe('SimpleGitClient.resolveBaseCommit (real git, local origin)', () => {
  let root: string;
  let client: SimpleGitClient;
  let mergeBase: string;
  let mainTip: string;
  let featureHead: string;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'dd-git-base-'));
    const origin = join(root, 'origin');
    await mkdir(origin);
    const o = simpleGit(origin);
    await o.init(['-b', 'main']);
    await o.addConfig('user.email', 't@t');
    await o.addConfig('user.name', 't');
    const commit = async (file: string, body: string): Promise<string> => {
      await writeFile(join(origin, file), body);
      await o.add(file);
      await o.commit(`edit ${file}`);
      return (await o.revparse(['HEAD'])).trim();
    };
    mergeBase = await commit('a.txt', 'one');
    await o.checkoutLocalBranch('feature');
    featureHead = await commit('b.txt', 'feature');
    await o.checkout('main');
    mainTip = await commit('c.txt', 'main moved on');
    client = new SimpleGitClient(join(root, 'clones'));
  });
  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('full clone: the merge-base of the base branch and the PR head', async () => {
    const ref = { owner: 'acme', name: 'full' };
    await client.clone(ref, `file://${join(root, 'origin')}`);
    expect(await client.resolveBaseCommit(ref, 'main', featureHead)).toBe(mergeBase);
  });

  it('shallow clone without the PR head: falls back to the tip of the base branch', async () => {
    const ref = { owner: 'acme', name: 'shallow' };
    await client.clone(ref, `file://${join(root, 'origin')}`, { depth: 1, branch: 'main' });
    expect(await client.resolveBaseCommit(ref, 'main', featureHead)).toBe(mainTip);
  });

  it('unknown base branch resolves to null', async () => {
    const ref = { owner: 'acme', name: 'full' };
    expect(await client.resolveBaseCommit(ref, 'nope', featureHead)).toBeNull();
  });

  it('a repo with no clone directory resolves to null instead of throwing', async () => {
    expect(await client.resolveBaseCommit({ owner: 'acme', name: 'never-cloned' }, 'main', featureHead)).toBeNull();
    expect(await client.resolveBaseCommit({ owner: '..', name: 'x' }, 'main', featureHead)).toBeNull();
  });

  it.each([
    ['--upload-pack=touch /tmp/x', featureHead],
    ['-main', featureHead],
    ['main..feature', featureHead],
    ['main^{commit}', featureHead],
    ['main', 'HEAD'],
    ['main', '--all'],
    ['main', ''],
  ])('rejects the unsafe input (%j, %j) without running git', async (base, head) => {
    const ref = { owner: 'acme', name: 'full' };
    expect(await client.resolveBaseCommit(ref, base, head)).toBeNull();
  });
});
