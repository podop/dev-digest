import type { ContextDoc } from "@devdigest/shared";

type RawParam = string | string[] | undefined;

export interface ContextSearch {
  /** Repo-relative path of the selected document, from ?doc=. */
  doc: string | null;
}

/** Normalises the page's raw searchParams. */
export function parseContextSearch(raw: { doc?: RawParam }): ContextSearch {
  const doc = Array.isArray(raw.doc) ? raw.doc[0] : raw.doc;
  return { doc: doc ? doc : null };
}

/** Screen URL for a selection; no document → the bare route. */
export function contextHref(repoId: string, doc: string | null): string {
  const base = `/repos/${encodeURIComponent(repoId)}/context`;
  return doc ? `${base}?${new URLSearchParams({ doc }).toString()}` : base;
}

/** File name and its folder (with a trailing `/`, empty at the repo root). */
export function splitPath(path: string): { name: string; folder: string } {
  const i = path.lastIndexOf("/");
  return i < 0 ? { name: path, folder: "" } : { name: path.slice(i + 1), folder: path.slice(0, i + 1) };
}

/** Documents whose path contains the query (case-insensitive); order is kept. */
export function filterDocs(docs: readonly ContextDoc[], query: string): ContextDoc[] {
  const q = query.trim().toLowerCase();
  return q ? docs.filter((d) => d.path.toLowerCase().includes(q)) : [...docs];
}
