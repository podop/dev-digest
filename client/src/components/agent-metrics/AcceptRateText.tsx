/* AcceptRateText — the accept rate with its denominator: "60% of 12", "100% of 3 · small sample"
   (text marker + tooltip, so colour is never the only signal), "— 0 decisions". Presentational. */
"use client";

import React from "react";
import { useTranslations } from "next-intl";
import { formatPercent } from "./helpers";
import { s } from "./styles";

export interface AcceptRateTextProps {
  rate: number | null;
  decisions: number;
  smallSample: boolean;
  minDecisions: number;
}

export function AcceptRateText({ rate, decisions, smallSample, minDecisions }: AcceptRateTextProps) {
  const t = useTranslations("agentPerformance.metrics");
  const percent = formatPercent(rate);
  if (percent == null) {
    return (
      <span className="tnum">
        <span style={s.muted}>{t("noValue")}</span> {t("noDecisions")}
      </span>
    );
  }
  return (
    <span className="tnum">
      {t("acceptOf", { percent, decisions })}
      {smallSample && (
        <>
          {" · "}
          <span title={t("smallSampleHint", { min: minDecisions })} style={s.marker}>
            {t("smallSample")}
          </span>
        </>
      )}
    </span>
  );
}
