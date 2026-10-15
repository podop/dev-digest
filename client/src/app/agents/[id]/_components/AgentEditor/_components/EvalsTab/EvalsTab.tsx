/* EvalsTab — the agent's eval cases and results: latest-run metric tiles with deltas,
   the case list ("n / m passing"), "Run all evals" with live progress, the run history,
   and a link to the full dashboard (FR21). A run executes in the background; this tab
   follows it by polling (useEvalRun) and the hook refreshes tiles, rows and history when
   it ends. Case modals and the delete confirmation sit next to the list, not in a row. */
"use client";

import React from "react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { Button, ErrorState, Skeleton } from "@devdigest/ui";
import type { Agent } from "@devdigest/shared";
import { MetricTiles } from "@/components/eval-metrics";
import { RunsTable } from "@/components/eval-run-history";
import { useDeleteEvalCase, useEvalAgentDashboard, useEvalCases, useEvalRun, useEvalRuns, useStartEvalRun } from "@/lib/hooks";
import { DeleteCaseConfirm } from "./_components/DeleteCaseConfirm";
import { EvalCaseModal } from "./_components/EvalCaseModal";
import { EvalCaseRow } from "./_components/EvalCaseRow";
import { countPassing, dashboardHref, followedRunId, runningRun } from "./helpers";
import { s } from "./styles";

export function EvalsTab({ agent }: { agent: Agent }) {
  const t = useTranslations("eval.agentEvals");
  const tc = useTranslations("common");
  const cases = useEvalCases(agent.id);
  const dashboard = useEvalAgentDashboard(agent.id);
  const runs = useEvalRuns(agent.id);
  const start = useStartEvalRun(agent.id);
  const remove = useDeleteEvalCase();
  const followed = useEvalRun(followedRunId(runs.data, start.data?.id));
  const [openId, setOpenId] = React.useState<string | null>(null);
  const [deletingId, setDeletingId] = React.useState<string | null>(null);

  const running = runningRun(followed.data, runs.data);
  const caseList = cases.data ?? [];
  const opened = caseList.find((c) => c.id === openId) ?? null;
  const deleting = caseList.find((c) => c.id === deletingId) ?? null;
  const noCases = !cases.isLoading && caseList.length === 0;
  const busy = start.isPending || running != null;

  const confirmDelete = () => {
    if (deleting) remove.mutate({ id: deleting.id, agentId: agent.id }, { onSuccess: () => setDeletingId(null) });
  };

  return (
    <div style={s.wrap}>
      <section style={s.section} aria-label={t("metricsTitle")}>
        <div style={s.header}>
          <div style={s.titleBlock}>
            <h2 style={s.h2}>{t("metricsTitle")}</h2>
            <p style={s.subtitle}>{t("metricsSubtitle")}</p>
          </div>
          <Link href={dashboardHref(agent.id)} style={s.link}>
            {t("viewDashboard")}
          </Link>
        </div>
        {dashboard.isLoading ? (
          <Skeleton height={96} />
        ) : dashboard.isError || !dashboard.data ? (
          <ErrorState title={t("metricsLoadError")} onRetry={() => dashboard.refetch()} retryLabel={tc("actions.retry")} />
        ) : dashboard.data.latest ? (
          <MetricTiles latest={dashboard.data.latest} previous={dashboard.data.previous} showCasesPassed />
        ) : (
          <p style={s.caption}>{t("noRuns")}</p>
        )}
      </section>

      <section style={s.section} aria-label={t("casesHeading")}>
        <div style={s.header}>
          <h2 style={{ ...s.h2, ...s.titleBlock }}>
            {t("casesHeading")}
            {!cases.isLoading && !cases.isError && (
              <span style={s.passing}>{t("casesPassing", { passed: countPassing(caseList), total: caseList.length })}</span>
            )}
          </h2>
          <span title={noCases ? t("runAllNoCases") : undefined}>
            <Button
              kind="primary"
              icon="Play"
              disabled={cases.isLoading || cases.isError || noCases || busy}
              onClick={() => start.mutate()}
            >
              {running ? t("runningProgress", { finished: running.cases_finished, total: running.cases_total }) : t("runAll")}
            </Button>
          </span>
        </div>
        {cases.isLoading ? (
          <Skeleton height={140} />
        ) : cases.isError ? (
          <ErrorState title={t("casesLoadError")} onRetry={() => cases.refetch()} retryLabel={tc("actions.retry")} />
        ) : noCases ? (
          <p style={s.caption}>{t("emptyCases")}</p>
        ) : (
          <ul style={s.list} aria-label={t("casesHeading")}>
            {caseList.map((c) => (
              <EvalCaseRow key={c.id} evalCase={c} onOpen={() => setOpenId(c.id)} onDelete={() => setDeletingId(c.id)} />
            ))}
          </ul>
        )}
      </section>

      <section style={s.section} aria-label={t("historyHeading")}>
        <h2 style={s.h2}>{t("historyHeading")}</h2>
        {runs.isError ? (
          <ErrorState title={t("historyLoadError")} onRetry={() => runs.refetch()} retryLabel={tc("actions.retry")} />
        ) : runs.data && runs.data.length > 0 ? (
          <RunsTable runs={runs.data} />
        ) : (
          runs.isLoading && <Skeleton height={80} />
        )}
      </section>

      {opened && (
        <EvalCaseModal
          key={opened.id}
          evalCase={opened}
          onClose={() => setOpenId(null)}
          onDelete={() => {
            setOpenId(null);
            setDeletingId(opened.id);
          }}
        />
      )}
      {deleting && (
        <DeleteCaseConfirm name={deleting.name} deleting={remove.isPending} onConfirm={confirmDelete} onCancel={() => setDeletingId(null)} />
      )}
    </div>
  );
}
