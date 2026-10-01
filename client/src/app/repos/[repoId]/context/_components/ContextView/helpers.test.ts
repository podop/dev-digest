import { describe, it, expect } from "vitest";
import type { ContextDoc } from "@devdigest/shared";
import { contextHref, filterDocs, parseContextSearch, splitPath } from "./helpers";

const doc = (path: string): ContextDoc => ({
  path,
  name: path.split("/").pop() ?? path,
  doc_type: "docs",
  size_bytes: 10,
  tokens: 3,
  updated_at: "2026-10-01T00:00:00.000Z",
  used_by: 0,
});

describe("context helpers", () => {
  it("parses ?doc= and builds the screen URL back", () => {
    expect(parseContextSearch({})).toEqual({ doc: null });
    expect(parseContextSearch({ doc: "" })).toEqual({ doc: null });
    expect(parseContextSearch({ doc: ["docs/a.md", "docs/b.md"] })).toEqual({ doc: "docs/a.md" });
    expect(contextHref("r 1", null)).toBe("/repos/r%201/context");
    expect(contextHref("r1", "docs/a b.md")).toBe("/repos/r1/context?doc=docs%2Fa+b.md");
  });

  it("splits a path into file name and folder", () => {
    expect(splitPath("docs/api/users.md")).toEqual({ name: "users.md", folder: "docs/api/" });
    expect(splitPath("README.md")).toEqual({ name: "README.md", folder: "" });
  });

  it("filters by a case-insensitive path substring and keeps the order", () => {
    const docs = [doc("specs/Auth.md"), doc("docs/api.md"), doc("insights/auth-notes.md")];
    expect(filterDocs(docs, " AUTH ").map((d) => d.path)).toEqual(["specs/Auth.md", "insights/auth-notes.md"]);
    expect(filterDocs(docs, "")).toHaveLength(3);
    expect(filterDocs(docs, "zzz")).toEqual([]);
  });
});
