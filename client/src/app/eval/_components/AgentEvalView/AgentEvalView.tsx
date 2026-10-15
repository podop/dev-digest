/* AgentEvalView — /eval?agent=<id>: one agent's eval history (FR24): agent picker, Run
   eval with live progress, latest-run tiles with deltas, the regression banner, the
   metric trend, and the runs table with selection of exactly two finished runs → Compare.
   A run executes in the background; this view follows it by polling (useEvalRun) and the
   hook refreshes dashboard and runs when it ends. The compare dialog is a sibling of the
   table, not part of a row. */
"use client";

import React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { Button, ErrorState, Skeleton } from "@devdigest/ui";
import { MetricTiles } from "@/components/eval-metrics";
import { RunsTable, toggleSelected } from "@/components/eval-run-history";
import { Select } from "@/components/select";
import { useAgents, useEvalAgentDashboard, useEvalRun, useEvalRuns, useStartEvalRun } from "@/lib/hooks";
import { agentEvalsHref, evalHref } from "../../helpers";
import { CompareModal } from "./_components/CompareModal";
import { RegressionBanner } from "./_components/RegressionBanner";
import { TrendChart } from "./_components/TrendChart";
import { comparePair, followedRunId, runningRun } from "./helpers";
import { s } from "./styles";

export function AgentEvalView({ agentId }: { agentId: string }) {
  const t = useTranslations("eval.agentView");
  const td = useTranslations("eval.dashboard");
  const tc = useTranslations("common");
  const router = useRouter();
  const agents = useAgents();
  const dashboard = useEvalAgentDashboard(agentId);
  const runs = useEvalRuns(agentId);
  const start = useStartEvalRun(agentId);
  const followed = useEvalRun(followedRunId(runs.data, start.data?.id));
  const [selected, setSelected] = React.useState<string[]>([]);
  const [comparing, setComparing] = React.useState(false);

  const data = dashboard.data;
  const running = runningRun(followed.data, runs.data);
  const pair = comparePair(runs.data, selected);
  const casesTotal = data?.cases_total ?? 0;
  const noCases = data != null && casesTotal === 0;
  const busy = start.isPending || running != null;
  const agentName = agents.data?.find((a) => a.id === agentId)?.name;
  const options = (agents.data ?? []).map((a) => ({ value: a.id, label: a.name }));

  return (
    <div style={s.wrap}>
      <Link href={evalHref()} style={s.back}>
        {t("back")}
      </Link>

      <header style={s.header}>
        <div style={s.titleBlock}>
          <h1 style={s.h1}>{agentName ?? td("defaultTitle")}</h1>
          {data && runs.data && <p style={s.subtitle}>{td("casesSummary", { count: casesTotal, runs: runs.data.length })}</p>}
        </div>
        <div style={s.picker}>
          <Select
            value={agentId}
            options={options}
            mono={false}
            aria-label={t("pickerLabel")}
            disabled={options.length === 0}
            onChange={(id) => router.replace(evalHref(id))}
          />
        </div>
        <Link href={agentEvalsHref(agentId)} style={s.link}>
          {td("configure")}
        </Link>
        <span title={noCases ? t("noCasesHint") : undefined}>
          <Button kind="primary" icon="Play" disabled={dashboard.isLoading || noCases || busy} onClick={() => start.mutate()}>
            {running ? t("runningProgress", { finished: running.cases_finished, total: running.cases_total }) : td("runEval", { count: casesTotal })}
          </Button>
        </span>
      </header>

      {data?.alert && <RegressionBanner alert={data.alert} />}

      {dashboard.isLoading ? (
        <Skeleton height={96} />
      ) : dashboard.isError || !data ? (
        <ErrorState title={t("loadError")} onRetry={() => dashboard.refetch()} retryLabel={tc("actions.retry")} />
      ) : data.latest ? (
        <>
          <MetricTiles latest={data.latest} previous={data.previous} history={data.trend} showCasesPassed />
          <section style={s.section} aria-label={td("metricTrend")}>
            <h2 style={s.h2}>{td("metricTrend")}</h2>
            <TrendChart runs={data.trend} />
          </section>
        </>
      ) : (
        <p style={s.caption}>{td("noRuns")}</p>
      )}

      <section style={s.section} aria-label={td("recentRuns")}>
        <div style={s.sectionHead}>
          <h2 style={{ ...s.h2, ...s.grow }}>{td("recentRuns")}</h2>
          <span title={pair ? undefined : t("compareHint")}>
            <Button kind="secondary" disabled={!pair} onClick={() => setComparing(true)}>
              {t("compare")}
            </Button>
          </span>
        </div>
        {runs.isError ? (
          <ErrorState title={t("runsLoadError")} onRetry={() => runs.refetch()} retryLabel={tc("actions.retry")} />
        ) : runs.data && runs.data.length > 0 ? (
          <RunsTable runs={runs.data} selection={{ selectedIds: selected, onToggle: (id) => setSelected((ids) => toggleSelected(ids, id)) }} />
        ) : (
          runs.isLoading && <Skeleton height={80} />
        )}
      </section>

      {comparing && pair && <CompareModal aId={pair[0].id} bId={pair[1].id} onClose={() => setComparing(false)} />}
    </div>
  );
}
