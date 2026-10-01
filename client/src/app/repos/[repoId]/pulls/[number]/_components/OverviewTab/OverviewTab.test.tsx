/* OverviewTab — the Intent and Blast radius cards share one row; the PR
   description stays below, full width. */
import { describe, it, expect, afterEach } from "vitest";
import { renderWithProviders, screen, cleanup } from "@/test/render";
import { mockFetch } from "@/test/fetch-mock";
import { OverviewTab } from "./OverviewTab";

afterEach(cleanup);

describe("OverviewTab", () => {
  it("renders the Intent and Blast radius cards as siblings in one grid, then the description", async () => {
    mockFetch({
      "GET /pulls/pr-1/intent": { intent: null, stale: false },
      "GET /pulls/pr-1/blast": { changed_symbols: [], downstream: [], summary: "s" },
      "GET /pulls/pr-1/history": { history: [] },
    });
    renderWithProviders(<OverviewTab prId="pr-1" repoId="r1" prBody="Body text" repoFullName="acme/api" headSha="abc" />);

    const blast = await screen.findByRole("region", { name: "Blast radius" });
    const intentEmpty = await screen.findByRole("button", { name: /derive/i });
    const grid = blast.parentElement!;
    expect(grid.contains(intentEmpty)).toBe(true);
    expect(grid.nextElementSibling).toContainElement(screen.getByText("Body text"));
  });
});
