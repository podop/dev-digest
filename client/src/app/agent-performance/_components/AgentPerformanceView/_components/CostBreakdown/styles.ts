import type { CSSProperties } from "react";

export const s = {
  section: { display: "flex", flexDirection: "column", gap: 14 } satisfies CSSProperties,
  h2: { fontSize: 16, fontWeight: 600, margin: 0 } satisfies CSSProperties,
  panels: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))", gap: 16 } satisfies CSSProperties,
  panel: { background: "var(--bg-elevated)", border: "1px solid var(--border)", borderRadius: 9, padding: 16 } satisfies CSSProperties,
} as const;
