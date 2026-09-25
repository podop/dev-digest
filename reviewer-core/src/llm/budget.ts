/**
 * A per-call wall-clock budget shared by EVERY request a structured call makes
 * (SDK transport retries AND schema reprompts), so one chunk can no longer
 * spend `(sdkRetries + 1) × (reprompts + 1) × timeout` (≈ 9 × 180s).
 *
 * `signal` fires on the caller's abort OR the deadline; pass it to each SDK
 * request — the OpenAI SDK re-checks it before every retry, so its internal
 * retries stop too. The clock is injected (tests) and defaults to the
 * monotonic `performance.now`.
 */
export interface CallBudget {
  readonly signal: AbortSignal;
  readonly totalMs: number;
  /** Whole ms left before the deadline (≥ 0) — an integer, the SDKs reject fractional timeouts. */
  remaining(): number;
  /** Throw the right error if the call must stop now (caller abort or deadline). */
  throwIfDone(): void;
  /** Map an error thrown by a request: a deadline abort becomes a budget error. */
  translate(err: unknown): unknown;
}

export class CallBudgetExceededError extends Error {
  constructor(label: string, totalMs: number, options?: { cause?: unknown }) {
    super(`${label} exceeded its total budget of ${totalMs}ms`, options);
    this.name = 'CallBudgetExceededError';
  }
}

export function createCallBudget(opts: {
  totalMs: number;
  label: string;
  signal?: AbortSignal;
  now?: () => number;
}): CallBudget {
  const now = opts.now ?? (() => performance.now());
  const start = now();
  const deadline = AbortSignal.timeout(opts.totalMs);
  const signal = opts.signal ? AbortSignal.any([opts.signal, deadline]) : deadline;
  // performance.now() is fractional; the OpenAI SDK throws "timeout must be an
  // integer" on a non-integer per-request timeout, so floor it here.
  const remaining = () => Math.max(0, Math.floor(opts.totalMs - (now() - start)));
  const callerAborted = () => opts.signal?.aborted === true;
  const budgetError = (cause?: unknown) =>
    new CallBudgetExceededError(opts.label, opts.totalMs, cause === undefined ? undefined : { cause });

  return {
    signal,
    totalMs: opts.totalMs,
    remaining,
    throwIfDone() {
      if (callerAborted()) throw opts.signal!.reason ?? new Error('Request was aborted.');
      if (deadline.aborted || remaining() <= 0) throw budgetError();
    },
    translate(err) {
      if (!callerAborted() && deadline.aborted) return budgetError(err);
      return err;
    },
  };
}
