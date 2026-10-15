import type { Container } from '../../platform/container.js';
import { CiExportService } from './application/export-service.js';
import { CiIngestService } from './application/ingest-service.js';
import type { AgentDirectory, RepoDirectory } from './application/ports.js';
import { CiRepository } from './infrastructure/repository.js';
import { FileRunnerBundle } from './infrastructure/runner-bundle.js';
import { YamlLibCodec } from './infrastructure/yaml-codec.js';
import { FflateZipEntryReader } from './infrastructure/zip-entry-reader.js';

/**
 * Composition root of the ci module (lazy: `Container.modules.ci`). `exporter` = export + installation
 * reads; `ingest` = refresh + run reads. Other modules are reached through ports: the agents repository
 * and the repos service (sibling module, via `c.modules`). GitHub is resolved per call so a missing token
 * only fails the flows that need it.
 */
export function buildCiModule(c: Container) {
  const store = new CiRepository(c.db);
  const agents: AgentDirectory = {
    get: async (workspaceId, agentId) => {
      const agent = await c.agentsRepo.getById(workspaceId, agentId);
      if (!agent) return undefined;
      // Linked AND enabled skills, in link order — the set a live review of this agent carries.
      const linked = await c.agentsRepo.linkedSkills(agentId);
      return {
        id: agent.id,
        name: agent.name,
        provider: agent.provider,
        model: agent.model,
        system_prompt: agent.systemPrompt,
        strategy: agent.strategy,
        ci_fail_on: agent.ciFailOn,
        version: agent.version,
        skills: linked.filter((l) => l.skill.enabled).map((l) => ({ name: l.skill.name, body: l.skill.body })),
      };
    },
    exists: async (workspaceId, agentId) => (await c.agentsRepo.getById(workspaceId, agentId)) !== undefined,
  };
  const repos: RepoDirectory = {
    findByFullName: async (workspaceId, fullName) => {
      const repo = (await c.modules.repos.service.list(workspaceId)).find((r) => r.full_name === fullName);
      return (
        repo && { owner: repo.owner, name: repo.name, fullName: repo.full_name, defaultBranch: repo.default_branch }
      );
    },
  };
  const github = () => c.github();
  return {
    exporter: new CiExportService({ agents, repos, store, bundle: new FileRunnerBundle(), github, yaml: new YamlLibCodec() }),
    ingest: new CiIngestService({ agents, store, github, zip: new FflateZipEntryReader() }),
  };
}
