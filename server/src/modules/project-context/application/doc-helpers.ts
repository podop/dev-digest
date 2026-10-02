import type { ContextDocPreview, ContextUsedByAgent } from '@devdigest/shared';
import { docNameOf } from '../domain/paths.js';
import type { ContextFileRow, UsageRow } from './ports.js';

/** Same estimate as the whole product: ceil(chars / 4). */
export const tokensOf = (chars: number) => Math.ceil(chars / 4);

/** Text length in characters (code points), as the database counts it for the list. */
export const charsOf = (text: string) => {
  let n = 0;
  for (const _ of text) n++;
  return n;
};

/** Agents using each path in a repo: one entry per agent, a direct attachment beating a skill one. */
export function usedByPath(rows: readonly UsageRow[]): Map<string, ContextUsedByAgent[]> {
  const byPath = new Map<string, Map<string, ContextUsedByAgent>>();
  for (const r of rows) {
    const agents = byPath.get(r.path) ?? new Map<string, ContextUsedByAgent>();
    byPath.set(r.path, agents);
    const have = agents.get(r.agentId);
    if (have && (have.via === 'direct' || r.via === 'skill')) continue;
    agents.set(
      r.agentId,
      r.via === 'direct'
        ? { id: r.agentId, name: r.agentName, via: 'direct' }
        : { id: r.agentId, name: r.agentName, via: 'skill', ...(r.skillName ? { skill_name: r.skillName } : {}) },
    );
  }
  const byName = (a: ContextUsedByAgent, b: ContextUsedByAgent) =>
    a.name < b.name ? -1 : a.name > b.name ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  return new Map([...byPath].map(([path, agents]) => [path, [...agents.values()].sort(byName)]));
}

/** The single-document response of a store file. */
export function storeDocPreview(file: ContextFileRow, usedBy: readonly ContextUsedByAgent[]): ContextDocPreview {
  return {
    path: file.path,
    name: docNameOf(file.path),
    doc_type: 'specs',
    content: file.content,
    tokens: tokensOf(charsOf(file.content)),
    size_bytes: file.sizeBytes,
    used_by: usedBy.length,
    used_by_agents: [...usedBy],
    source: 'store',
    editable: true,
    version: file.version,
  };
}
