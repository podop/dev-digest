import type { CSSProperties } from "react";

export const s = {
  card: {
    border: "1px solid var(--border)",
    borderRadius: 8,
    background: "var(--bg-elevated)",
    padding: 18,
    display: "flex",
    flexDirection: "column",
    gap: 16,
    minWidth: 0,
  } satisfies CSSProperties,
  header: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    flexWrap: "wrap",
  } satisfies CSSProperties,
  headerIcon: { color: "var(--text-muted)" } satisfies CSSProperties,
  headerTitle: {
    fontSize: 11,
    fontWeight: 700,
    letterSpacing: "0.07em",
    textTransform: "uppercase",
    color: "var(--text-muted)",
  } satisfies CSSProperties,
  headerRight: { marginLeft: "auto" } satisfies CSSProperties,
  explanation: {
    margin: 0,
    fontSize: 13.5,
    lineHeight: 1.55,
    color: "var(--text-secondary)",
  } satisfies CSSProperties,
  notes: {
    display: "flex",
    flexDirection: "column",
    gap: 4,
  } satisfies CSSProperties,
  note: {
    margin: 0,
    fontSize: 12,
    color: "var(--text-muted)",
    fontStyle: "italic",
    overflowWrap: "anywhere",
  } satisfies CSSProperties,
  staleNote: {
    margin: 0,
    fontSize: 12.5,
    fontWeight: 600,
    color: "var(--warn)",
  } satisfies CSSProperties,
  errorNote: {
    margin: 0,
    fontSize: 12.5,
    color: "var(--crit)",
    overflowWrap: "anywhere",
  } satisfies CSSProperties,
} as const;
