import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { getContext } from '../../_shared/context.js';
import { IdParams } from '../../_shared/schemas.js';
import { OnboardingTourReadyResponse, OnboardingTourStateResponse } from './schemas.js';

/**
 * onboarding module (specs/2026-10-01-onboarding-generator.md §7).
 *   GET  /repos/:id/onboarding → { status: 'none' } or the stored tour + derived stale flag
 *   POST /repos/:id/onboarding → generate (one LLM call), store and return the tour
 *                                (404 repo_not_found · 409 generation_in_progress · 422 index_not_ready /
 *                                provider_not_configured · 502 generation_failed)
 * No request body: a POST without payload would reach a body validator as null.
 * A repo of another workspace is a 404, never a 403.
 */
export default async function onboardingRoutes(appBase: FastifyInstance) {
  const app = appBase.withTypeProvider<ZodTypeProvider>();
  const { service } = app.container.modules.onboarding;

  app.get(
    '/repos/:id/onboarding',
    { schema: { params: IdParams, response: { 200: OnboardingTourStateResponse } } },
    async (req) => {
      const { workspaceId } = await getContext(app.container, req);
      return service.getTour(workspaceId, req.params.id);
    },
  );

  app.post(
    '/repos/:id/onboarding',
    { schema: { params: IdParams, response: { 200: OnboardingTourReadyResponse } } },
    async (req) => {
      const { workspaceId } = await getContext(app.container, req);
      return service.generate(workspaceId, req.params.id, req.log);
    },
  );
}
