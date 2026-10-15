/** Route-local schemas of the ci module; the request/response bodies come from `@devdigest/shared`. */
import { z } from 'zod';
import { CiExportInput, CiInstallation, CiRun } from '@devdigest/shared';
import { IdParams } from '../../_shared/schemas.js';

export const AgentIdParams = IdParams;

/** Hard cap on the edited workflow in the request body — far above the 64 KiB rule limit (1 MiB = the Fastify body limit). */
export const MAX_WORKFLOW_REQUEST_CHARS = 1_048_576;

/**
 * `POST /agents/:id/export-ci` body. The shared schema caps `workflow` at 65,536 chars, which would
 * answer 422 `validation_error`; spec §7 wants 422 `workflow_insecure` with `details.rule`
 * `invalid_yaml` for an oversized workflow, so the size rule is applied by the use case and this
 * route only keeps a sane hard cap.
 */
export const CiExportBody = CiExportInput.extend({
  workflow: z.string().max(MAX_WORKFLOW_REQUEST_CHARS).nullish(),
});

/** `GET /ci/runs`: newest first, `limit` 1–200 (default 100). */
export const CiRunsQuery = z.object({
  agent_id: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(100),
});

/** `POST /ci/refresh`: a body-less POST arrives as null/undefined — treat it as {}. */
export const CiRefreshBody = z.preprocess((v) => v ?? {}, z.object({ agent_id: z.string().uuid().optional() }));

export const CiInstallationList = z.object({ installations: z.array(CiInstallation) });
export const CiRunList = z.object({ runs: z.array(CiRun) });
