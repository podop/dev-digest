import type { CSSProperties } from "react";

/** Co-located styles for the metric trend chart. */
export const s = {
  wrap: { border: "1px solid var(--border)", borderRadius: 9, padding: "12px 14px", background: "var(--bg-surface)" } satisfies CSSProperties,
  svg: { width: "100%", height: "auto", display: "block" } satisfies CSSProperties,
  axis: { fontSize: 11, fill: "var(--text-muted)" } satisfies CSSProperties,
  legend: { display: "flex", gap: 16, marginTop: 8, fontSize: 12, color: "var(--text-secondary)" } satisfies CSSProperties,
  legendItem: { display: "inline-flex", alignItems: "center", gap: 6 } satisfies CSSProperties,
  swatch: { width: 10, height: 10, borderRadius: 2, display: "inline-block" } satisfies CSSProperties,
  empty: { fontSize: 13, color: "var(--text-muted)", margin: 0 } satisfies CSSProperties,
} as const;
