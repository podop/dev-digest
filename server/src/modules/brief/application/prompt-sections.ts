/**
 * Content-free description of the brief prompt for the `prompt_assembled` log line
 * (platform/prompt-log.ts): the delimited blocks of the user message grouped into
 * the closed section names. Only lengths and counts leave this file — never text.
 */
import type { PromptSectionSource } from '@devdigest/reviewer-core';
import { sectionMeta, type PromptLogSectionMeta, type PromptLogSectionName } from '../../../platform/prompt-log.js';
import { BRIEF_SYSTEM_PROMPT, promptSources, type BriefInput, type PromptLabel } from '../domain/prompt.js';

interface SectionKind {
  name: PromptLogSectionName;
  source: PromptSectionSource;
}

/** Block label (see `promptSources`) → log section. PR-derived text is always untrusted. */
const SECTION_OF_LABEL: Record<PromptLabel, SectionKind> = {
  'pr-meta': { name: 'pr_description', source: 'author' },
  description: { name: 'pr_description', source: 'author' },
  changed_files: { name: 'changed_files', source: 'author' },
  intent: { name: 'intent', source: 'model_derived' },
  blast: { name: 'callers', source: 'repo' },
  findings: { name: 'findings', source: 'model_derived' },
  linked_issue: { name: 'linked_issue', source: 'author' },
  spec: { name: 'specs', source: 'repo' },
};

export function briefPromptSections(input: BriefInput): PromptLogSectionMeta[] {
  const grouped = new Map<PromptLogSectionName, { source: PromptSectionSource; texts: string[] }>();
  for (const s of promptSources(input)) {
    const kind = SECTION_OF_LABEL[s.label];
    const entry = grouped.get(kind.name) ?? { source: kind.source, texts: [] };
    entry.texts.push(s.content);
    grouped.set(kind.name, entry);
  }
  return [
    sectionMeta('system', 'engine', 'trusted', BRIEF_SYSTEM_PROMPT),
    ...[...grouped].map(([name, g]) => sectionMeta(name, g.source, 'untrusted', g.texts.join('\n'), { items: g.texts.length })),
  ];
}
