/* CostBreakdownList — one cost-breakdown panel ("By agent" / "By model"): each segment's label,
   estimated cost and whole-percent share of the listed total. Null keys read "Deleted agents" /
   "Unknown model". Presentational; the empty copy is shown when there is no priced run. */
"use client";

import React from "react";
import { useTranslations } from "next-intl";
import type { CostSegment } from "@devdigest/shared";
import { CostText } from "@/components/cost-text";
import { sharePercent } from "./helpers";
import { s } from "./styles";

export interface CostBreakdownListProps {
  title: string;
  segments: readonly CostSegment[];
  /** What a null segment key stands for: deleted agents (by agent) or an unknown model (by model). */
  nullLabel: "deletedAgents" | "unknownModel";
}

export function CostBreakdownList({ title, segments, nullLabel }: CostBreakdownListProps) {
  const t = useTranslations("agentPerformance.breakdown");
  const total = segments.reduce((sum, seg) => sum + seg.value, 0);
  return (
    <section aria-label={title}>
      <h3 style={s.listTitle}>{title}</h3>
      {segments.length === 0 ? (
        <p style={s.empty}>{t("noCost")}</p>
      ) : (
        <ul style={s.list}>
          {segments.map((seg) => {
            const label = seg.label ?? t(nullLabel);
            return (
              <li key={seg.key ?? "∅"} style={s.item}>
                <span style={s.itemLabel} title={label}>
                  {label}
                </span>
                <CostText usd={seg.value} />
                <span className="tnum" style={s.itemShare}>
                  {t("share", { percent: sharePercent(seg.value, total) })}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
