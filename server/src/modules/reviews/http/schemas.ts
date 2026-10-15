import { z } from 'zod';
import {
  ActiveRun,
  AgentRunEstimate,
  FindingRecord,
  MultiAgentRun,
  MultiAgentRunSummary,
  ReviewRecord,
  ReviewRunResponse,
  RunRequest,
  RunSummary,
  RunTrace,
} from '@devdigest/shared';

/**
 * Request/response schemas of the reviews routes. Responses come from the
 * @devdigest/shared contracts the client types against, so the zod serializer
 * validates the output and strips nothing the client reads.
 */

/** A body-less POST arrives as null/undefined — treat it as {}. */
export const RunReviewBody = z.preprocess(
  (v) => v ?? {},
  // The contract's `.min(1).max(20)` would answer 422; the service enforces the
  // 1–20 size (and "exactly one option") as 400 invalid_run_request instead.
  RunRequest.extend({ agentIds: z.array(z.string().uuid()).optional() }),
);

export const OkResponse = z.object({ ok: z.boolean() });

export const FindingActionResponse = z.object({ finding: FindingRecord });

export const ReviewRunResponseSchema = ReviewRunResponse;
export const ActiveRunsResponse = z.array(ActiveRun);
export const RunHistoryResponse = z.array(RunSummary);
export const RunTraceResponse = RunTrace;
export const ReviewsResponse = z.array(ReviewRecord);

export const MultiAgentRunResponse = MultiAgentRun;
export const MultiAgentRunsResponse = z.array(MultiAgentRunSummary);
export const RunEstimatesResponse = z.array(AgentRunEstimate);

/** `limit` is range-checked by the service (400), not here (a schema failure would be 422). */
export const MultiAgentRunsQuery = z.object({ limit: z.coerce.number().int().optional() });

/** Learn: the finding (with memory_id) and the id the client hook already types. */
export const LearnResponse = z.object({ finding: FindingRecord, memoryId: z.string() });
