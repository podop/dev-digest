import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { getContext } from '../../_shared/context.js';
import { IdParams } from '../../_shared/schemas.js';
import { BlastResponse, HistoryResponse } from './schemas.js';

/**
 * blast module (server/specs/07-blast-radius.md).
 *   GET /pulls/:id/blast → BlastRadius, read from the repo-intel index (no
 *   re-index, no model call). A PR from another workspace is a 404.
 *   GET /pulls/:id/history → PrHistory, prior merged PRs touching the same files
 *   (GitHub; an empty list when GitHub is unavailable).
 */
export default async function blastRoutes(appBase: FastifyInstance) {
  const app = appBase.withTypeProvider<ZodTypeProvider>();
  const { service } = app.container.modules.blast;

  app.get(
    '/pulls/:id/blast',
    { schema: { params: IdParams, response: { 200: BlastResponse } } },
    async (req) => {
      const { workspaceId } = await getContext(app.container, req);
      return service.getBlast(workspaceId, req.params.id, req.log);
    },
  );

  app.get(
    '/pulls/:id/history',
    { schema: { params: IdParams, response: { 200: HistoryResponse } } },
    async (req) => {
      const { workspaceId } = await getContext(app.container, req);
      return service.getHistory(workspaceId, req.params.id, req.log);
    },
  );
}
