/* PriorPrs — count badge, expandable rows with GitHub links; hidden when empty or on error. */
import { describe, it, expect, afterEach } from "vitest";
import type { PrHistory } from "@devdigest/shared";
import { renderWithProviders, screen, cleanup, within, waitFor, act } from "@/test/render";
import { mockFetch, jsonResponse } from "@/test/fetch-mock";
import { PriorPrs } from "./PriorPrs";
import { FILES_SHOWN } from "./constants";

const HISTORY: PrHistory = {
  history: [
    {
      pr_number: 410,
      title: "Newer limiter",
      merged_at: "2026-02-10T12:00:00Z",
      author: "bob",
      files_overlap: ["src/other.ts", "src/rl.ts"],
      notes: "",
    },
    { pr_number: 401, title: "Older limiter", merged_at: "2026-02-01T12:00:00Z", author: "ann", files_overlap: ["src/rl.ts"], notes: "" },
  ],
};

afterEach(cleanup);

describe("PriorPrs", () => {
  it("shows a count badge, then lists each PR with its link, author, date and overlapping files", async () => {
    mockFetch({ "GET /pulls/pr-1/history": HISTORY });
    const { user } = renderWithProviders(<PriorPrs prId="pr-1" repoFullName="acme/api" />);

    const toggle = await screen.findByRole("button", { name: /Prior PRs touching these files/ });
    expect(within(toggle).getByText("2")).toBeInTheDocument();
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("link", { name: "Newer limiter" })).toBeNull();

    await user.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    const link = screen.getByRole("link", { name: "Newer limiter" });
    expect(link).toHaveAttribute("href", "https://github.com/acme/api/pull/410");
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", expect.stringContaining("noopener"));
    expect(screen.getByText("#410")).toBeInTheDocument();
    expect(screen.getByText(/by bob/)).toBeInTheDocument();
    const files = screen.getByRole("list", { name: "2 overlapping files" });
    expect(within(files).getAllByRole("listitem").map((li) => li.textContent)).toEqual(["src/other.ts", "src/rl.ts"]);
    expect(screen.getByRole("list", { name: "1 overlapping file" })).toBeInTheDocument();
  });

  it("caps the overlapping files and summarises the rest, keeping the full list in a tooltip", async () => {
    const files = Array.from({ length: FILES_SHOWN + 29 }, (_, i) => `src/f${i}.ts`);
    mockFetch({
      "GET /pulls/pr-1/history": {
        history: [{ pr_number: 1, title: "Big refactor", merged_at: "2026-02-01T12:00:00Z", author: "ann", files_overlap: files, notes: "" }],
      },
    });
    const { user } = renderWithProviders(<PriorPrs prId="pr-1" repoFullName="acme/api" />);
    await user.click(await screen.findByRole("button", { name: /Prior PRs touching these files/ }));

    const list = screen.getByRole("list", { name: `${files.length} overlapping files` });
    const items = within(list).getAllByRole("listitem");
    expect(items.slice(0, FILES_SHOWN).map((li) => li.textContent)).toEqual(files.slice(0, FILES_SHOWN));
    expect(items).toHaveLength(FILES_SHOWN + 1);
    const more = screen.getByText("+29 more files");
    expect(more).toHaveAttribute("title", files.join("\n"));
    expect(screen.queryByText(files[FILES_SHOWN]!)).toBeNull();
  });

  it("renders nothing for an empty history", async () => {
    const api = mockFetch({ "GET /pulls/pr-1/history": { history: [] } });
    renderWithProviders(<PriorPrs prId="pr-1" repoFullName="acme/api" />);
    await waitFor(() => expect(api.requests("GET", "/pulls/pr-1/history")).toHaveLength(1));
    await act(async () => {});
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.queryByText(/Prior PRs touching these files/)).toBeNull();
  });

  it("renders nothing when the request fails", async () => {
    const api = mockFetch({ "GET /pulls/pr-1/history": jsonResponse({ error: { code: "boom", message: "x" } }, 500) });
    renderWithProviders(<PriorPrs prId="pr-1" repoFullName="acme/api" />);
    await waitFor(() => expect(api.requests("GET", "/pulls/pr-1/history")).toHaveLength(1));
    await act(async () => {});
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.queryByText(/Prior PRs touching these files/)).toBeNull();
  });
});
