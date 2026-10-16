import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { AgentPerf, AgentStats } from '@devdigest/shared';
import { getContext } from '../../_shared/context.js';
import { IdParams } from '../../_shared/schemas.js';
import { PeriodQuery } from './schemas.js';

/**
 * Performance module (specs/2026-10-16-agent-performance.md §7). Read-only: no
 * LLM call, job or write.
 *   GET /agents/performance?period=&from=&to=   → AgentPerf (a row per agent + summary + cost breakdowns)
 *   GET /agents/:id/stats?period=&from=&to=     → AgentStats (404 for an unknown / other workspace's agent)
 * Invalid period → 422 validation_error.
 */
export default async function performanceRoutes(appBase: FastifyInstance) {
  const app = appBase.withTypeProvider<ZodTypeProvider>();
  const { service } = app.container.modules.performance;

  app.get(
    '/agents/performance',
    { schema: { querystring: PeriodQuery, response: { 200: AgentPerf } } },
    async (req) => {
      const { workspaceId } = await getContext(app.container, req);
      return service.overview(workspaceId, req.query);
    },
  );

  app.get(
    '/agents/:id/stats',
    { schema: { params: IdParams, querystring: PeriodQuery, response: { 200: AgentStats } } },
    async (req) => {
      const { workspaceId } = await getContext(app.container, req);
      return service.agentStats(workspaceId, req.params.id, req.query);
    },
  );
}
