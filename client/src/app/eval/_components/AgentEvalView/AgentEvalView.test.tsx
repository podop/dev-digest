/* AgentEvalView — one agent's eval history: tiles with deltas, regression banner, trend
   dots, runs table with selection of exactly two finished runs → Compare dialog, Run eval
   with progress, the picker, empty / error states and AC34. fetch is stubbed; the real
   hooks run. */
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import type { EvalAgentDashboard } from "@devdigest/shared";
import { renderWithProviders, screen, cleanup, within, pseudoMessages } from "@/test/render";
import { mockFetch, jsonResponse } from "@/test/fetch-mock";
import { pickOption } from "@/test/select";
import { AGENT } from "@/test/skill-fixtures";
import { makeCompare, makeRun } from "@/test/eval-fixtures";
import { strayText } from "@/test/pseudo";

const nav = vi.hoisted(() => ({ replace: vi.fn(), push: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => nav }));

import { AgentEvalView } from "./AgentEvalView";

beforeEach(() => {
  nav.replace.mockReset();
  nav.push.mockReset();
});
afterEach(cleanup);

const OTHER_AGENT = { ...AGENT, id: "ag2", name: "Perf Reviewer" };

const R1 = makeRun({ id: "r1", agent_version: 1, started_at: "2026-10-12T10:00:00.000Z", recall: 0.5, precision: 0.9, citation_accuracy: 0.9, cases_passed: 4 });
const R2 = makeRun({ id: "r2", agent_version: 2, started_at: "2026-10-13T10:00:00.000Z", recall: 0.6, precision: 0.9, citation_accuracy: 0.9, cases_passed: 5 });
const R3 = makeRun({ id: "r3", agent_version: 3, started_at: "2026-10-14T10:00:00.000Z", recall: 0.75, precision: 0.85, citation_accuracy: 0.9, cases_passed: 6 });

const dashboard = (over: Partial<EvalAgentDashboard> = {}): EvalAgentDashboard => ({
  agent_id: "ag1",
  cases_total: 8,
  latest: R3,
  previous: R2,
  trend: [R1, R2, R3],
  alert: null,
  ...over,
});

function stubThreeRuns(over: Partial<EvalAgentDashboard> = {}) {
  return mockFetch({
    "GET /agents": [AGENT, OTHER_AGENT],
    "GET /agents/ag1/eval/dashboard": dashboard(over),
    "GET /agents/ag1/eval-runs": { runs: [R3, R2, R1] },
    "GET /eval-runs/compare": makeCompare(),
  });
}

const checkbox = (run: { agent_version: number }) => screen.getByRole("checkbox", { name: new RegExp(`^Select run v${run.agent_version} `) });

