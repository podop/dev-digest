import type { CSSProperties } from "react";

/** Co-located styles of the shared agent-metrics presentational parts. */
export const s = {
  card: {
    flex: "1 1 160px",
    minWidth: 150,
    background: "var(--bg-elevated)",
    border: "1px solid var(--border)",
    borderRadius: 9,
    padding: 16,
    display: "flex",
    flexDirection: "column",
    gap: 6,
  } satisfies CSSProperties,
  cardLabel: { fontSize: 12, fontWeight: 600, color: "var(--text-muted)", letterSpacing: "0.03em", textTransform: "uppercase" } satisfies CSSProperties,
  cardValue: { fontSize: 26, fontWeight: 700, letterSpacing: "-0.02em" } satisfies CSSProperties,
  cardHint: { fontSize: 12.5, color: "var(--text-secondary)", lineHeight: 1.4 } satisfies CSSProperties,
  muted: { color: "var(--text-muted)" } satisfies CSSProperties,
  marker: { color: "var(--warn)", cursor: "help" } satisfies CSSProperties,
  breakdown: { display: "flex", gap: 24, flexWrap: "wrap" } satisfies CSSProperties,
  group: { display: "flex", flexDirection: "column", gap: 4, minWidth: 140 } satisfies CSSProperties,
  groupTitle: { fontSize: 12, fontWeight: 600, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.03em" } satisfies CSSProperties,
  pair: { display: "flex", justifyContent: "space-between", gap: 16, fontSize: 13 } satisfies CSSProperties,
  pairTerm: { color: "var(--text-secondary)" } satisfies CSSProperties,
  empty: { fontSize: 13, color: "var(--text-muted)", margin: 0 } satisfies CSSProperties,
  list: { listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: 6 } satisfies CSSProperties,
  listTitle: { fontSize: 13, fontWeight: 600, margin: "0 0 8px" } satisfies CSSProperties,
  item: { display: "flex", alignItems: "baseline", gap: 12, fontSize: 13 } satisfies CSSProperties,
  itemLabel: { flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } satisfies CSSProperties,
  itemShare: { width: 44, textAlign: "right", color: "var(--text-secondary)" } satisfies CSSProperties,
  note: { fontSize: 12, color: "var(--text-muted)", margin: 0, lineHeight: 1.45 } satisfies CSSProperties,
} as const;
