/* TrendChart — recall, precision and citation accuracy of the last finished runs of an
   agent (oldest → newest, FR24). Inline SVG, no chart library. Every run is a dot with a
   tooltip (metric, value, version, date), so a trend of one run still shows; consecutive
   defined values are joined by a line. Series are told apart by the legend and the dot
   tooltips, not by colour alone. */
"use client";

import React from "react";
import { useTranslations } from "next-intl";
import type { EvalMetricName, EvalRunSummary } from "@devdigest/shared";
import { EVAL_METRICS } from "@/components/eval-metrics";
import { formatRunDate } from "@/components/eval-run-history";
import { CHART, GRID_RATIOS, LEGEND_KEY, SERIES_COLOR } from "./constants";
import { lineSegments, metricPoints, toPolyline, yOf } from "./helpers";
import { s } from "./styles";

export function TrendChart({ runs }: { runs: readonly EvalRunSummary[] }) {
  const t = useTranslations("eval.trend");
  const td = useTranslations("eval.dashboard");
  if (runs.length === 0) return <p style={s.empty}>{t("empty")}</p>;

  const label = (metric: EvalMetricName) => td(`legend.${LEGEND_KEY[metric]}`);
  return (
    <div style={s.wrap}>
      <svg viewBox={`0 0 ${CHART.width} ${CHART.height}`} role="img" aria-label={td("metricTrend")} style={s.svg}>
        {GRID_RATIOS.map((ratio) => (
          <g key={ratio}>
            <line x1={CHART.left} x2={CHART.width - CHART.right} y1={yOf(ratio)} y2={yOf(ratio)} stroke="var(--border)" strokeWidth={1} />
            <text x={CHART.left - 8} y={yOf(ratio) + 4} textAnchor="end" style={s.axis}>
              {t("axis", { value: Math.round(ratio * 100) })}
            </text>
          </g>
        ))}
        {EVAL_METRICS.map((metric) => (
          <g key={metric} stroke={SERIES_COLOR[metric]} fill={SERIES_COLOR[metric]}>
            {lineSegments(runs, metric).map((segment) => (
              <polyline key={segment[0]!.run.id} points={toPolyline(segment)} fill="none" strokeWidth={2} strokeLinejoin="round" />
            ))}
            {metricPoints(runs, metric).map((p) => (
              <circle key={p.run.id} cx={p.x} cy={p.y} r={3.5} stroke="none">
                <title>
                  {t("point", { metric: label(metric), value: p.percent, version: p.run.agent_version, date: formatRunDate(p.run.started_at) })}
                </title>
              </circle>
            ))}
          </g>
        ))}
      </svg>
      <div style={s.legend}>
        {EVAL_METRICS.map((metric) => (
          <span key={metric} style={s.legendItem}>
            <span style={{ ...s.swatch, background: SERIES_COLOR[metric] }} aria-hidden />
            {label(metric)}
          </span>
        ))}
      </div>
    </div>
  );
}
