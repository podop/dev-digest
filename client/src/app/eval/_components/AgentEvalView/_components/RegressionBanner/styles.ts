import type { CSSProperties } from "react";

/** Co-located styles for the regression banner. */
export const s = {
  banner: {
    display: "flex",
    gap: 12,
    alignItems: "flex-start",
    padding: "12px 16px",
    borderRadius: 9,
    border: "1px solid var(--crit)",
    background: "var(--bg-surface)",
    fontSize: 13,
  } satisfies CSSProperties,
  icon: { color: "var(--crit)", marginTop: 2, flexShrink: 0 } satisfies CSSProperties,
  title: { fontWeight: 700, color: "var(--crit)" } satisfies CSSProperties,
  list: { margin: "4px 0 0", padding: 0, listStyle: "none", display: "flex", gap: 16, flexWrap: "wrap" } satisfies CSSProperties,
} as const;
