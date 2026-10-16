import type { CSSProperties } from "react";

export const s = {
  td: { padding: "11px 12px", borderBottom: "1px solid var(--border)", whiteSpace: "nowrap" } satisfies CSSProperties,
  row: { cursor: "pointer" } satisfies CSSProperties,
  muted: { color: "var(--text-muted)" } satisfies CSSProperties,
  toggle: {
    all: "unset",
    cursor: "pointer",
    display: "inline-flex",
    alignItems: "center",
    gap: 6,
    maxWidth: 260,
    fontWeight: 600,
  } satisfies CSSProperties,
  name: { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } satisfies CSSProperties,
  chevron: { color: "var(--text-muted)", width: 10, flex: "none" } satisfies CSSProperties,
  link: { color: "var(--accent-text)" } satisfies CSSProperties,
  detail: { padding: "14px 16px", borderBottom: "1px solid var(--border)", background: "var(--bg-elevated)" } satisfies CSSProperties,
} as const;
