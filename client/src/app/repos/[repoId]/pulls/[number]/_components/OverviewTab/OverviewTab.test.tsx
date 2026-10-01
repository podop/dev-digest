/* OverviewTab — the PR Brief card comes first, the Intent and Blast radius cards share
   the next row; the PR description stays below, full width. */
import { describe, it, expect, afterEach, vi } from "vitest";
import { renderWithProviders, screen, cleanup, waitFor } from "@/test/render";
import { mockFetch } from "@/test/fetch-mock";
import { OverviewTab } from "./OverviewTab";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));

afterEach(cleanup);

const ROUTES = {
  "GET /pulls/pr-1/brief": { brief: null, stale: false },
  "GET /pulls/pr-1/reviews": [],
  "GET /pulls/pr-1/runs/active": [],
  "GET /pulls/pr-1/intent": { intent: null, stale: false },
  "GET /pulls/pr-1/blast": { changed_symbols: [], downstream: [], summary: "s" },
  "GET /pulls/pr-1/history": { history: [] },
};

const renderOverview = () =>
  renderWithProviders(
    <OverviewTab
      prId="pr-1"
      repoId="r1"
      number="7"
      changedPaths={["src/a.ts"]}
      prBody="Body text"
      repoFullName="acme/api"
      headSha="abc"
    />,
  );

describe("OverviewTab", () => {
  it("renders the PR Brief card first, then Intent and Blast radius as siblings in one grid, then the description", async () => {
    mockFetch(ROUTES);
    renderOverview();

    const brief = await screen.findByRole("region", { name: "PR Brief" });
    const blast = await screen.findByRole("region", { name: "Blast radius" });
    const intentEmpty = await screen.findByRole("button", { name: /derive/i });
    const grid = blast.parentElement!;
    expect(grid.contains(intentEmpty)).toBe(true);
    expect(brief.nextElementSibling).toBe(grid);
    expect(grid.nextElementSibling).toContainElement(screen.getByText("Body text"));
  });

  it("watches the PR's active runs for live updates and never generates a brief on its own", async () => {
    const api = mockFetch(ROUTES);
    renderOverview();

    await screen.findByRole("region", { name: "PR Brief" });
    await waitFor(() => expect(api.requests("GET", "/pulls/pr-1/runs/active").length).toBeGreaterThan(0));
    expect(api.requests("POST")).toHaveLength(0);
  });
});
