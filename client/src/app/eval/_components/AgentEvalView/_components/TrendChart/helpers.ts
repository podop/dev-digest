import type { EvalMetricName, EvalRunSummary } from "@devdigest/shared";
import { CHART } from "./constants";

export interface ChartPoint {
  x: number;
  y: number;
  run: EvalRunSummary;
  /** Whole percent shown in the tooltip. */
  percent: number;
}

const PLOT_WIDTH = CHART.width - CHART.left - CHART.right;
const PLOT_HEIGHT = CHART.height - CHART.top - CHART.bottom;

/** X of run `index` of `count` (a lone run sits in the middle). */
export function xOf(index: number, count: number): number {
  return CHART.left + (count <= 1 ? PLOT_WIDTH / 2 : (index / (count - 1)) * PLOT_WIDTH);
}

/** Y of a 0–1 ratio (1 at the top of the plot). */
export function yOf(ratio: number): number {
  return CHART.top + (1 - ratio) * PLOT_HEIGHT;
}

/** Points of one metric over `runs` (oldest first); runs where the metric is undefined leave a gap. */
export function metricPoints(runs: readonly EvalRunSummary[], metric: EvalMetricName): ChartPoint[] {
  return runs.flatMap((run, i) => {
    const value = run[metric];
    return value == null ? [] : [{ x: xOf(i, runs.length), y: yOf(value), run, percent: Math.round(value * 100) }];
  });
}

/** Lines of consecutive runs: the points split wherever a run has no value (gap), single points draw no line. */
export function lineSegments(runs: readonly EvalRunSummary[], metric: EvalMetricName): ChartPoint[][] {
  const segments: ChartPoint[][] = [];
  let current: ChartPoint[] = [];
  runs.forEach((run, i) => {
    const value = run[metric];
    if (value == null) {
      if (current.length) segments.push(current);
      current = [];
      return;
    }
    current.push({ x: xOf(i, runs.length), y: yOf(value), run, percent: Math.round(value * 100) });
  });
  if (current.length) segments.push(current);
  return segments.filter((seg) => seg.length >= 2);
}

export function toPolyline(points: readonly ChartPoint[]): string {
  return points.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" ");
}
