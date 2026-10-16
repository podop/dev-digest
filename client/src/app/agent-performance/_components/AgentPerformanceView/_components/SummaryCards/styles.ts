import type { CSSProperties } from "react";

export const s = {
  row: { display: "flex", gap: 12, flexWrap: "wrap" } satisfies CSSProperties,
  marker: { color: "var(--warn)", cursor: "help" } satisfies CSSProperties,
  name: { display: "block", maxWidth: 220, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } satisfies CSSProperties,
} as const;
