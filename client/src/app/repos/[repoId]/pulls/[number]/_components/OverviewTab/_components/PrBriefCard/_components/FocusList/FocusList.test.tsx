/* FocusList — numbered items in stored order; a click opens Files changed as a new history
   entry, or says inline that the file is not in the PR's diff. */
import { describe, it, expect, afterEach, vi } from "vitest";
import type { ReviewFocusItem } from "@devdigest/shared";
import { renderWithProviders, screen, cleanup, within } from "@/test/render";
import { useOpenInDiff } from "../../useOpenInDiff";
import { FocusList } from "./FocusList";

const nav = vi.hoisted(() => ({ push: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: nav.push }) }));

afterEach(() => {
  cleanup();
  nav.push.mockClear();
});

const LONG_PATH = `src/${"deep/".repeat(58)}file.t`; // 300 chars

const ITEMS: ReviewFocusItem[] = [
  { file: "src/a.ts", line: 12, reason: "Start here: the new limiter." },
  { file: "src/outside/caller.ts", line: 3, reason: "Caller outside the diff." },
];

function Harness({ items = ITEMS }: { items?: ReviewFocusItem[] }) {
  const links = useOpenInDiff({ repoId: "r1", number: "7", changedPaths: ["src/a.ts", "src/b.ts"] });
  return <FocusList items={items} {...links} />;
}

describe("FocusList", () => {
  it("numbers the items in stored order with a count badge, reachable by Tab with accessible names", async () => {
    const { user } = renderWithProviders(<Harness />);

    const heading = screen.getByRole("heading", { name: /Review focus/ });
    expect(within(heading.parentElement as HTMLElement).getByText("2")).toBeInTheDocument();
    const items = screen.getAllByRole("listitem");
    expect(items[0]).toHaveTextContent("1src/a.ts:12Start here: the new limiter.");
    expect(items[1]).toHaveTextContent("2src/outside/caller.ts:3");

    await user.tab();
    expect(screen.getByRole("button", { name: "src/a.ts:12" })).toHaveFocus();
    await user.tab();
    expect(screen.getByRole("button", { name: "src/outside/caller.ts:3" })).toHaveFocus();
  });

  it("pushes the diff deep-link for a changed file and stays put for a file outside the diff", async () => {
    const { user } = renderWithProviders(<Harness />);

    await user.click(screen.getByRole("button", { name: "src/outside/caller.ts:3" }));
    expect(nav.push).not.toHaveBeenCalled();
    expect(screen.getByText("File not in this PR's diff")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "src/a.ts:12" }));
    expect(nav.push).toHaveBeenCalledOnce();
    expect(nav.push).toHaveBeenCalledWith("/repos/r1/pulls/7?tab=diff&file=src%2Fa.ts&line=12");
    expect(screen.queryByText("File not in this PR's diff")).toBeNull();
  });

  it("keeps identical items apart: only the clicked one reports a file outside the diff", async () => {
    const twin: ReviewFocusItem = { file: "src/outside/caller.ts", line: 3, reason: "Caller outside the diff." };
    const { user } = renderWithProviders(<Harness items={[twin, { ...twin }]} />);

    await user.click(screen.getAllByRole("button", { name: "src/outside/caller.ts:3" })[1] as HTMLElement);
    expect(screen.getAllByText("File not in this PR's diff")).toHaveLength(1);
    expect(screen.getAllByRole("listitem")[1]).toHaveTextContent("File not in this PR's diff");
  });

  it("shows the empty text without a badge when there are no items", () => {
    renderWithProviders(<Harness items={[]} />);
    expect(screen.getByText("No focus items.")).toBeInTheDocument();
  });

  it("truncates a 300-char path with ellipsis and keeps the full path as its tooltip", () => {
    renderWithProviders(<Harness items={[{ file: LONG_PATH, line: 7, reason: "Long one." }]} />);

    expect(LONG_PATH).toHaveLength(300);
    const ref = screen.getByTitle(`${LONG_PATH}:7`);
    expect(ref).toHaveTextContent(`${LONG_PATH}:7`);
    expect(ref).toHaveStyle({ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: "100%" });
  });
});
