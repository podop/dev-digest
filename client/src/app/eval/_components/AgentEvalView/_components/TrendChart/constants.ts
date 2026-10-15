import type { EvalMetricName } from "@devdigest/shared";

export const CHART = { width: 640, height: 200, left: 40, right: 14, top: 12, bottom: 16 } as const;

/** Gridline ratios, bottom to top (0 %, 50 %, 100 %). */
export const GRID_RATIOS = [0, 0.5, 1] as const;

export const SERIES_COLOR: Record<EvalMetricName, string> = {
  recall: "var(--accent)",
  precision: "var(--ok)",
  citation_accuracy: "var(--warn)",
};

/** Message keys: legend entry (eval.dashboard.legend) and tile label (eval.metricTiles) per metric. */
export const LEGEND_KEY: Record<EvalMetricName, string> = {
  recall: "recall",
  precision: "precision",
  citation_accuracy: "citation",
};
