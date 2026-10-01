import { describe, it, expect } from 'vitest';
import { PROJECT_CONTEXT_DEFAULT_GLOBS } from '@devdigest/shared';
import {
  checkPath,
  docNameOf,
  docTypeOf,
  hasExcludedDir,
  isListablePath,
  validateAttachmentPaths,
} from '../src/modules/project-context/domain/paths.js';
import {
  checkStorePath,
  hasNul,
  utf8Bytes,
  withSuffix,
} from '../src/modules/project-context/domain/store-files.js';
import { compileGlob, matchesAnyGlob } from '../src/modules/project-context/domain/globs.js';
import {
  applyBudget,
  buildRunDocList,
  exceedsBudget,
  projectContextLogLine,
  toRunDoc,
} from '../src/modules/project-context/domain/run-context.js';
import type { RunDocRef } from '../src/modules/project-context/domain/types.js';

const GLOBS = PROJECT_CONTEXT_DEFAULT_GLOBS;

describe('checkPath (shape rule)', () => {
  it('accepts plain repo-relative .md paths', () => {
    for (const p of ['specs/a.md', 'docs/deep/er/b.md', 'a/specs/c.md', 'x.md']) {
      expect(checkPath(p)).toBe(true);
    }
  });

  it('rejects traversal, absolute, wrong extension, backslash, NUL, empty/dot segments, length', () => {
    const bad = [
      '../x.md',
      'specs/../x.md',
      '/etc/a.md',
      'specs/a.txt',
      'specs/a.MD',
      'specs\\a.md',
      'specs/a\0.md',
      'specs//a.md',
      'specs/./a.md',
      './specs/a.md',
      '',
      `${'a/'.repeat(260)}x.md`,
    ];
    for (const p of bad) expect(checkPath(p), JSON.stringify(p)).toBe(false);
    expect(checkPath(undefined)).toBe(false);
    expect(checkPath(42)).toBe(false);
  });
});

describe('globs', () => {
  it('default glob: docs under specs|docs|insights at any depth, including the root', () => {
    expect(matchesAnyGlob('specs/a.md', GLOBS)).toBe(true);
    expect(matchesAnyGlob('docs/deep/er/b.md', GLOBS)).toBe(true);
    expect(matchesAnyGlob('server/insights/INSIGHTS.md', GLOBS)).toBe(true);
    expect(matchesAnyGlob('src/d.md', GLOBS)).toBe(false);
    expect(matchesAnyGlob('specs/a.txt', GLOBS)).toBe(false);
    expect(matchesAnyGlob('myspecs/a.md', GLOBS)).toBe(false);
  });

  it('`*` stays in one segment, `?` is one char, `{a,b}` alternates, regex chars are literal', () => {
    expect(compileGlob('docs/*.md').test('docs/a.md')).toBe(true);
    expect(compileGlob('docs/*.md').test('docs/x/a.md')).toBe(false);
    expect(compileGlob('d?c.md').test('doc.md')).toBe(true);
    expect(compileGlob('{a,b}.md').test('b.md')).toBe(true);
    expect(compileGlob('{a,b}.md').test('c.md')).toBe(false);
    expect(compileGlob('a+b.md').test('a+b.md')).toBe(true);
    expect(compileGlob('a+b.md').test('aab.md')).toBe(false);
    expect(compileGlob('docs/**').test('docs/x/y.md')).toBe(true);
  });

  it('an empty glob list matches nothing', () => {
    expect(matchesAnyGlob('specs/a.md', [])).toBe(false);
  });
});

describe('listable paths (AC4 cases)', () => {
  it('rejects ../x.md, /etc/a.md, specs/a.txt and src/d.md; accepts a listed doc', () => {
    expect(isListablePath('specs/a.md', GLOBS)).toBe(true);
    for (const p of ['../x.md', '/etc/a.md', 'specs/a.txt', 'src/d.md']) {
      expect(isListablePath(p, GLOBS), p).toBe(false);
    }
  });

  it('excluded directories are never listable', () => {
    expect(hasExcludedDir('node_modules/pkg/docs/a.md')).toBe(true);
    expect(isListablePath('node_modules/pkg/docs/a.md', GLOBS)).toBe(false);
    expect(isListablePath('vendor/docs/a.md', GLOBS)).toBe(false);
    expect(hasExcludedDir('docs/build.md')).toBe(false);
  });

  it('docNameOf and docTypeOf', () => {
    expect(docNameOf('docs/deep/a.md')).toBe('a.md');
    expect(docNameOf('a.md')).toBe('a.md');
    expect(docTypeOf('specs/a.md')).toBe('specs');
    expect(docTypeOf('specs/docs/a.md')).toBe('docs');
    expect(docTypeOf('docs/specs/a.md')).toBe('specs');
    expect(docTypeOf('server/insights/I.md')).toBe('insights');
    expect(docTypeOf('README.md')).toBe('docs');
    expect(docTypeOf('x/specs.md')).toBe('docs');
  });
});

