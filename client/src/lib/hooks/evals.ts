/* hooks/evals.ts — React Query hooks of the eval pipeline (specs/eval-pipeline.md §7):
   turn a decided finding into an agent eval case, run an agent's case set in the
   background, list / compare runs, both dashboards. Mutations own invalidation. */
"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  AgentEvalCase,
  AgentEvalCaseList,
  AgentEvalCaseUpdateInput,
  EvalAgentDashboard,
  EvalCompare,
  EvalOverview,
  EvalRunAllResponse,
  EvalRunDetail,
  EvalRunList,
  EvalRunSummary,
} from "@devdigest/shared";
import { api, ApiError } from "../api";
import { evalKeys, prKeys } from "./keys";

/** ApiError code of a second POST /findings/:id/eval-case for the same finding. */
export const EVAL_CASE_EXISTS_CODE = "eval_case_exists";

/** Poll period of a running eval run (cases_finished moves while it executes). */
export const EVAL_RUN_POLL_MS = 2000;

const DEFAULT_RUNS_LIMIT = 20;

// ---- Cases ----

export function useEvalCases(agentId: string | null | undefined) {
  return useQuery({
    queryKey: evalKeys.cases(agentId),
    queryFn: () => api.get<AgentEvalCaseList>(`/agents/${agentId}/eval-cases`),
    enabled: !!agentId,
    select: (data) => data.cases,
  });
}

export interface CreateEvalCaseInput {
  findingId: string;
  agentId: string;
}

/** Result of creating a case; `created` is false when the finding already had one (409). */
export interface CreateEvalCaseResult {
  created: boolean;
  /** Case id — from the 201 body or the 409 details; null if a 409 carried none. */
  caseId: string | null;
}

function caseIdFromConflict(err: ApiError): string | null {
  const id = (err.details as { case_id?: unknown } | null | undefined)?.case_id;
  return typeof id === "string" ? id : null;
}

/** POST /findings/:id/eval-case. A 409 eval_case_exists is a success (double click / second tab).
 *  The caller shows 404/422 inline (`error`), so the global error toast stays quiet. */
export function useCreateEvalCase(prId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ findingId }: CreateEvalCaseInput): Promise<CreateEvalCaseResult> => {
      try {
        const created = await api.post<AgentEvalCase>(`/findings/${findingId}/eval-case`);
        return { created: true, caseId: created.id };
      } catch (err) {
        if (err instanceof ApiError && err.code === EVAL_CASE_EXISTS_CODE) {
          return { created: false, caseId: caseIdFromConflict(err) };
        }
        throw err;
      }
    },
    meta: { quietErrorCodes: ["*"] },
    onSuccess: (_res, { agentId }) => {
      qc.invalidateQueries({ queryKey: evalKeys.agent(agentId) });
      qc.invalidateQueries({ queryKey: evalKeys.overview() });
    },
    onSettled: () => {
      // The finding row carries eval_case_id (FR19).
      qc.invalidateQueries({ queryKey: prKeys.reviews(prId) });
    },
  });
}

export interface UpdateEvalCaseVars {
  id: string;
  patch: AgentEvalCaseUpdateInput;
}

/** PATCH /eval-cases/:id. The modal shows its save error inline, so no global toast. */
export function useUpdateEvalCase() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, patch }: UpdateEvalCaseVars) => api.patch<AgentEvalCase>(`/eval-cases/${id}`, patch),
    meta: { quietErrorCodes: ["*"] },
    onSuccess: (updated) => {
      qc.invalidateQueries({ queryKey: evalKeys.cases(updated.agent_id) });
    },
  });
}

export interface DeleteEvalCaseVars {
  id: string;
  agentId: string;
}

