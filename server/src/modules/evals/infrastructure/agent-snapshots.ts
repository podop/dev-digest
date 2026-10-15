/**
 * Reads an agent's current config as an eval run snapshot (infrastructure; implements
 * AgentSnapshots). It depends only on the two reads it needs from the agents repository,
 * so the composition root hands the repository in without this module importing it.
 */
import type { AgentRunSnapshot, AgentSnapshots } from '../application/ports.js';

/** The slice of the agents repository the snapshot reads. */
export interface AgentConfigSource {
  getById(
    workspaceId: string,
    id: string,
  ): Promise<{ version: number; provider: string; model: string; systemPrompt: string; strategy: string } | undefined>;
  linkedSkills(agentId: string): Promise<
    Array<{ skill: { id: string; name: string; description: string; body: string; version: number; enabled: boolean } }>
  >;
}

export class AgentConfigSnapshots implements AgentSnapshots {
  constructor(private readonly agents: AgentConfigSource) {}

  async snapshot(workspaceId: string, agentId: string): Promise<AgentRunSnapshot | undefined> {
    const agent = await this.agents.getById(workspaceId, agentId);
    if (!agent) return undefined;
    // Enabled skills only, in link order — the same set a live review of this agent carries.
    const linked = await this.agents.linkedSkills(agentId);
    return {
      version: agent.version,
      config: {
        provider: agent.provider,
        model: agent.model,
        system_prompt: agent.systemPrompt,
        strategy: agent.strategy,
        skills: linked
          .filter((l) => l.skill.enabled)
          .map(({ skill }) => ({
            id: skill.id,
            name: skill.name,
            description: skill.description,
            body: skill.body,
            version: skill.version,
          })),
      },
    };
  }
}