describe('validateAttachmentPaths', () => {
  it('ok for a list of listable, distinct paths (existence is not checked)', () => {
    expect(validateAttachmentPaths(['specs/b.md', 'specs/a.md'], GLOBS)).toEqual({ ok: true });
    expect(validateAttachmentPaths([], GLOBS)).toEqual({ ok: true });
  });

  it('duplicate_path, invalid_path, too_many_paths', () => {
    expect(validateAttachmentPaths(['specs/a.md', 'specs/a.md'], GLOBS)).toEqual({
      ok: false,
      code: 'duplicate_path',
    });
    expect(validateAttachmentPaths(['specs/a.md', '../x.md'], GLOBS)).toEqual({
      ok: false,
      code: 'invalid_path',
    });
    expect(validateAttachmentPaths(['src/d.md'], GLOBS)).toEqual({ ok: false, code: 'invalid_path' });
    expect(validateAttachmentPaths([1], GLOBS)).toEqual({ ok: false, code: 'invalid_path' });
    const many = Array.from({ length: 51 }, (_, i) => `specs/${i}.md`);
    expect(validateAttachmentPaths(many, GLOBS)).toEqual({ ok: false, code: 'too_many_paths' });
    expect(validateAttachmentPaths(many.slice(0, 50), GLOBS)).toEqual({ ok: true });
  });

  it('accepts store paths, even when the globs would not list them; rejects bad store paths', () => {
    expect(validateAttachmentPaths(['.devdigest/specs/a.md', 'specs/b.md'], ['**/never/**/*.md'])).toEqual({
      ok: false,
      code: 'invalid_path',
    });
    expect(validateAttachmentPaths(['.devdigest/specs/a.md'], ['**/never/**/*.md'])).toEqual({ ok: true });
    expect(validateAttachmentPaths(['.devdigest/other/a.md'], GLOBS)).toEqual({ ok: false, code: 'invalid_path' });
    expect(validateAttachmentPaths(['.devdigest/specs/a.md', '.devdigest/specs/a.md'], GLOBS)).toEqual({
      ok: false,
      code: 'duplicate_path',
    });
  });
});

describe('checkStorePath (FR8, AC7 paths)', () => {
  const R = '.devdigest/specs/';

  it('accepts files under the root, up to 5 folder levels', () => {
    for (const p of [`${R}a.md`, `${R}api/public.md`, `${R}A_b-1.2/x.v1.md`, `${R}1/2/3/4/5/a.md`]) {
      expect(checkStorePath(p), p).toBe(true);
    }
  });

  it('rejects the AC7 paths', () => {
    const bad = [
      '../x.md',
      `/${R}a.md`,
      `${R}a b.md`,
      `${R}a.txt`,
      `${R}1/2/3/4/5/6/a.md`,
      'specs/a.md',
    ];
    for (const p of bad) expect(checkStorePath(p), p).toBe(false);
  });

  it('rejects empty/dot segments, backslash, unicode, NUL, wrong root, length, non-strings', () => {
    const bad = [
      `${R}../a.md`,
      `${R}./a.md`,
      `${R}a//b.md`,
      `${R}a\\b.md`,
      `${R}é.md`,
      `${R}a\0.md`,
      `${R}a.MD`,
      '.devdigest/spec/a.md',
      `.devdigest/specs`,
      `${R}${'a'.repeat(512)}.md`,
      '',
    ];
    for (const p of bad) expect(checkStorePath(p), JSON.stringify(p)).toBe(false);
    expect(checkStorePath(undefined)).toBe(false);
    expect(checkStorePath(7)).toBe(false);
    expect(checkStorePath(`${R}${'a'.repeat(512 - R.length - 3)}.md`)).toBe(true); // exactly 512
  });
});

describe('withSuffix / utf8Bytes / hasNul', () => {
  it('inserts the number before .md', () => {
    expect(withSuffix('.devdigest/specs/untitled.md', 2)).toBe('.devdigest/specs/untitled-2.md');
    expect(withSuffix('.devdigest/specs/a/b-2.md', 3)).toBe('.devdigest/specs/a/b-2-3.md');
  });

  it('counts UTF-8 bytes, not characters', () => {
    expect(utf8Bytes('abc')).toBe(3);
    expect(utf8Bytes('é')).toBe(2);
    expect(utf8Bytes('€')).toBe(3);
  });

  it('detects NUL', () => {
    expect(hasNul('a\0b')).toBe(true);
    expect(hasNul('ab')).toBe(false);
  });
});

