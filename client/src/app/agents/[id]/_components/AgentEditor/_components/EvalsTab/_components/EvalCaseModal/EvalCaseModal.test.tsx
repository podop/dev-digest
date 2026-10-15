import { describe, it, expect, afterEach, vi } from "vitest";
import { renderWithProviders, screen, cleanup, within, waitFor, pseudoMessages } from "@/test/render";
import { mockFetch, jsonResponse } from "@/test/fetch-mock";
import { makeCase } from "@/test/eval-fixtures";
import { strayText } from "@/test/pseudo";
import { EvalCaseModal } from "./EvalCaseModal";

afterEach(cleanup);

const HOSTILE = "<img src=x onerror=alert(1)>";

describe("EvalCaseModal", () => {
  it("shows the case read-only parts as literal text and saves only the edited fields", async () => {
    const evalCase = makeCase({
      input_diff: `+${HOSTILE}`,
      input_meta: { pr_title: HOSTILE, pr_description: HOSTILE, repo: "acme/shop", pr_number: 7, head_sha: null },
      expectation: { ...makeCase().expectation, title: HOSTILE },
      last_result: { run_id: "r1", status: "failed", ran_at: "2026-10-14T10:01:00.000Z" },
    });
    const api = mockFetch({ "PATCH /eval-cases/case1": { ...evalCase, name: "renamed" } });
    const onClose = vi.fn();
    const { user, container } = renderWithProviders(<EvalCaseModal evalCase={evalCase} onClose={onClose} onDelete={() => {}} />);

    const dialog = screen.getByRole("dialog");
    expect(container.querySelector("img")).toBeNull();
    expect(within(dialog).getAllByText(HOSTILE).length).toBeGreaterThanOrEqual(3);
    expect(within(dialog).getByText(/Failed ·/)).toBeInTheDocument();
    expect(within(dialog).getByText("Must find")).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Save" })).toBeDisabled();

    await user.type(within(dialog).getByLabelText("Name"), "!");
    await user.clear(within(dialog).getByLabelText("Notes"));
    await user.type(within(dialog).getByLabelText("Notes"), "because");
    await user.click(within(dialog).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(api.requests("PATCH", "/eval-cases/case1")[0]?.body).toEqual({ name: "stripe-key-leak!", notes: "because" });
  });

  it("blocks an inverted line range and keeps a server rejection inline", async () => {
    const evalCase = makeCase();
    mockFetch({ "PATCH /eval-cases/case1": jsonResponse({ error: { code: "validation_error", message: "bad" } }, 400) });
    const onClose = vi.fn();
    const { user } = renderWithProviders(<EvalCaseModal evalCase={evalCase} onClose={onClose} onDelete={() => {}} />);
    const dialog = screen.getByRole("dialog");

    const start = within(dialog).getByLabelText("Start line");
    await user.clear(start);
    await user.type(start, "99");
    expect(within(dialog).getByText("End line must be at least the start line")).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Save" })).toBeDisabled();

    await user.clear(start);
    await user.type(start, "11");
    await user.click(within(dialog).getByRole("button", { name: "Save" }));
    expect(await within(dialog).findByText(/These values were rejected/)).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
    expect(within(dialog).getByRole("button", { name: "Save" })).toBeEnabled();
  });

  it("hands over to the delete confirmation and closes with Cancel", async () => {
    mockFetch({});
    const onDelete = vi.fn();
    const onClose = vi.fn();
    const { user } = renderWithProviders(<EvalCaseModal evalCase={makeCase()} onClose={onClose} onDelete={onDelete} />);
    await user.click(screen.getByRole("button", { name: "Delete case" }));
    expect(onDelete).toHaveBeenCalledTimes(1);
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("takes every visible string from the message files", () => {
    mockFetch({});
    const evalCase = makeCase({ last_result: { run_id: "r1", status: "passed", ran_at: "2026-10-14T10:01:00.000Z" } });
    const { container } = renderWithProviders(<EvalCaseModal evalCase={evalCase} onClose={() => {}} onDelete={() => {}} />, { messages: pseudoMessages() });
    const e = evalCase;
    const allowed = [e.name, e.expectation.file, e.expectation.severity!, e.expectation.category!, e.expectation.title!, e.input_diff.trim(), e.input_meta.pr_title, e.input_meta.pr_description!, e.input_meta.repo, String(e.input_meta.pr_number), e.input_meta.head_sha!, e.expectation.start_line.toString(), e.expectation.end_line.toString()];
    expect(strayText(container, allowed)).toEqual([]);
  });
});
