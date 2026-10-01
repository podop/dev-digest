import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { getContext } from '../../_shared/context.js';
import { IdParams } from '../../_shared/schemas.js';
import { PrBriefResponse } from './schemas.js';

/**
 * brief module (specs/2026-10-01-pr-brief.md §7).
 *   GET  /pulls/:id/brief → { brief | null, stale } — never calls a model (404 not_found)
 *   POST /pulls/:id/brief → generate (one model call + at most one re-ask), store and return
 *                           { brief, stale: false } (404 not_found · 409 generation_in_progress ·
 *                           422 no_changed_files / provider_not_configured · 502 generation_failed)
 * No request body: a POST without payload would reach a body validator as null.
 * A PR of another workspace is a 404, never a 403.
 */
export default async function briefRoutes(appBase: FastifyInstance) {
  const app = appBase.withTypeProvider<ZodTypeProvider>();
  const { service } = app.container.modules.brief;

  app.get(
    '/pulls/:id/brief',
    { schema: { params: IdParams, response: { 200: PrBriefResponse } } },
    async (req) => {
      const { workspaceId } = await getContext(app.container, req);
      return service.get(workspaceId, req.params.id);
    },
  );

  app.post(
    '/pulls/:id/brief',
    { schema: { params: IdParams, response: { 200: PrBriefResponse } } },
    async (req) => {
      const { workspaceId } = await getContext(app.container, req);
      return service.generate(workspaceId, req.params.id, req.log);
    },
  );
}
