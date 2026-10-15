import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import {
  AgentEvalCase,
  AgentEvalCaseList,
  AgentEvalCaseUpdateInput,
  EvalAgentDashboard,
  EvalCompare,
  EvalCompareQuery,
  EvalOverview,
  EvalRunAllResponse,
  EvalRunDetail,
  EvalRunList,
  EvalRunListQuery,
  EvalRunSummary,
} from '@devdigest/shared';
import { getContext } from '../../_shared/context.js';
import { AgentIdParams, EvalCaseIdParams, EvalRunIdParams, FindingIdParams } from './schemas.js';

/** Starting runs fans out to LLM calls: a tight per-route limit (NFR4; off under NODE_ENV=test). */
const RUN_START_RATE_LIMIT = { rateLimit: { max: 10, timeWindow: '1 minute' } };

/**
 * Evals module (specs/eval-pipeline.md §7).
 *   POST   /findings/:id/eval-case   → 201 AgentEvalCase (409 eval_case_exists + case_id; 422 finding_*, patch_*)
 *   GET    /agents/:id/eval-cases    → { cases } (newest first, each with last_result)
 *   PATCH  /eval-cases/:id           → AgentEvalCase (422 field shape; 400 end_line < start_line)
 *   DELETE /eval-cases/:id           → 204
 *   POST   /agents/:id/eval-runs     → 202 EvalRunSummary (409 eval_run_active; 422 no_eval_cases; 429)
 *   GET    /agents/:id/eval-runs     → { runs } (newest first, ?limit 1–100)
 *   GET    /eval-runs/:id            → { run, results }
 *   GET    /eval-runs/compare        → EvalCompare (?a&b; 422 runs_not_comparable)
 *   POST   /eval-runs/run-all        → 202 { started, skipped } (429)
 *   GET    /eval/dashboard           → EvalOverview
 *   GET    /agents/:id/eval/dashboard → EvalAgentDashboard
 * A finding / agent / case of another workspace is a 404, never a 403.
 */
export default async function evalsRoutes(appBase: FastifyInstance) {
  const app = appBase.withTypeProvider<ZodTypeProvider>();
  const { cases, runs } = app.container.modules.evals;

  app.post(
    '/findings/:id/eval-case',
    { schema: { params: FindingIdParams, response: { 201: AgentEvalCase } } },
    async (req, reply) => {
      const { workspaceId } = await getContext(app.container, req);
      const created = await cases.createFromFinding(workspaceId, req.params.id);
      reply.status(201);
      return created;
    },
  );

  app.get(
    '/agents/:id/eval-cases',
    { schema: { params: AgentIdParams, response: { 200: AgentEvalCaseList } } },
    async (req) => {
      const { workspaceId } = await getContext(app.container, req);
      return { cases: await cases.list(workspaceId, req.params.id) };
    },
  );

  app.patch(
    '/eval-cases/:id',
    { schema: { params: EvalCaseIdParams, body: AgentEvalCaseUpdateInput, response: { 200: AgentEvalCase } } },
    async (req) => {
      const { workspaceId } = await getContext(app.container, req);
      return cases.update(workspaceId, req.params.id, req.body);
    },
  );

  app.delete('/eval-cases/:id', { schema: { params: EvalCaseIdParams } }, async (req, reply) => {
    const { workspaceId } = await getContext(app.container, req);
    await cases.remove(workspaceId, req.params.id);
    return reply.code(204).send();
  });

  app.post(
    '/agents/:id/eval-runs',
    { schema: { params: AgentIdParams, response: { 202: EvalRunSummary } }, config: RUN_START_RATE_LIMIT },
    async (req, reply) => {
      const { workspaceId } = await getContext(app.container, req);
      const run = await runs.start(workspaceId, req.params.id, req.log);
      reply.status(202);
      return run;
    },
  );

  app.get(
    '/agents/:id/eval-runs',
    { schema: { params: AgentIdParams, querystring: EvalRunListQuery, response: { 200: EvalRunList } } },
    async (req) => {
      const { workspaceId } = await getContext(app.container, req);
      return { runs: await runs.list(workspaceId, req.params.id, req.query.limit) };
    },
  );

  // Static segment: wins over `/eval-runs/:id` in the router.
  app.get(
    '/eval-runs/compare',
    { schema: { querystring: EvalCompareQuery, response: { 200: EvalCompare } } },
    async (req) => {
      const { workspaceId } = await getContext(app.container, req);
      return runs.compare(workspaceId, req.query.a, req.query.b);
    },
  );

  app.get(
    '/eval-runs/:id',
    { schema: { params: EvalRunIdParams, response: { 200: EvalRunDetail } } },
    async (req) => {
      const { workspaceId } = await getContext(app.container, req);
      return runs.get(workspaceId, req.params.id);
    },
  );

  app.post(
    '/eval-runs/run-all',
    { schema: { response: { 202: EvalRunAllResponse } }, config: RUN_START_RATE_LIMIT },
    async (req, reply) => {
      const { workspaceId } = await getContext(app.container, req);
      const result = await runs.runAll(workspaceId, req.log);
      reply.status(202);
      return result;
    },
  );

  app.get('/eval/dashboard', { schema: { response: { 200: EvalOverview } } }, async (req) => {
    const { workspaceId } = await getContext(app.container, req);
    return runs.overview(workspaceId);
  });

  app.get(
    '/agents/:id/eval/dashboard',
    { schema: { params: AgentIdParams, response: { 200: EvalAgentDashboard } } },
    async (req) => {
      const { workspaceId } = await getContext(app.container, req);
      return runs.agentDashboard(workspaceId, req.params.id);
    },
  );
}
