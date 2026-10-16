/* StatsTab — one agent's metrics for a period (FR18): the period control, five cards (runs, total and
   average cost as estimates, average duration, accept rate with its denominator), the run breakdown,
   the cost-by-model list and the estimate note. The period lives in the URL (the picker uses
   router.replace); the same aggregation as the dashboard row. While loading or failed no number is
   rendered (no placeholder data, no zeros); a 404 reads like the editor's load error. */
"use client";

import React from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import type { Agent, AgentStats } from "@devdigest/shared";
import { EmptyState, ErrorState, Skeleton } from "@devdigest/ui";
import { CostBreakdownList, EstimateNote, RunBreakdown, StatCard, formatDurationS, formatPercent } from "@/components/agent-metrics";
import { CostText } from "@/components/cost-text";
import { PeriodPicker } from "@/components/stats-period-picker";
import { ApiError } from "@/lib/api";
import { useAgentStats } from "@/lib/hooks";
import { agentStatsHref, formatPeriodRange, type StatsPeriod } from "@/lib/stats-period";
import { s } from "./styles";

export function StatsTab({ agent, period }: { agent: Agent; period: StatsPeriod }) {
  const t = useTranslations("agentPerformance.statsTab");
  const ta = useTranslations("agents");
  const tc = useTranslations("common");
  const router = useRouter();
  const query = useAgentStats(agent.id, period);
  const periodLabel = formatPeriodRange(period, { "1d": t("periodPhrase.1d"), "30d": t("periodPhrase.30d") });
  const notFound = query.error instanceof ApiError && query.error.status === 404;

  return (
    <div style={s.wrap}>
      <div style={s.header}>
        <PeriodPicker period={period} onChange={(next) => router.replace(agentStatsHref(agent.id, next))} />
      </div>

      {query.isLoading && <LoadingSkeleton label={t("loading")} />}
      {query.isError &&
        (notFound ? (
          <ErrorState title={ta("editor.loadErrorTitle")} body={ta("editor.loadErrorBody")} onRetry={() => query.refetch()} retryLabel={tc("actions.retry")} />
        ) : (
          <ErrorState title={t("loadError")} onRetry={() => query.refetch()} retryLabel={tc("actions.retry")} />
        ))}
      {query.data &&
        (query.data.metrics.runs === 0 ? (
          <EmptyState icon="Activity" title={t("noRunsTitle", { period: periodLabel })} body={t("noRunsBody")} />
        ) : (
          <Loaded stats={query.data} />
        ))}
    </div>
  );
}

function Loaded({ stats }: { stats: AgentStats }) {
  const t = useTranslations("agentPerformance.statsTab");
  const tm = useTranslations("agentPerformance.metrics");
  const tb = useTranslations("agentPerformance.breakdown");
  const m = stats.metrics;
  const seconds = formatDurationS(m.avg_duration_ms);
  const percent = formatPercent(m.accept_rate);

  return (
    <>
      <div role="group" aria-label={t("cardsLabel")} style={s.cards}>
        <StatCard label={tm("runs")} value={m.runs}>
          {m.runs_failed + m.runs_cancelled > 0 && <div>{tm("failedOrCancelled", { count: m.runs_failed + m.runs_cancelled })}</div>}
        </StatCard>
        <StatCard label={tm("totalCost")} value={m.total_cost_usd == null ? null : <CostText usd={m.total_cost_usd} />}>
          <div>{tm("estimateLabel")}</div>
          {m.unpriced_runs > 0 && <div>{tm("unpriced", { count: m.unpriced_runs })}</div>}
        </StatCard>
        <StatCard label={tm("avgCost")} value={m.avg_cost_usd == null ? null : <CostText usd={m.avg_cost_usd} />} />
        <StatCard label={tm("avgDuration")} value={seconds == null ? null : tm("seconds", { value: seconds })} />
        <StatCard label={tm("acceptRate")} value={percent == null ? null : tm("percent", { value: percent })}>
          <div>
            {m.decisions === 0 ? tm("noDecisions") : tm("acceptedOfDecisions", { accepted: m.accepted, decisions: m.decisions, pending: m.pending })}
            {m.small_sample && (
              <>
                {" · "}
                <span title={tm("smallSampleHint", { min: stats.min_decisions })} style={s.marker}>
                  {tm("smallSample")}
                </span>
              </>
            )}
          </div>
        </StatCard>
      </div>

      <section style={s.section} aria-label={t("runBreakdown")}>
        <h2 style={s.h2}>{t("runBreakdown")}</h2>
        <RunBreakdown metrics={m} />
      </section>

      <section style={s.section}>
        <CostBreakdownList title={tb("byModel")} segments={stats.cost_by_model} nullLabel="unknownModel" />
        <EstimateNote />
      </section>
    </>
  );
}

function LoadingSkeleton({ label }: { label: string }) {
  return (
    <div role="status" aria-busy="true" aria-label={label} style={s.section}>
      <div style={s.cards}>
        {[0, 1, 2, 3, 4].map((i) => (
          <div key={i} style={s.skeletonCard}>
            <Skeleton height={96} />
          </div>
        ))}
      </div>
      <Skeleton height={120} />
    </div>
  );
}