/** DELETE /eval-cases/:id. */
export function useDeleteEvalCase() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id }: DeleteEvalCaseVars) => api.del<void>(`/eval-cases/${id}`),
    onSuccess: (_res, { agentId }) => {
      qc.invalidateQueries({ queryKey: evalKeys.agent(agentId) });
      qc.invalidateQueries({ queryKey: evalKeys.overview() });
    },
  });
}

// ---- Runs ----

export function useEvalRuns(agentId: string | null | undefined, limit: number = DEFAULT_RUNS_LIMIT) {
  return useQuery({
    queryKey: evalKeys.runs(agentId, limit),
    queryFn: () => api.get<EvalRunList>(`/agents/${agentId}/eval-runs?limit=${limit}`),
    enabled: !!agentId,
    select: (data) => data.runs,
  });
}

/** One run with its per-case results. Polls every 2 s while the run is `running`; the poll
 *  that sees it finish invalidates everything its agent shows (runs, cases, dashboards). */
export function useEvalRun(runId: string | null | undefined) {
  const qc = useQueryClient();
  const key = evalKeys.run(runId);
  return useQuery({
    queryKey: key,
    queryFn: async () => {
      const previous = qc.getQueryData<EvalRunDetail>(key);
      const detail = await api.get<EvalRunDetail>(`/eval-runs/${runId}`);
      if (previous?.run.status === "running" && detail.run.status !== "running") {
        qc.invalidateQueries({ queryKey: evalKeys.agent(detail.run.agent_id) });
        qc.invalidateQueries({ queryKey: evalKeys.overview() });
      }
      return detail;
    },
    enabled: !!runId,
    refetchInterval: (query) => (query.state.data?.run.status === "running" ? EVAL_RUN_POLL_MS : false),
  });
}

/** POST /agents/:id/eval-runs (202, runs in the background). Errors (409 eval_run_active,
 *  422 no_eval_cases, 429) go to the global toast; a 409 also refreshes the runs so the
 *  already-running run shows up. */
export function useStartEvalRun(agentId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.post<EvalRunSummary>(`/agents/${agentId}/eval-runs`),
    onSuccess: (run) => {
      qc.setQueryData<EvalRunDetail>(evalKeys.run(run.id), { run, results: [] });
      qc.invalidateQueries({ queryKey: evalKeys.agent(agentId) });
      qc.invalidateQueries({ queryKey: evalKeys.overview() });
    },
    onError: (err) => {
      if (err instanceof ApiError && err.status === 409) {
        qc.invalidateQueries({ queryKey: evalKeys.agent(agentId) });
      }
    },
  });
}

/** POST /eval-runs/run-all — starts every agent that has cases and no running run. */
export function useRunAllEvals() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.post<EvalRunAllResponse>("/eval-runs/run-all"),
    onSuccess: () => qc.invalidateQueries({ queryKey: evalKeys.all }),
  });
}

// ---- Compare + dashboards ----

/** GET /eval-runs/compare?a=&b= — enabled once both run ids are chosen. */
export function useEvalCompare(a: string | null | undefined, b: string | null | undefined) {
  return useQuery({
    queryKey: evalKeys.compare(a, b),
    queryFn: () => api.get<EvalCompare>(`/eval-runs/compare?a=${encodeURIComponent(a ?? "")}&b=${encodeURIComponent(b ?? "")}`),
    enabled: !!a && !!b,
  });
}

/** GET /eval/dashboard — agents with latest metrics + the 20 most recent runs. */
export function useEvalOverview() {
  return useQuery({
    queryKey: evalKeys.overview(),
    queryFn: () => api.get<EvalOverview>("/eval/dashboard"),
  });
}

/** GET /agents/:id/eval/dashboard — latest/previous run, trend, regression alert. */
export function useEvalAgentDashboard(agentId: string | null | undefined) {
  return useQuery({
    queryKey: evalKeys.dashboard(agentId),
    queryFn: () => api.get<EvalAgentDashboard>(`/agents/${agentId}/eval/dashboard`),
    enabled: !!agentId,
  });
}
