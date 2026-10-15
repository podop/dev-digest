/* AgentsOverview — one row per agent with eval data: model, last finished run (version,
   date, passed / total), recall sparkline and the three metrics as whole percents ("—"
   when undefined or never run). The agent name links to its per-agent view (FR23).
   Presentational: loading / empty / error states belong to the caller. */
"use client";

import React from "react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { Sparkline } from "@devdigest/ui";
import type { EvalAgentOverview } from "@devdigest/shared";
import { toPercent } from "@/components/eval-metrics";
import { formatRunDate } from "@/components/eval-run-history";
import { evalHref } from "../../helpers";
import { MIN_SPARK_POINTS, recallSeries } from "./helpers";
import { s } from "./styles";

export function AgentsOverview({ agents }: { agents: readonly EvalAgentOverview[] }) {
  const t = useTranslations("eval.agentsOverview");
  return (
    <div style={s.scroll}>
      <table style={s.table} aria-label={t("caption")}>
        <thead>
          <tr>
            <th style={s.th} scope="col">{t("columns.agent")}</th>
            <th style={s.th} scope="col">{t("columns.model")}</th>
            <th style={s.th} scope="col">{t("columns.lastRun")}</th>
            <th style={s.th} scope="col">{t("columns.pass")}</th>
            <th style={s.th} scope="col">{t("columns.trend")}</th>
            <th style={{ ...s.th, ...s.num }} scope="col">{t("columns.recall")}</th>
            <th style={{ ...s.th, ...s.num }} scope="col">{t("columns.precision")}</th>
            <th style={{ ...s.th, ...s.num }} scope="col">{t("columns.citation")}</th>
          </tr>
        </thead>
        <tbody>
          {agents.map((agent) => (
            <AgentRow key={agent.agent_id} agent={agent} />
          ))}
        </tbody>
      </table>
    </div>
  );
}

function AgentRow({ agent }: { agent: EvalAgentOverview }) {
  const t = useTranslations("eval.agentsOverview");
  const { latest } = agent;
  const spark = recallSeries(agent.sparkline);
  return (
    <tr data-testid="eval-agent-row">
      <td style={s.td}>
        <Link href={evalHref(agent.agent_id)} style={s.name}>
          {agent.name}
        </Link>
        <div style={s.sub}>{t("cases", { count: agent.cases_total })}</div>
      </td>
      <td style={s.td} className="mono">{agent.model}</td>
      <td style={{ ...s.td, ...(latest ? null : s.muted) }}>
        {latest ? t("lastRun", { version: latest.agent_version, date: formatRunDate(latest.started_at) }) : t("neverRun")}
      </td>
      <td className="tnum" style={{ ...s.td, ...(latest ? null : s.muted) }}>
        {latest ? t("pass", { passed: latest.cases_passed, total: latest.cases_total }) : t("noValue")}
      </td>
      <td style={s.td}>
        {spark.length >= MIN_SPARK_POINTS && (
          <span role="img" aria-label={t("trendLabel")} style={s.spark}>
            <Sparkline data={spark} w={56} h={20} />
          </span>
        )}
      </td>
      <Metric ratio={latest?.recall} />
      <Metric ratio={latest?.precision} />
      <Metric ratio={latest?.citation_accuracy} />
    </tr>
  );
}

function Metric({ ratio }: { ratio: number | null | undefined }) {
  const t = useTranslations("eval.agentsOverview");
  const percent = toPercent(ratio);
  return (
    <td className="tnum" style={{ ...s.td, ...s.num, ...(percent == null ? s.muted : null) }}>
      {percent == null ? t("noValue") : t("percent", { value: percent })}
    </td>
  );
}
