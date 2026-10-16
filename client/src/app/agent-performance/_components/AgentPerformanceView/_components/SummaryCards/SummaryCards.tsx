/* SummaryCards — the four dashboard cards (FR12): total runs, total cost (estimate), pooled accept
   rate with its denominator, most-active agent. A null value is a muted "—", never 0. */
"use client";

import React from "react";
import { useTranslations } from "next-intl";
import type { AgentPerf } from "@devdigest/shared";
import { StatCard, formatPercent } from "@/components/agent-metrics";
import { CostText } from "@/components/cost-text";
import { s } from "./styles";

export interface SummaryCardsProps {
  summary: AgentPerf["summary"];
  agents: AgentPerf["agents"];
  minDecisions: number;
  periodLabel: string;
}

export function SummaryCards({ summary, agents, minDecisions, periodLabel }: SummaryCardsProps) {
  const t = useTranslations("agentPerformance.dashboard");
  const tm = useTranslations("agentPerformance.metrics");
  const failedOrCancelled = agents.reduce((sum, a) => sum + a.metrics.runs_failed + a.metrics.runs_cancelled, 0);
  const percent = formatPercent(summary.avg_accept_rate);
  const smallSample = summary.decisions > 0 && summary.decisions < minDecisions;
  const top = summary.most_active;

  return (
    <div style={s.row}>
      <StatCard label={t("cards.totalRuns")} value={summary.runs}>
        <div>{t("inPeriod", { period: periodLabel })}</div>
        {failedOrCancelled > 0 && <div>{tm("failedOrCancelled", { count: failedOrCancelled })}</div>}
      </StatCard>
      <StatCard label={t("cards.totalCost")} value={summary.total_cost_usd == null ? null : <CostText usd={summary.total_cost_usd} />}>
        <div>{tm("estimateLabel")}</div>
        {summary.unpriced_runs > 0 && <div>{tm("unpriced", { count: summary.unpriced_runs })}</div>}
      </StatCard>
      <StatCard label={t("cards.avgAccept")} value={percent == null ? null : tm("percent", { value: percent })}>
        <div>
          {summary.decisions === 0
            ? tm("noDecisions")
            : tm("acceptedOfDecisions", { accepted: summary.accepted, decisions: summary.decisions, pending: summary.pending })}
          {smallSample && (
            <>
              {" · "}
              <span title={tm("smallSampleHint", { min: minDecisions })} style={s.marker}>
                {tm("smallSample")}
              </span>
            </>
          )}
        </div>
      </StatCard>
      <StatCard
        label={t("cards.mostActive")}
        value={top ? <span style={s.name} title={top.agent_name}>{top.agent_name}</span> : null}
      >
        {top && <div>{t("cards.runsCount", { count: top.runs })}</div>}
      </StatCard>
    </div>
  );
}
