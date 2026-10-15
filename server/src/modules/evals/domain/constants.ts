/** Eval pipeline domain constants (specs/eval-pipeline.md). */

/** A metric drop of at least this much vs the previous finished run raises the regression alert (FR15). */
export const REGRESSION_THRESHOLD = 0.02;

/** Metrics and deltas are rounded to this many decimals (stored runs and responses agree). */
export const METRIC_DECIMALS = 4;
/** Money is rounded to this many decimals (matches `numeric(12, 6)`). */
export const COST_DECIMALS = 6;

/** Sparkline length on the overview, trend length on the per-agent dashboard (Q3). */
export const SPARKLINE_POINTS = 10;
export const TREND_POINTS = 20;
/** Recent runs across agents on the overview (FR14). */
export const RECENT_RUNS_LIMIT = 20;

/** Cases of one run executing at once, and the per-case wall-clock budget (NFR2, Q4). */
export const EVAL_CASE_CONCURRENCY = 3;
export const EVAL_CASE_TIMEOUT_MS = 120_000;

/** Prompt line diff: above this many LCS cells the changed middle is reported as del-all + add-all. */
export const LINE_DIFF_MAX_CELLS = 4_000_000;

/** Run error recorded for runs left `running` by a stopped server (FR18). */
export const INTERRUPTED_ERROR = 'interrupted';

/** Stored case / run error messages are cut to this many characters. */
export const ERROR_MESSAGE_MAX_CHARS = 500;

/** How long shutdown waits for in-flight runs to record their final state. */
export const EVAL_SHUTDOWN_WAIT_MS = 5_000;
