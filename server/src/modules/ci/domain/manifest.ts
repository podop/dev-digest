import { AgentManifest, type AgentManifestInput } from '@devdigest/shared';
import { ValidationError } from '../../../platform/errors.js';

/** The slice of an agent the manifest is built from. */
export interface ManifestSource {
  name: string;
  provider: NonNullable<AgentManifestInput['provider']>;
  model: string;
  system_prompt: string;
  strategy: NonNullable<AgentManifestInput['strategy']>;
  ci_fail_on: NonNullable<AgentManifestInput['ci_fail_on']>;
  /** The agent's current version — the deployed manifest version. */
  version: number;
}

/**
 * Build the agent's `AgentManifest` (FR7). It must pass the shared `AgentManifest` schema — the
 * same one the runner loads with — before it is returned; the use case serializes it to YAML.
 */
export function buildManifest(agent: ManifestSource, skillSlugs: string[]): AgentManifest {
  const parsed = AgentManifest.safeParse({
    name: agent.name,
    provider: agent.provider,
    model: agent.model,
    system_prompt: agent.system_prompt,
    skills: skillSlugs,
    strategy: agent.strategy,
    ci_fail_on: agent.ci_fail_on,
    version: agent.version,
  } satisfies AgentManifestInput);
  if (!parsed.success) {
    throw new ValidationError('The agent cannot be serialized as a CI manifest', {
      issues: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    }, 'manifest_invalid');
  }
  return parsed.data;
}
