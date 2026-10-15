import { afterEach, describe, expect, it, vi } from "vitest";
import type { EvalRunDetail, EvalRunSummary } from "@devdigest/shared";
import { renderHookWithProviders, cleanup, act, waitFor } from "@/test/render";
import { mockFetch, jsonResponse } from "@/test/fetch-mock";
import { evalKeys, prKeys } from "./keys";
import { EVAL_RUN_POLL_MS, useCreateEvalCase, useEvalRun } from "./evals";

afterEach(() => {
  vi.useRealTimers();
  cleanup();
});

function makeRun(overrides: Partial<EvalRunSummary> = {}): EvalRunSummary {
  return {
    id: "run1",
    agent_id: "ag1",
    agent_version: 3,
    model: "mock/reviewer",
    status: "running",
    started_at: "2026-10-14T10:00:00.000Z",
    finished_at: null,
    cases_total: 8,
    cases_finished: 0,
    cases_passed: 0,
    cases_errored: 0,
    recall: null,
    precision: null,
    citation_accuracy: null,
    unlabeled_findings: 0,
    cost_usd: null,
    duration_ms: null,
    error: null,
    ...overrides,
  };
}

const detail = (run: EvalRunSummary): EvalRunDetail => ({ run, results: [] });

describe("useEvalRun", () => {
  it("polls every 2 s while running, then stops and invalidates the agent's eval queries", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const responses = [
      detail(makeRun({ cases_finished: 2 })),
      detail(makeRun({ cases_finished: 5 })),
      detail(makeRun({ status: "completed", cases_finished: 8, cases_passed: 6, recall: 0.75, finished_at: "2026-10-14T10:01:00.000Z" })),
    ];
    let calls = 0;
    const api = mockFetch({ "GET /eval-runs/run1": () => responses[Math.min(calls++, responses.length - 1)] });
    const { result, queryClient } = renderHookWithProviders(() => useEvalRun("run1"));
    queryClient.setQueryData(evalKeys.runs("ag1", 20), { runs: [] });
    queryClient.setQueryData(evalKeys.overview(), { agents: [], recent_runs: [] });

    await waitFor(() => expect(result.current.data?.run.cases_finished).toBe(2));
    await act(() => vi.advanceTimersByTimeAsync(EVAL_RUN_POLL_MS));
    await waitFor(() => expect(result.current.data?.run.cases_finished).toBe(5));
    expect(queryClient.getQueryState(evalKeys.runs("ag1", 20))?.isInvalidated).toBe(false);

    await act(() => vi.advanceTimersByTimeAsync(EVAL_RUN_POLL_MS));
    await waitFor(() => expect(result.current.data?.run.status).toBe("completed"));
    await waitFor(() => expect(queryClient.getQueryState(evalKeys.runs("ag1", 20))?.isInvalidated).toBe(true));
    expect(queryClient.getQueryState(evalKeys.overview())?.isInvalidated).toBe(true);

    // Terminal status: no further polling.
    const fetched = api.requests("GET", "/eval-runs/run1").length;
    expect(fetched).toBe(3);
    await act(() => vi.advanceTimersByTimeAsync(EVAL_RUN_POLL_MS * 3));
    expect(api.requests("GET", "/eval-runs/run1")).toHaveLength(fetched);
  });
});

describe("useCreateEvalCase", () => {
  it("treats a 409 eval_case_exists as success and returns the existing case id", async () => {
    const api = mockFetch({
      "POST /findings/f1/eval-case": jsonResponse(
        { error: { code: "eval_case_exists", message: "exists", details: { case_id: "case9" } } },
        409,
      ),
    });
    const { result, queryClient } = renderHookWithProviders(() => useCreateEvalCase("pr1"));
    queryClient.setQueryData(prKeys.reviews("pr1"), []);

    act(() => result.current.mutate({ findingId: "f1", agentId: "ag1" }));
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual({ created: false, caseId: "case9" });
    expect(api.requests("POST", "/findings/f1/eval-case")).toHaveLength(1);
    await waitFor(() => expect(queryClient.getQueryState(prKeys.reviews("pr1"))?.isInvalidated).toBe(true));
  });

  it("surfaces other errors (422 finding_undecided) on the mutation for inline display", async () => {
    mockFetch({
      "POST /findings/f1/eval-case": jsonResponse({ error: { code: "finding_undecided", message: "Accept or dismiss first" } }, 422),
    });
    const { result } = renderHookWithProviders(() => useCreateEvalCase("pr1"));

    act(() => result.current.mutate({ findingId: "f1", agentId: "ag1" }));
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.error).toMatchObject({ status: 422, code: "finding_undecided" });
  });
});
