/* RiskList — severity icon + text, Enter/Space/click expands the explanation, refs open
   Files changed at the parsed line (range kept). */
import { describe, it, expect, afterEach, vi } from "vitest";
import type { Risk } from "@devdigest/shared";
import { renderWithProviders, screen, cleanup } from "@/test/render";
import { useOpenInDiff } from "../../useOpenInDiff";
import { RiskList } from "./RiskList";

const nav = vi.hoisted(() => ({ push: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: nav.push }) }));

afterEach(() => {
  cleanup();
  nav.push.mockClear();
});

const LONG_PATH = `src/${"deep/".repeat(58)}file.t`; // 300 chars

const RISKS: Risk[] = [
  { kind: "security", title: "Limiter bypass", explanation: "Header can be spoofed.", severity: "high", file_refs: ["src/b.ts:40-52"] },
  { kind: "perf", title: "Hot path alloc", explanation: "Allocates per request.", severity: "medium", file_refs: ["src/a.ts:12", "src/gone.ts:5"] },
  { kind: "style", title: "Naming", explanation: "<i>Rename</i> it.", severity: "low", file_refs: [] },
];

function Harness({ risks = RISKS }: { risks?: Risk[] }) {
  const links = useOpenInDiff({ repoId: "r1", number: "7", changedPaths: ["src/a.ts", "src/b.ts"] });
  return <RiskList risks={risks} {...links} />;
}

describe("RiskList", () => {
  it("shows severity text and coloured icon per risk and toggles the explanation with Enter", async () => {
    const { user } = renderWithProviders(<Harness />);

    expect(screen.getByText("High")).toHaveStyle({ color: "var(--crit)" });
    expect(screen.getByText("Medium")).toHaveStyle({ color: "var(--warn)" });
    expect(screen.getByText("Low")).toHaveStyle({ color: "var(--text-muted)" });

    const row = screen.getByRole("button", { name: /Limiter bypass/ });
    expect(row).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText("Header can be spoofed.")).toBeNull();

    row.focus();
    await user.keyboard("{Enter}");
    expect(row).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("Header can be spoofed.")).toBeVisible();

    await user.keyboard("{Enter}");
    expect(row).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText("Header can be spoofed.")).toBeNull();

    // Space works too and the explanation is plain text, never markup.
    const low = screen.getByRole("button", { name: /Naming/ });
    low.focus();
    await user.keyboard(" ");
    expect(screen.getByText("<i>Rename</i> it.")).toBeInTheDocument();
  });

  it("expands two identical risks independently", async () => {
    const twin: Risk = { kind: "perf", title: "Same risk", explanation: "Same words.", severity: "low", file_refs: ["src/a.ts:1"] };
    const { user } = renderWithProviders(<Harness risks={[twin, { ...twin }]} />);

    const [first, second] = screen.getAllByRole("button", { name: /Same risk/ });
    await user.click(first as HTMLElement);
    expect(first).toHaveAttribute("aria-expanded", "true");
    expect(second).toHaveAttribute("aria-expanded", "false");
    expect(screen.getAllByText("Same words.")).toHaveLength(1);
  });

  it("opens a ref with its line range, and reports a ref outside the diff inline", async () => {
    const { user } = renderWithProviders(<Harness />);

    await user.click(screen.getByRole("button", { name: "src/b.ts:40-52" }));
    expect(nav.push).toHaveBeenCalledWith("/repos/r1/pulls/7?tab=diff&file=src%2Fb.ts&line=40-52");

    await user.click(screen.getByRole("button", { name: "src/gone.ts:5" }));
    expect(nav.push).toHaveBeenCalledOnce();
    expect(screen.getByText("File not in this PR's diff")).toBeInTheDocument();
  });

  it("reaches every row and ref by Tab and shows the no-risks text when empty", async () => {
    const { user, unmount } = renderWithProviders(<Harness />);
    const order = ["Limiter bypass", "src/b.ts:40-52", "Hot path alloc", "src/a.ts:12", "src/gone.ts:5", "Naming"];
    for (const name of order) {
      await user.tab();
      expect(screen.getByRole("button", { name: new RegExp(name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")) })).toHaveFocus();
    }
    unmount();

    renderWithProviders(<Harness risks={[]} />);
    expect(screen.getByText("No notable risks flagged.")).toBeInTheDocument();
  });

  it("truncates a 300-char path with ellipsis and keeps the full path as its tooltip", () => {
    const longRef = `${LONG_PATH}:7`;
    renderWithProviders(<Harness risks={[{ kind: "perf", title: "Deep path", explanation: "Long.", severity: "low", file_refs: [longRef] }]} />);

    expect(LONG_PATH).toHaveLength(300);
    const ref = screen.getByTitle(longRef);
    expect(ref).toHaveTextContent(longRef);
    expect(ref).toHaveStyle({ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: "100%" });
  });
});
