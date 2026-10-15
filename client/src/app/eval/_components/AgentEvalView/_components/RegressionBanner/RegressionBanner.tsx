/* RegressionBanner — the latest finished run dropped a metric by >= 0.02 vs the previous
   one (FR15). Names each dropped metric with its signed drop in points: the arrow and the
   text carry the message, colour is only a hint (NFR8). */
"use client";

import React from "react";
import { useTranslations } from "next-intl";
import { Icon } from "@devdigest/ui";
import type { EvalRegressionAlert } from "@devdigest/shared";
import { METRIC_LABEL_KEY } from "../../constants";
import { ratioToPoints } from "../../helpers";
import { s } from "./styles";

export function RegressionBanner({ alert }: { alert: EvalRegressionAlert }) {
  const t = useTranslations("eval.regression");
  const tm = useTranslations("eval.metricTiles");
  return (
    <div role="alert" style={s.banner}>
      <Icon.AlertTriangle size={16} aria-hidden style={s.icon} />
      <div>
        <div style={s.title}>{t("title")}</div>
        <ul style={s.list}>
          {alert.metrics.map(({ metric, delta }) => (
            <li key={metric} className="tnum">
              {t("item", { metric: tm(METRIC_LABEL_KEY[metric]), amount: Math.abs(ratioToPoints(delta) ?? 0) })}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
