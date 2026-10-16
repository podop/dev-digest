/* StatCard — one number card of the Agent Performance screens: label, big value, optional
   hint lines. A null value renders a muted "—" (never 0). Presentational. */
"use client";

import React from "react";
import { useTranslations } from "next-intl";
import { s } from "./styles";

export interface StatCardProps {
  label: string;
  /** The formatted value; null/undefined = unknown, shown as "—". */
  value: React.ReactNode | null | undefined;
  /** Secondary lines under the value (denominators, estimate label, counts). */
  children?: React.ReactNode;
}

export function StatCard({ label, value, children }: StatCardProps) {
  const t = useTranslations("agentPerformance.metrics");
  const known = value != null;
  return (
    <div role="group" aria-label={label} style={s.card}>
      <span style={s.cardLabel}>{label}</span>
      <span className="tnum" style={{ ...s.cardValue, ...(known ? null : s.muted) }}>
        {known ? value : t("noValue")}
      </span>
      {children != null && <div style={s.cardHint}>{children}</div>}
    </div>
  );
}
