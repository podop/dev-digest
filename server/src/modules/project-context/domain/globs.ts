/**
 * Minimal glob matcher for repo-relative document paths. Supported syntax:
 * a double star followed by a slash matches zero or more directories, a single
 * star matches within one path segment, `?` matches one non-slash character,
 * and `{a,b}` is an alternation (not nested). Everything else is literal.
 */

const REGEX_SPECIALS = /[.+^$()|[\]\\]/;

function escapeChar(ch: string): string {
  return REGEX_SPECIALS.test(ch) ? `\\${ch}` : ch;
}

/** Translate one glob into an anchored RegExp. */
export function compileGlob(glob: string): RegExp {
  let re = '';
  let inBraces = false;
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i]!;
    if (ch === '*') {
      if (glob[i + 1] === '*') {
        if (glob[i + 2] === '/') {
          re += '(?:[^/]+/)*';
          i += 2;
        } else {
          re += '.*';
          i += 1;
        }
      } else {
        re += '[^/]*';
      }
    } else if (ch === '?') {
      re += '[^/]';
    } else if (ch === '{' && !inBraces && glob.indexOf('}', i) > i) {
      inBraces = true;
      re += '(?:';
    } else if (ch === '}' && inBraces) {
      inBraces = false;
      re += ')';
    } else if (ch === ',' && inBraces) {
      re += '|';
    } else {
      re += escapeChar(ch);
    }
  }
  return new RegExp(`^${re}$`);
}

/** True when the path matches at least one glob. An empty list matches nothing. */
export function matchesAnyGlob(path: string, globs: readonly string[]): boolean {
  return globs.some((g) => compileGlob(g).test(path));
}
