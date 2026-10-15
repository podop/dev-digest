/* AgentsOverview — rows with the latest finished run, sparkline and metrics; an agent
   with cases but no run shows "—" metrics. */
import { describe, it, expect, afterEach } from "vitest";
import type { EvalAgentOverview } from "@devdigest/shared";
import { renderWithProviders, screen, cleanup, within } from "@/test/render";
import { makeRun } from "@/test/eval-fixtures";
import { AgentsOverview } from "./AgentsOverview";

afterEach(cleanup);

const spark = (recall: number | null, i: number) => ({ run_id: `r${i}`, recall, precision: 0.8, citation_accuracy: 0.9 });

const AGENTS: EvalAgentOverview[] = [
  {
    agent_id: "ag1",
    name: "Security Reviewer",
    model: "gpt-4.1",
    cases_total: 8,
    latest: makeRun({ agent_version: 7, cases_passed: 6, cases_total: 8, recall: 0.75, precision: 0.8, citation_accuracy: 0.9 }),
    sparkline: [spark(0.5, 1), spark(0.6, 2), spark(0.75, 3)],
  },
  { agent_id: "ag2", name: "Perf <img src=x onerror=alert(1)>", model: "claude", cases_total: 1, latest: null, sparkline: [] },
];

describe("AgentsOverview", () => {
  it("lists agents with model, last run, pass count, sparkline and whole-percent metrics; no run shows dashes", () => {
    const { container } = renderWithProviders(<AgentsOverview agents={AGENTS} />);
    const rows = screen.getAllByTestId("eval-agent-row");
    expect(rows).toHaveLength(2);

    const first = within(rows[0]!);
    expect(first.getByRole("link", { name: "Security Reviewer" })).toHaveAttribute("href", "/eval?agent=ag1");
    expect(first.getByText("gpt-4.1")).toBeInTheDocument();
    expect(first.getByText(/^v7 · /)).toBeInTheDocument();
    expect(first.getByText("6 / 8")).toBeInTheDocument();
    expect(first.getByText("75%")).toBeInTheDocument();
    expect(first.getByText("80%")).toBeInTheDocument();
    expect(first.getByText("90%")).toBeInTheDocument();
    expect(first.getByRole("img", { name: "Recall trend" })).toBeInTheDocument();

    const second = within(rows[1]!);
    expect(second.getByText("never run")).toBeInTheDocument();
    expect(second.getAllByText("—")).toHaveLength(4);
    expect(second.queryByRole("img", { name: "Recall trend" })).not.toBeInTheDocument();
    // Agent names are plain text (NFR7).
    expect(second.getByRole("link", { name: "Perf <img src=x onerror=alert(1)>" })).toBeInTheDocument();
    expect(container.querySelector("img")).toBeNull();
  });
});
