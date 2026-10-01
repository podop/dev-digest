/* ContextView — document list (names, folders, types, summary), filter, row
   selection via ?doc=, markdown preview with "Used by N agents", and the
   empty / not-cloned / error states, with the real hooks over a stubbed API.
   AppShell is a passthrough. */
import type React from "react";
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import type { ContextDocPreview, ContextList } from "@devdigest/shared";
import { renderWithProviders, screen, cleanup, within } from "@/test/render";
import { jsonResponse, mockFetch } from "@/test/fetch-mock";
import { RepoProvider } from "@/lib/repo-context";

const replace = vi.hoisted(() => vi.fn());
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace }),
  usePathname: () => "/repos/r1/context",
}));
vi.mock("@/components/app-shell", () => ({
  AppShell: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

import { ContextView } from "./ContextView";

const REPO = {
  id: "r1",
  workspace_id: "w1",
  owner: "acme",
  name: "payments-api",
  full_name: "acme/payments-api",
  default_branch: "main",
  clone_path: "/clones/acme/payments-api",
  last_polled_at: null,
  created_by: null,
};

const LIST: ContextList = {
  clone_status: "ready",
  globs: ["**/{specs,docs,insights}/**/*.md"],
  tokens_total: 1234,
  docs: [
    { path: "docs/architecture.md", name: "architecture.md", doc_type: "docs", size_bytes: 400, tokens: 100, updated_at: "2026-10-01T00:00:00.000Z", used_by: 2 },
    { path: "insights/notes/db.md", name: "db.md", doc_type: "insights", size_bytes: 800, tokens: 200, updated_at: "2026-10-01T00:00:00.000Z", used_by: 0 },
    { path: "specs/public-api.md", name: "public-api.md", doc_type: "specs", size_bytes: 3736, tokens: 934, updated_at: "2026-10-01T00:00:00.000Z", used_by: 3 },
  ],
};

const PREVIEW: ContextDocPreview = {
  path: "specs/public-api.md",
  name: "public-api.md",
  doc_type: "specs",
  content: "# Public API — PRD\n\nAll endpoints MUST be rate-limited.\n\n<script>alert(1)</script>\n",
  tokens: 934,
  size_bytes: 3736,
  used_by: 3,
  used_by_agents: [
    { id: "ag1", name: "Security Reviewer", via: "direct" },
    { id: "ag2", name: "General Reviewer", via: "skill", skill_name: "api-rules" },
  ],
};

function setup(list: ContextList | Response = LIST, preview: ContextDocPreview | Response = PREVIEW) {
  return mockFetch({
    "GET /repos": [REPO],
    "GET /repos/r1/context": list,
    "GET /repos/r1/context/doc": preview,
  });
}

beforeEach(() => {
  replace.mockReset();
});
afterEach(cleanup);

describe("ContextView", () => {
  it("lists the documents with folder, type and the totals; filters; selecting a row updates ?doc=", async () => {
    setup();
    const { user } = renderWithProviders(<ContextView repoId="r1" doc={null} />);

    const list = await screen.findByRole("list", { name: "Documents" });
    expect(within(list).getAllByRole("listitem")).toHaveLength(3);
    expect(within(list).getByText("db.md")).toBeInTheDocument();
    expect(within(list).getByText("insights/notes/")).toBeInTheDocument();
    expect(within(list).getByText("specs")).toBeInTheDocument();
    expect(screen.getByText("3 docs · ≈ 1,234 tokens total")).toBeInTheDocument();
    expect(screen.getByText("Select a document")).toBeInTheDocument();

    await user.type(screen.getByRole("textbox", { name: "Filter documents" }), "api");
    expect(within(list).getAllByRole("listitem")).toHaveLength(1);
    await user.clear(screen.getByRole("textbox", { name: "Filter documents" }));
    await user.type(screen.getByRole("textbox", { name: "Filter documents" }), "zzz");
    expect(screen.getByText("No documents match your filter.")).toBeInTheDocument();
    await user.clear(screen.getByRole("textbox", { name: "Filter documents" }));

    await user.click(screen.getByRole("button", { name: /public-api\.md/ }));
    expect(replace).toHaveBeenCalledWith("/repos/r1/context?doc=specs%2Fpublic-api.md", { scroll: false });
  });

  it("renders the selected document as markdown, with Used by N agents; raw HTML stays text", async () => {
    const api = setup();
    renderWithProviders(<ContextView repoId="r1" doc="specs/public-api.md" />);

    expect(await screen.findByRole("heading", { name: "Public API — PRD" })).toBeInTheDocument();
    expect(screen.getByText("Used by 3 agents")).toHaveAttribute(
      "title",
      "Security Reviewer (attached directly)\nGeneral Reviewer (via skill api-rules)",
    );
    expect(screen.getByText("≈ 934 tokens")).toBeInTheDocument();
    // View-only: no edit / create / upload controls.
    expect(screen.queryByRole("button", { name: /edit|upload|new/i })).not.toBeInTheDocument();
    // <script> shows up as text, never as an element.
    expect(screen.getByText(/<script>alert\(1\)<\/script>/)).toBeInTheDocument();
    expect(document.querySelector("script")).toBeNull();
    expect(api.requests("GET", "/repos/r1/context/doc")[0]?.search).toBe("?path=specs%2Fpublic-api.md");
  });

  it("shows a message for a document that is gone or too large", async () => {
    setup(LIST, jsonResponse({ error: { code: "doc_too_large", message: "big" } }, 413));
    renderWithProviders(<ContextView repoId="r1" doc="specs/big.md" />);
    expect(await screen.findByText("This document is larger than 256 KB and cannot be previewed.")).toBeInTheDocument();
  });

  it("shows the empty state naming the globs and the not-cloned notice", async () => {
    setup({ ...LIST, docs: [], tokens_total: 0 });
    const first = renderWithProviders(<ContextView repoId="r1" doc={null} />);
    expect(await screen.findByText("No documents match **/{specs,docs,insights}/**/*.md")).toBeInTheDocument();
    first.unmount();

    setup({ clone_status: "not_cloned", globs: LIST.globs, docs: [], tokens_total: 0 });
    renderWithProviders(<ContextView repoId="r1" doc={null} />);
    expect(await screen.findByText("Repository is not cloned yet")).toBeInTheDocument();
  });

  it("shows the error state and retries the list", async () => {
    const api = setup(jsonResponse({ error: { code: "internal", message: "boom" } }, 500));
    const { user } = renderWithProviders(<ContextView repoId="r1" doc={null} />);

    expect(await screen.findByText("Couldn’t load documents")).toBeInTheDocument();
    api.on("GET /repos/r1/context", LIST);
    await user.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByRole("list", { name: "Documents" })).toBeInTheDocument();
  });

  it("refresh refetches the list", async () => {
    const api = setup();
    const { user } = renderWithProviders(<ContextView repoId="r1" doc={null} />);
    await screen.findByRole("list", { name: "Documents" });

    await user.click(screen.getByRole("button", { name: "Refresh documents" }));
    await vi.waitFor(() => expect(api.requests("GET", "/repos/r1/context")).toHaveLength(2));
  });

  describe("under the real RepoProvider (it loads GET /repos)", () => {
    it("a known repo renders its documents once the repos list has loaded", async () => {
      setup();
      renderWithProviders(
        <RepoProvider>
          <ContextView repoId="r1" doc={null} />
        </RepoProvider>,
      );
      expect(await screen.findByRole("list", { name: "Documents" })).toBeInTheDocument();
      expect(screen.queryByText("No repo selected")).not.toBeInTheDocument();
    });

    it("a stale :repoId shows the 'No repo selected' state instead of the document list", async () => {
      const api = setup();
      api.on("GET /repos/gone/context", jsonResponse({ error: { code: "repo_not_found", message: "nope" } }, 404));
      renderWithProviders(
        <RepoProvider>
          <ContextView repoId="gone" doc={null} />
        </RepoProvider>,
      );
      expect(await screen.findByText("No repo selected")).toBeInTheDocument();
      expect(screen.queryByRole("list", { name: "Documents" })).not.toBeInTheDocument();
      expect(screen.queryByText("Couldn’t load documents")).not.toBeInTheDocument();
    });
  });
});
