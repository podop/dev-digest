import type { CSSProperties } from "react";

/** Co-located styles for the eval case modal. */
export const s = {
  body: { padding: "18px 24px", display: "flex", flexDirection: "column", gap: 16 } satisfies CSSProperties,
  field: { display: "flex", flexDirection: "column", gap: 6, flex: 1, minWidth: 0 } satisfies CSSProperties,
  label: { fontSize: 13, fontWeight: 600, color: "var(--text-secondary)" } satisfies CSSProperties,
  row: { display: "flex", gap: 12 } satisfies CSSProperties,
  heading: { margin: 0, fontSize: 12, fontWeight: 700, letterSpacing: "0.04em", textTransform: "uppercase", color: "var(--text-muted)" } satisfies CSSProperties,
  facts: { display: "grid", gridTemplateColumns: "max-content 1fr", gap: "6px 14px", margin: 0, fontSize: 13 } satisfies CSSProperties,
  term: { color: "var(--text-muted)" } satisfies CSSProperties,
  def: { margin: 0, overflowWrap: "anywhere", whiteSpace: "pre-wrap" } satisfies CSSProperties,
  diff: {
    margin: 0,
    padding: 12,
    maxHeight: 240,
    overflow: "auto",
    fontSize: 12,
    lineHeight: 1.5,
    background: "var(--bg-surface)",
    border: "1px solid var(--border)",
    borderRadius: 7,
    whiteSpace: "pre",
  } satisfies CSSProperties,
  invalid: { fontSize: 12.5, color: "var(--crit)" } satisfies CSSProperties,
  error: { fontSize: 13, color: "var(--crit)", marginRight: "auto" } satisfies CSSProperties,
  footer: { display: "flex", alignItems: "center", gap: 8 } satisfies CSSProperties,
  spacer: { flex: 1 } satisfies CSSProperties,
} as const;
