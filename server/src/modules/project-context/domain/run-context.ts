import { PROJECT_CONTEXT_BUDGET_TOKENS, type ContextDocSource } from '@devdigest/shared';
import { estimateTokens } from '@devdigest/reviewer-core';
import { docTypeOf } from './paths.js';
import type { ReadOutcome, RunDoc, RunDocRef, SkillAttachmentSet } from './types.js';

/**
 * The run's document list (FR5): the agent's attachments in order, then each
 * enabled skill's attachments in the given skill order. A path already in the
 * list is not added again; its origin stays that of the first occurrence.
 */
export function buildRunDocList(
  agentPaths: readonly string[],
  skills: readonly SkillAttachmentSet[],
): RunDocRef[] {
  const seen = new Set<string>();
  const out: RunDocRef[] = [];
  const add = (path: string, origin: RunDocRef['origin']) => {
    if (seen.has(path)) return;
    seen.add(path);
    out.push({ path, origin });
  };
  for (const p of agentPaths) add(p, { kind: 'agent' });
  for (const s of skills) {
    if (!s.enabled) continue;
    for (const p of s.paths) add(p, { kind: 'skill', skill_id: s.skillId, skill_name: s.skillName });
  }
  return out;
}

/** Turn one read result into a trace record (before the budget is applied). */
export function toRunDoc(ref: RunDocRef, outcome: ReadOutcome, source: ContextDocSource = 'repo'): RunDoc {
  const base = { path: ref.path, doc_type: docTypeOf(ref.path), origin: ref.origin, source };
  if (outcome.status === 'ok') {
    return { ...base, tokens: estimateTokens(outcome.text), status: 'included', text: outcome.text };
  }
  return { ...base, tokens: 0, status: outcome.status };
}

/** True when adding `tokens` to `total` would pass the budget. */
export function exceedsBudget(
  total: number,
  tokens: number,
  budget: number = PROJECT_CONTEXT_BUDGET_TOKENS,
): boolean {
  return total + tokens > budget;
}

/**
 * Apply the token budget in order: the first included document that would
 * exceed it becomes `over_budget`, and so does every document after it (EC3).
 * Earlier documents stay as they were. `text` is kept only on included ones.
 */
export function applyBudget(
  docs: readonly RunDoc[],
  budget: number = PROJECT_CONTEXT_BUDGET_TOKENS,
): { docs: RunDoc[]; tokensTotal: number } {
  let total = 0;
  let cut = false;
  const out: RunDoc[] = [];
  for (const d of docs) {
    if (!cut && d.status === 'included' && exceedsBudget(total, d.tokens, budget)) cut = true;
    if (cut) {
      const { text: _text, ...rest } = d;
      out.push({ ...rest, status: 'over_budget' });
      continue;
    }
    if (d.status === 'included') total += d.tokens;
    out.push(d);
  }
  return { docs: out, tokensTotal: total };
}

/** The single run log line (NFR4): counts and tokens, never document text. */
export function projectContextLogLine(docs: readonly RunDoc[], tokensTotal: number): string {
  const included = docs.filter((d) => d.status === 'included').length;
  return `project context: ${included} included, ${docs.length - included} skipped · ~${tokensTotal} tokens`;
}

/** Classify a failed read at the base commit: too large, not in that commit, or anything else. */
export function readFailure(err: unknown): Exclude<ReadOutcome, { status: 'ok' }> {
  if ((err as { code?: unknown } | null)?.code === 'too_large') return { status: 'too_large' };
  const message = err instanceof Error ? err.message : '';
  return /not found/i.test(message) ? { status: 'missing' } : { status: 'unreadable' };
}
