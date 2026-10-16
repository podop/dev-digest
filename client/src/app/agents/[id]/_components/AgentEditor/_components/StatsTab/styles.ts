import type { CSSProperties } from "react";

/** Co-located styles for the agent Stats tab. */
export const s = {
  wrap: { maxWidth: 920, display: "flex", flexDirection: "column", gap: 22 } satisfies CSSProperties,
  header: { display: "flex", justifyContent: "flex-end" } satisfies CSSProperties,
  section: { display: "flex", flexDirection: "column", gap: 10 } satisfies CSSProperties,
  cards: { display: "flex", gap: 12, flexWrap: "wrap" } satisfies CSSProperties,
  skeletonCard: { flex: "1 1 160px", minWidth: 150 } satisfies CSSProperties,
  h2: { margin: 0, fontSize: 15, fontWeight: 700 } satisfies CSSProperties,
  marker: { color: "var(--warn)", cursor: "help" } satisfies CSSProperties,
} as const;