describe("AgentEvalView", () => {
  it("shows the header, tiles with deltas, the regression banner, the trend and the runs", async () => {
    stubThreeRuns({ alert: { metrics: [{ metric: "precision", delta: -0.05 }] } });
    renderWithProviders(<AgentEvalView agentId="ag1" />);

    expect(await screen.findByRole("heading", { name: "Security Reviewer" })).toBeInTheDocument();
    expect(await screen.findByText("8 eval cases · gold set · 3 runs")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Configure eval cases →" })).toHaveAttribute("href", "/agents/ag1?tab=evals");
    expect(screen.getByRole("button", { name: "Run eval (8)" })).toBeEnabled();

    const tile = (name: string) => within(screen.getByRole("group", { name }));
    expect(tile("Recall").getByText("75%")).toBeInTheDocument();
    expect(tile("Recall").getByText("▲ +15pt")).toBeInTheDocument();
    expect(tile("Precision").getByText("▼ −5pt")).toBeInTheDocument();

    const banner = screen.getByRole("alert");
    expect(within(banner).getByText("Regression since the previous run")).toBeInTheDocument();
    expect(within(banner).getByText("Precision ▼ −5pt")).toBeInTheDocument();

    // One dot per run and metric, each with a tooltip (a single-point trend still shows).
    expect(screen.getAllByText(/^Recall \d+% · v\d/)).toHaveLength(3);
    expect(screen.getByText(/^Precision 85% · v3 · /)).toBeInTheDocument();
    expect(screen.getByRole("table", { name: "Eval runs" })).toBeInTheDocument();
  });

  it("enables Compare only with exactly two finished runs checked and opens the dialog A (older) → B (newer)", async () => {
    const api = stubThreeRuns();
    const { user } = renderWithProviders(<AgentEvalView agentId="ag1" />);
    await screen.findByRole("table", { name: "Eval runs" });
    const compare = screen.getByRole("button", { name: "Compare" });
    expect(compare).toBeDisabled();

    await user.click(checkbox(R3));
    expect(compare).toBeDisabled();
    await user.click(checkbox(R1));
    expect(compare).toBeEnabled();
    await user.click(checkbox(R2));
    expect(compare).toBeDisabled();
    await user.click(checkbox(R2));
    expect(compare).toBeEnabled();

    await user.click(compare);
    expect(await screen.findByText("Compare runs · v2 → v3")).toBeInTheDocument();
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(api.requests("GET", "/eval-runs/compare")[0]!.search).toBe("?a=r1&b=r3");
    expect(screen.getByText("1 case flipped")).toBeInTheDocument();

    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("switches agent through the picker by replacing the ?agent= URL", async () => {
    stubThreeRuns();
    const { user } = renderWithProviders(<AgentEvalView agentId="ag1" />);
    await screen.findByRole("table", { name: "Eval runs" });
    await pickOption(user, screen.getByRole("combobox", { name: "Agent" }), "Perf Reviewer");
    expect(nav.replace).toHaveBeenCalledWith("/eval?agent=ag2");
  });

  it("Run eval starts one run and shows 'Running x / N' while it executes", async () => {
    const running = makeRun({ id: "r9", status: "running", finished_at: null, cases_finished: 2, cases_passed: 0, recall: null, precision: null, citation_accuracy: null });
    const state = { started: false };
    const api = mockFetch({
      "GET /agents": [AGENT],
      "GET /agents/ag1/eval/dashboard": () => dashboard(),
      "GET /agents/ag1/eval-runs": () => ({ runs: state.started ? [running, R3, R2, R1] : [R3, R2, R1] }),
      "GET /eval-runs/r9": { run: running, results: [] },
      "POST /agents/ag1/eval-runs": () => {
        state.started = true;
        return jsonResponse(running, 202);
      },
    });
    const { user } = renderWithProviders(<AgentEvalView agentId="ag1" />);

    await user.click(await screen.findByRole("button", { name: "Run eval (8)" }));
    const progress = await screen.findByRole("button", { name: "Running 2 / 8" });
    expect(progress).toBeDisabled();
    expect(api.requests("POST", "/agents/ag1/eval-runs")).toHaveLength(1);
    // The running run is listed but cannot be selected for Compare.
    expect(screen.getAllByRole("checkbox", { name: /^Select run/ }).some((c) => (c as HTMLInputElement).disabled)).toBe(true);
  });

  it("shows 'No runs yet' and a disabled Run eval with a reason when the agent has no cases", async () => {
    mockFetch({
      "GET /agents": [AGENT],
      "GET /agents/ag1/eval/dashboard": dashboard({ cases_total: 0, latest: null, previous: null, trend: [] }),
      "GET /agents/ag1/eval-runs": { runs: [] },
    });
    renderWithProviders(<AgentEvalView agentId="ag1" />);
    expect(await screen.findByText(/No runs yet/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Run eval (0)" })).toBeDisabled();
    expect(screen.getByTitle("Create an eval case from a decided finding first")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Compare" })).toBeDisabled();
  });

  it("shows an error with Retry when the dashboard cannot be loaded", async () => {
    const api = mockFetch({
      "GET /agents": [AGENT],
      "GET /agents/ag1/eval/dashboard": jsonResponse({ error: { code: "not_found", message: "no agent" } }, 404),
      "GET /agents/ag1/eval-runs": { runs: [] },
    });
    const { user } = renderWithProviders(<AgentEvalView agentId="ag1" />);
    expect(await screen.findByText("Could not load the eval metrics")).toBeInTheDocument();
    api.on("GET /agents/ag1/eval/dashboard", dashboard());
    await user.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByRole("group", { name: "Recall" })).toBeInTheDocument();
  });

  it("AC34: every visible string comes from the message files (rendered with a pseudo bundle)", async () => {
    stubThreeRuns({ alert: { metrics: [{ metric: "precision", delta: -0.05 }] } });
    const { container, user } = renderWithProviders(<AgentEvalView agentId="ag1" />, { messages: pseudoMessages() });
    await screen.findByRole("table", { name: /eval\.runsTable\.caption/ });
    // Pseudo labels are identical per row; the table lists newest first (R3, R2, R1).
    const boxes = screen.getAllByRole("checkbox");
    await user.click(boxes[2]!);
    await user.click(boxes[0]!);
    await user.click(screen.getByRole("button", { name: /eval\.agentView\.compare/ }));
    await screen.findByTestId("prompt-diff");

    const data = ["Security Reviewer", "mock/reviewer", /^\$\d/, /\d{1,2}[/.]\d{1,2}[/.]\d{2,4}/, "You are a security reviewer.", "Flag every issue.", "Flag only high-confidence issues.", "stripe-key-leak", "sql-injection", "new-case"];
    expect(strayText(container, data)).toEqual([]);
    expect(strayText(document.body, data)).toEqual([]);
  });
});
