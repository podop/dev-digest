/**
 * Pure selection of "prior PRs touching these files" (server/specs/07-blast-radius.md,
 * AC 7): merged PRs of the same repo that changed any of this PR's files,
 * excluding this PR, newest first, capped.
 */
import type { MergedPrSummary, PrHistoryItem } from '@devdigest/shared';
import { HISTORY_MAX_ITEMS } from './constants.js';

export function selectPriorPrs(
  candidates: readonly MergedPrSummary[],
  current: { number: number; files: readonly string[] },
  max = HISTORY_MAX_ITEMS,
): PrHistoryItem[] {
  const changed = new Set(current.files);
  const out: PrHistoryItem[] = [];
  for (const pr of candidates) {
    if (pr.number === current.number) continue;
    const overlap = [...new Set(pr.files.filter((f) => changed.has(f)))].sort();
    if (overlap.length === 0) continue;
    out.push({
      pr_number: pr.number,
      title: pr.title,
      merged_at: pr.merged_at,
      author: pr.author,
      files_overlap: overlap,
      notes: '',
    });
  }
  // Date.parse of an unparseable value is NaN → treated as oldest.
  const time = (iso: string) => Date.parse(iso) || 0;
  return out.sort((a, b) => time(b.merged_at) - time(a.merged_at) || b.pr_number - a.pr_number).slice(0, max);
}