describe('buildRunDocList (AC9)', () => {
  it('agent [a]; skills [b,a], [c]; disabled [d] → a, b, c; a keeps origin agent', () => {
    const docs = buildRunDocList(
      ['a.md'],
      [
        { skillId: 's1', skillName: 'One', enabled: true, paths: ['b.md', 'a.md'] },
        { skillId: 's2', skillName: 'Two', enabled: true, paths: ['c.md'] },
        { skillId: 's3', skillName: 'Off', enabled: false, paths: ['d.md'] },
      ],
    );
    expect(docs.map((d) => d.path)).toEqual(['a.md', 'b.md', 'c.md']);
    expect(docs[0]!.origin).toEqual({ kind: 'agent' });
    expect(docs[1]!.origin).toEqual({ kind: 'skill', skill_id: 's1', skill_name: 'One' });
    expect(docs[2]!.origin).toEqual({ kind: 'skill', skill_id: 's2', skill_name: 'Two' });
  });

  it('the same path on two skills keeps the first skill as origin', () => {
    const docs = buildRunDocList(
      [],
      [
        { skillId: 's1', skillName: 'One', enabled: true, paths: ['x.md'] },
        { skillId: 's2', skillName: 'Two', enabled: true, paths: ['x.md'] },
      ],
    );
    expect(docs).toHaveLength(1);
    expect(docs[0]!.origin).toMatchObject({ skill_id: 's1' });
  });

  it('nothing attached → empty list', () => {
    expect(buildRunDocList([], [])).toEqual([]);
  });
});

describe('statuses and budget (AC11)', () => {
  const ref = (path: string): RunDocRef => ({ path, origin: { kind: 'agent' } });
  const textOf = (tokens: number) => 'x'.repeat(tokens * 4);

  it('missing, too_large, 10000, 5000, 2000, 500 → missing, too_large, included, included, over_budget, over_budget; total 15000', () => {
    const reads = [
      toRunDoc(ref('specs/gone.md'), { status: 'missing' }),
      toRunDoc(ref('specs/big.md'), { status: 'too_large' }),
      toRunDoc(ref('specs/a.md'), { status: 'ok', text: textOf(10_000) }),
      toRunDoc(ref('specs/b.md'), { status: 'ok', text: textOf(5_000) }),
      toRunDoc(ref('specs/c.md'), { status: 'ok', text: textOf(2_000) }),
      toRunDoc(ref('specs/d.md'), { status: 'ok', text: textOf(500) }),
    ];
    const { docs, tokensTotal } = applyBudget(reads);
    expect(docs.map((d) => d.status)).toEqual([
      'missing',
      'too_large',
      'included',
      'included',
      'over_budget',
      'over_budget',
    ]);
    expect(tokensTotal).toBe(15_000);
    expect(docs[2]!.text).toHaveLength(40_000);
    expect(docs[4]!.text).toBeUndefined();
    expect(docs[5]!.text).toBeUndefined();
  });

  it('exactly the budget is still included; one token more is not', () => {
    expect(exceedsBudget(15_000, 1_000)).toBe(false);
    expect(exceedsBudget(15_000, 1_001)).toBe(true);
  });

  it('toRunDoc: doc_type from the path, tokens = ceil(chars/4), none for skipped docs', () => {
    const inc = toRunDoc(ref('server/insights/I.md'), { status: 'ok', text: 'abcde' });
    expect(inc).toMatchObject({ doc_type: 'insights', tokens: 2, status: 'included', text: 'abcde' });
    const miss = toRunDoc(ref('docs/a.md'), { status: 'unreadable' });
    expect(miss).toMatchObject({ doc_type: 'docs', tokens: 0, status: 'unreadable' });
    expect('text' in miss).toBe(false);
  });

  it('log line carries counts and tokens only', () => {
    const { docs, tokensTotal } = applyBudget([
      toRunDoc(ref('specs/a.md'), { status: 'ok', text: 'SECRET-BODY' }),
      toRunDoc(ref('specs/b.md'), { status: 'missing' }),
    ]);
    const line = projectContextLogLine(docs, tokensTotal);
    expect(line).toBe('project context: 1 included, 1 skipped · ~3 tokens');
    expect(line).not.toContain('SECRET-BODY');
  });
});
