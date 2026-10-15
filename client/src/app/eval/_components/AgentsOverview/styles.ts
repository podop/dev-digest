import type { CSSProperties } from "react";

/** Co-located styles for the agents overview table. */
export const s = {
  scroll: { overflowX: "auto", border: "1px solid var(--border)", borderRadius: 9 } satisfies CSSProperties,
  table: { width: "100%", borderCollapse: "collapse", fontSize: 13 } satisfies CSSProperties,
  th: {
    textAlign: "left",
    padding: "9px 12px",
    fontSize: 12,
    fontWeight: 600,
    color: "var(--text-muted)",
    background: "var(--bg-surface)",
    borderBottom: "1px solid var(--border)",
    whiteSpace: "nowrap",
  } satisfies CSSProperties,
  td: { padding: "10px 12px", borderBottom: "1px solid var(--border)", whiteSpace: "nowrap" } satisfies CSSProperties,
  num: { textAlign: "right" } satisfies CSSProperties,
  muted: { color: "var(--text-muted)" } satisfies CSSProperties,
  name: { fontWeight: 600, color: "var(--text-primary)" } satisfies CSSProperties,
  sub: { fontSize: 12, color: "var(--text-muted)", marginTop: 2 } satisfies CSSProperties,
  spark: { display: "inline-block", minWidth: 56 } satisfies CSSProperties,
} as const;
