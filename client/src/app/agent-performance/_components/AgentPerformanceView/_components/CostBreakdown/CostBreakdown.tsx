/* CostBreakdown — "Cost breakdown": estimated cost by agent and by model, plus the one estimate
   note that is always visible (FR17, NFR5). */
"use client";

import React from "react";
import { useTranslations } from "next-intl";
import type { CostSegment } from "@devdigest/shared";
import { CostBreakdownList, EstimateNote } from "@/components/agent-metrics";
import { s } from "./styles";

export interface CostBreakdownProps {
  byAgent: readonly CostSegment[];
  byModel: readonly CostSegment[];
}

export function CostBreakdown({ byAgent, byModel }: CostBreakdownProps) {
  const t = useTranslations("agentPerformance");
  return (
    <section style={s.section} aria-label={t("dashboard.costBreakdown")}>
      <h2 style={s.h2}>{t("dashboard.costBreakdown")}</h2>
      <div style={s.panels}>
        <div style={s.panel}>
          <CostBreakdownList title={t("breakdown.byAgent")} segments={byAgent} nullLabel="deletedAgents" />
        </div>
        <div style={s.panel}>
          <CostBreakdownList title={t("breakdown.byModel")} segments={byModel} nullLabel="unknownModel" />
        </div>
      </div>
      <EstimateNote />
    </section>
  );
}
