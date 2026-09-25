import type { FindingRecord, PrCommentInput, PrReviewComment } from "@devdigest/shared";

/**
 * Hidden tag at the end of a posted comment. GitHub (and our <Markdown>) don't
 * render HTML comments, and the closing ` -->` keeps `f1` from matching `f10`,
 * so the live comment list tells which findings were already posted.
 */
export function findingMarker(findingId: string): string {
  return `<!-- devdigest-finding:${findingId} -->`;
}

/** The GitHub comment already posted for this finding, if any. */
export function findPublishedComment(
  comments: readonly PrReviewComment[] | undefined,
  findingId: string,
): PrReviewComment | undefined {
  const marker = findingMarker(findingId);
  return comments?.find((c) => c.body.includes(marker));
}

/** Markdown body of the review comment a finding is posted as. */
export function findingCommentBody(
  f: Pick<FindingRecord, "id" | "severity" | "category" | "title" | "rationale" | "suggestion" | "confidence">,
): string {
  const parts = [`**[${f.severity} · ${f.category}] ${f.title}**`, f.rationale.trim()];
  if (f.suggestion?.trim()) parts.push(`**Suggested fix**\n\n${f.suggestion.trim()}`);
  parts.push(`<sub>DevDigest · ${Math.round(f.confidence * 100)}% confidence</sub>`, findingMarker(f.id));
  return parts.join("\n\n");
}

/** Inline comment on the finding's first line — the line its card sits under in the diff. */
export function findingCommentInput(f: FindingRecord): PrCommentInput {
  return { path: f.file, line: f.start_line, side: "RIGHT", body: findingCommentBody(f) };
}
