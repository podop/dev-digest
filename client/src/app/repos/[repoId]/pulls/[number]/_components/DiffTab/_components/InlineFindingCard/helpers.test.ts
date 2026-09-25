import { describe, it, expect } from "vitest";
import type { FindingRecord, PrReviewComment } from "@devdigest/shared";
import { findPublishedComment, findingCommentBody, findingCommentInput, findingMarker } from "./helpers";

const FINDING: FindingRecord = {
  id: "f1",
  severity: "CRITICAL",
  category: "bug",
  title: "PUT route breaks the API contract",
  file: "internal/hsm/routes.go",
  start_line: 24,
  end_line: 26,
  rationale: "  The path moved from `/:id` to `/int/:id`.  ",
  suggestion: "Revert the route change.",
  confidence: 0.904,
  kind: "finding",
  trifecta_components: null,
  evidence: null,
  review_id: "r1",
  accepted_at: null,
  dismissed_at: null,
};

const comment = (id: number, body: string) => ({ id, body, html_url: `https://gh/c/${id}` }) as PrReviewComment;

describe("findingCommentBody", () => {
  it("renders header, rationale, suggested fix, confidence and the hidden marker", () => {
    expect(findingCommentBody(FINDING)).toBe(
      [
        "**[CRITICAL · bug] PUT route breaks the API contract**",
        "The path moved from `/:id` to `/int/:id`.",
        "**Suggested fix**\n\nRevert the route change.",
        "<sub>DevDigest · 90% confidence</sub>",
        "<!-- devdigest-finding:f1 -->",
      ].join("\n\n"),
    );
  });

  it("omits the suggested-fix section when there is none", () => {
    expect(findingCommentBody({ ...FINDING, suggestion: null })).not.toContain("Suggested fix");
    expect(findingCommentBody({ ...FINDING, suggestion: "  " })).not.toContain("Suggested fix");
  });
});

describe("findingCommentInput", () => {
  it("anchors on the finding's first line, new side", () => {
    expect(findingCommentInput(FINDING)).toMatchObject({ path: "internal/hsm/routes.go", line: 24, side: "RIGHT" });
  });
});

describe("findPublishedComment", () => {
  it("matches only the exact finding id", () => {
    const comments = [comment(1, `x ${findingMarker("f10")}`), comment(2, `y ${findingMarker("f1")}`)];
    expect(findPublishedComment(comments, "f1")?.id).toBe(2);
    expect(findPublishedComment(comments, "f2")).toBeUndefined();
    expect(findPublishedComment(undefined, "f1")).toBeUndefined();
  });
});
