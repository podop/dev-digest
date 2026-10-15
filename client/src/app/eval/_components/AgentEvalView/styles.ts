import type { CSSProperties } from "react";

/** Co-located styles for the per-agent eval view. */
export const s = {
  wrap: { display: "flex", flexDirection: "column", gap: 24 } satisfies CSSProperties,
  back: { fontSize: 13, color: "var(--accent-text)", alignSelf: "flex-start" } satisfies CSSProperties,
  header: { display: "flex", alignItems: "center", gap: 14, flexWrap: "wrap" } satisfies CSSProperties,
  titleBlock: { flex: 1, minWidth: 220 } satisfies CSSProperties,
  h1: { fontSize: 24, fontWeight: 700, letterSpacing: "-0.02em", margin: 0 } satisfies CSSProperties,
  h2: { fontSize: 16, fontWeight: 700, margin: 0 } satisfies CSSProperties,
  subtitle: { fontSize: 13, color: "var(--text-secondary)", margin: "4px 0 0" } satisfies CSSProperties,
  link: { fontSize: 13, color: "var(--accent-text)" } satisfies CSSProperties,
  picker: { minWidth: 200 } satisfies CSSProperties,
  section: { display: "flex", flexDirection: "column", gap: 12 } satisfies CSSProperties,
  sectionHead: { display: "flex", alignItems: "center", gap: 12 } satisfies CSSProperties,
  grow: { flex: 1 } satisfies CSSProperties,
  caption: { fontSize: 13, color: "var(--text-muted)", margin: 0 } satisfies CSSProperties,
} as const;
