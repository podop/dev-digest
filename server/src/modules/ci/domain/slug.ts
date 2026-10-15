import {
  AGENT_SLUG_FALLBACK,
  SLUG_MAX_LENGTH,
  SLUG_PATTERN,
} from './constants.js';

/**
 * Derive a filesystem-safe slug from a display name (FR8): lowercase `a-z0-9`
 * and `-`, at most 40 chars, always matching the runner's `DEVDIGEST_AGENT` shape.
 * Pure and stable. `fallback` is used when nothing usable remains.
 */
export function slugify(name: string, fallback: string = AGENT_SLUG_FALLBACK): string {
  const slug = name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+/, '')
    .slice(0, SLUG_MAX_LENGTH)
    .replace(/-+$/, '');
  return SLUG_PATTERN.test(slug) ? slug : fallback;
}
