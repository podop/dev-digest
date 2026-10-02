/**
 * Regression: two reindexes of one repo overlapping (clone → full index ‖
 * refresh → incremental slice) both deleted before either committed, so the
 * later insert hit symbols_repo_path_name_kind_line_uq — and the unhandled job
 * rejection then took the whole API down. IndexWriter.lockRepo serializes them.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { eq } from 'drizzle-orm';
import { startPg, dockerAvailable, type PgFixture } from './helpers/pg.js';
import { seed } from '../src/db/seed.js';
import * as t from '../src/db/schema.js';
import { RepoIntelRepository } from '../src/modules/repo-intel/infrastructure/repository.js';

const hasDocker = await dockerAvailable();
const d = hasDocker ? describe : describe.skip;

d('repo-intel reindex transactions of one repo are serialized by lockRepo', () => {
  let pg: PgFixture;
  let repoId: string;
  let repo: RepoIntelRepository;

  beforeAll(async () => {
    pg = await startPg();
    await seed(pg.handle.db);
    const [ws] = await pg.handle.db.select().from(t.workspaces);
    const [r] = await pg.handle.db
      .insert(t.repos)
      .values({ workspaceId: ws!.id, owner: 'acme', name: 'race', fullName: 'acme/race' })
      .returning();
    repoId = r!.id;
    repo = new RepoIntelRepository(pg.handle.db);
  });
  afterAll(async () => {
    await pg?.stop();
  });

  const symbol = () => ({
    repoId,
    path: 'src/a.ts',
    name: 'savedPatch',
    kind: 'function',
    line: 34,
    endLine: 37,
    exported: false,
    signature: null,
    contentHash: 'h',
  });

  it('a second delete-then-insert waits for the first to commit instead of hitting the UNIQUE key', async () => {
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    let firstLocked!: () => void;
    const locked = new Promise<void>((r) => (firstLocked = r));

    // Full index: locks, wipes, inserts, then stays open until released.
    const first = repo.transaction(async (tx) => {
      await tx.lockRepo(repoId);
      await tx.deleteAllForRepo(repoId);
      await tx.insertSymbols([symbol()]);
      firstLocked();
      await held;
    });
    await locked;

    // Incremental slice of the same file, started while the first is still open.
    // Without the lock its delete misses the uncommitted row and its insert fails
    // with a duplicate key once the first commits.
    const second = repo.transaction(async (tx) => {
      await tx.lockRepo(repoId);
      await tx.deleteForFiles(repoId, ['src/a.ts']);
      await tx.insertSymbols([symbol()]);
    });
    await new Promise((r) => setTimeout(r, 200)); // second is now blocked on the lock
    release();

    await expect(Promise.all([first, second])).resolves.toBeDefined();
    const rows = await pg.handle.db.select().from(t.symbols).where(eq(t.symbols.repoId, repoId));
    expect(rows).toHaveLength(1);
  });
});
