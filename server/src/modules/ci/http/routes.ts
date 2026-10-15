import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { CiExport, CiRefreshResult } from '@devdigest/shared';
import { getContext } from '../../_shared/context.js';
import { AgentIdParams, CiExportBody, CiInstallationList, CiRefreshBody, CiRunList, CiRunsQuery } from './schemas.js';

/**
 * Ci module (specs/export-to-ci.md §7).
 *   POST /agents/:id/export-ci        → 200 CiExport (action "files") | 201 CiExport (action "open_pr");
 *                                       404 agent_not_found, repo_not_found; 409 ci_slug_conflict; 422 unsupported_*,
 *                                       invalid_triggers, skill_slug_conflict, workflow_insecure (+ details.rule),
 *                                       github_permission_denied; 502 github_unavailable; 500 runner_bundle_missing
 *   GET  /agents/:id/ci-installations → { installations } (404 agent_not_found)
 *   GET  /ci/runs                     → { runs } (newest first, ?agent_id, ?limit 1–200 = 100)
 *   POST /ci/refresh                  → 200 CiRefreshResult (body { agent_id? }; 404 agent_not_found)
 * An agent or repository of another workspace is a 404, never a 403.
 */
export default async function ciRoutes(appBase: FastifyInstance) {
  const app = appBase.withTypeProvider<ZodTypeProvider>();
  const { exporter, ingest } = app.container.modules.ci;

  app.post(
    '/agents/:id/export-ci',
    { schema: { params: AgentIdParams, body: CiExportBody, response: { 200: CiExport, 201: CiExport } } },
    async (req, reply) => {
      const { workspaceId } = await getContext(app.container, req);
      const result = await exporter.export(workspaceId, req.params.id, req.body, req.log);
      reply.status(req.body.action === 'open_pr' ? 201 : 200);
      return result;
    },
  );

  app.get(
    '/agents/:id/ci-installations',
    { schema: { params: AgentIdParams, response: { 200: CiInstallationList } } },
    async (req) => {
      const { workspaceId } = await getContext(app.container, req);
      return { installations: await exporter.listInstallations(workspaceId, req.params.id) };
    },
  );

  app.get(
    '/ci/runs',
    { schema: { querystring: CiRunsQuery, response: { 200: CiRunList } } },
    async (req) => {
      const { workspaceId } = await getContext(app.container, req);
      return { runs: await ingest.listRuns(workspaceId, { agentId: req.query.agent_id, limit: req.query.limit }) };
    },
  );

  app.post(
    '/ci/refresh',
    { schema: { body: CiRefreshBody, response: { 200: CiRefreshResult } } },
    async (req) => {
      const { workspaceId } = await getContext(app.container, req);
      return ingest.refresh(workspaceId, req.body.agent_id, req.log);
    },
  );
}
