/**
 * Background execution of one eval run (FR6–FR10, FR18, NFR1, NFR2, NFR5, NFR6).
 *
 * Every case runs through the reviewer-core engine with FIXED inputs only — the case
 * diff, the case's PR title/description, the run's config snapshot, temperature 0 — then
 * is scored by pure code (no LLM). Cases run with bounded concurrency, each under a
 * wall-clock budget. A failing / timed-out case is recorded as `error` and the others go
 * on; a case deleted meanwhile is skipped and excluded from the totals (EC9).
 */
import { reviewPullRequest } from '@devdigest/reviewer-core';
import { ReviewStrategy } from '@devdigest/shared';
import { renderSkillBlock } from '../../skills/index.js';
import { COST_DECIMALS, EVAL_CASE_TIMEOUT_MS, INTERRUPTED_ERROR } from '../domain/constants.js';
import { CaseUsage, errorMessage, evalTaskLine, toKeptFindings } from '../domain/run-input.js';
import { aggregateRun, roundTo, runVerdict, scoreCase } from '../domain/scoring.js';
import type { CaseOutcome, CaseRecord, RunFinal, RunJob, RunnableCase } from '../domain/types.js';
import type { BoundedRunner, DiffParser, EvalLogger, EvalRunProgress, LlmResolver, RunLauncher } from './ports.js';

export interface EvalRunExecutorDeps {
  runs: EvalRunProgress;
  llm: LlmResolver;
  parseDiff: DiffParser;
  /** Bounded concurrency (3 cases at once), injected by the composition root. */
  runBounded: BoundedRunner;
  /** Per-case wall-clock budget; default {@link EVAL_CASE_TIMEOUT_MS}. */
  caseTimeoutMs?: number;
  /** Wall clock in ms (injectable for tests). */
  now?: () => number;
}

/** What the engine run of one case produced, before scoring. */
interface CaseReview {
  kept: ReturnType<typeof toKeptFindings>;
  dropped: number;
}

/** Reject as soon as `signal` aborts (with its reason), even when `p` ignores it; the late result is swallowed. */
function raceAbort<T>(p: Promise<T>, signal: AbortSignal): Promise<T> {
  p.catch(() => undefined);
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    p.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
  });
}

export class EvalRunExecutor implements RunLauncher {
  private readonly inFlight = new Set<Promise<void>>();
  private readonly stopping = new AbortController();
  private readonly caseTimeoutMs: number;
  private readonly now: () => number;

  constructor(private readonly deps: EvalRunExecutorDeps) {
    this.caseTimeoutMs = deps.caseTimeoutMs ?? EVAL_CASE_TIMEOUT_MS;
    this.now = deps.now ?? Date.now;
  }

  launch(job: RunJob, log: EvalLogger): void {
    const p: Promise<void> = this.execute(job, log)
      .catch((err) => log.error({ err, runId: job.runId }, 'eval run: background execution crashed'))
      .finally(() => this.inFlight.delete(p));
    this.inFlight.add(p);
  }

  async shutdown(timeoutMs: number): Promise<boolean> {
    this.stopping.abort(new Error(INTERRUPTED_ERROR));
    let timer: NodeJS.Timeout | undefined;
    const timedOut = new Promise<false>((resolve) => {
      timer = setTimeout(() => resolve(false), timeoutMs);
    });
    try {
      return await Promise.race([Promise.allSettled([...this.inFlight]).then(() => true as const), timedOut]);
    } finally {
      clearTimeout(timer);
    }
  }

  private async execute(job: RunJob, log: EvalLogger): Promise<void> {
    const started = this.now();
    log.info(
      { runId: job.runId, agentId: job.agentId, agentVersion: job.agentVersion, cases: job.caseIds.length },
      'eval run started',
    );

    const outcomes: CaseOutcome[] = [];
    let crash: unknown;
    const skipped = () => crash !== undefined || this.stopping.signal.aborted;
    try {
      await this.deps.runBounded(
        job.caseIds.map((caseId) => async () => {
          if (skipped()) return;
          try {
            const outcome = await this.runCase(job, caseId);
            if (outcome) outcomes.push(outcome);
          } catch (err) {
            crash ??= err; // the store is failing: stop picking up cases
          }
        }),
      );
    } catch (err) {
      crash ??= err;
    }

    const metrics = aggregateRun(outcomes);
    const verdict =
      crash !== undefined
        ? { status: 'failed' as const, error: errorMessage(crash) }
        : this.stopping.signal.aborted
          ? { status: 'failed' as const, error: INTERRUPTED_ERROR }
          : runVerdict(outcomes);
    const final: RunFinal = { ...verdict, metrics, durationMs: this.now() - started };
    log.info(
      {
        runId: job.runId,
        status: final.status,
        durationMs: final.durationMs,
        costUsd: metrics.cost_usd,
        recall: metrics.recall,
        precision: metrics.precision,
        citationAccuracy: metrics.citation_accuracy,
        casesPassed: metrics.cases_passed,
        casesErrored: metrics.cases_errored,
      },
      'eval run finished',
    );
    try {
      await this.deps.runs.finish(job.runId, final);
    } catch (err) {
      log.error({ err, runId: job.runId }, 'eval run: could not record the final state');
    }
  }

  /** One case end to end; undefined = skipped (gone, or the server is stopping) — it counts for nothing. */
  private async runCase(job: RunJob, caseId: string): Promise<CaseOutcome | undefined> {
    const { runs } = this.deps;
    const c = await runs.loadCase(job.workspaceId, caseId);
    if (!c) {
      await runs.dropCase(job.runId);
      return undefined;
    }

    const started = this.now();
    const usage = new CaseUsage();
    let record: CaseRecord;
    try {
      const { kept, dropped } = await this.withBudget((signal) => this.review(job, c, usage, signal));
      const score = scoreCase(c.expectation, kept);
      record = {
        caseId,
        status: score.status,
        findings: score.findings,
        droppedCount: dropped,
        hitCount: score.hit_count,
        violationCount: score.violation_count,
        unlabeledCount: score.unlabeled_count,
        durationMs: this.now() - started,
        costUsd: this.cost(usage),
        error: null,
      };
    } catch (err) {
      // Aborted by shutdown: the run is interrupted, this case is not a result.
      if (this.stopping.signal.aborted) return undefined;
      record = {
        caseId,
        status: 'error',
        findings: [],
        droppedCount: 0,
        hitCount: 0,
        violationCount: 0,
        unlabeledCount: 0,
        durationMs: this.now() - started,
        costUsd: this.cost(usage),
        error: errorMessage(err),
      };
    }

    if ((await runs.recordCase(job.runId, record)) === 'case_gone') {
      await runs.dropCase(job.runId);
      return undefined;
    }
    return {
      kind: c.expectation.kind,
      status: record.status,
      hit_count: record.hitCount,
      violation_count: record.violationCount,
      unlabeled_count: record.unlabeledCount,
      dropped_count: record.droppedCount,
      cost_usd: record.costUsd,
      error: record.error,
    };
  }

  private cost(usage: CaseUsage): number | null {
    return usage.costUsd === null ? null : roundTo(usage.costUsd, COST_DECIMALS);
  }

  /** Run `work` under the per-case timeout and the shutdown signal; rejects on either, whether or not `work` honours the signal. */
  private async withBudget<T>(work: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const budget = new AbortController();
    const onStop = () => budget.abort(this.stopping.signal.reason);
    const timer = setTimeout(
      () => budget.abort(new Error(`Case timed out after ${Math.round(this.caseTimeoutMs / 1000)}s`)),
      this.caseTimeoutMs,
    );
    this.stopping.signal.addEventListener('abort', onStop, { once: true });
    try {
      return await raceAbort(work(budget.signal), budget.signal);
    } finally {
      clearTimeout(timer);
      this.stopping.signal.removeEventListener('abort', onStop);
    }
  }

  private async review(job: RunJob, c: RunnableCase, usage: CaseUsage, signal: AbortSignal): Promise<CaseReview> {
    const { config } = job;
    const llm = await this.deps.llm(config.provider);
    const strategy = ReviewStrategy.safeParse(config.strategy);
    const outcome = await reviewPullRequest({
      systemPrompt: config.system_prompt,
      model: config.model,
      diff: this.deps.parseDiff(c.inputDiff),
      llm,
      strategy: strategy.success ? strategy.data : 'auto',
      ...(config.skills.length > 0 ? { skills: config.skills.map(renderSkillBlock) } : {}),
      ...(c.inputMeta.pr_description ? { prDescription: c.inputMeta.pr_description } : {}),
      task: evalTaskLine(c.inputMeta),
      temperature: 0,
      onUsage: usage.add,
      signal,
      checkCancelled: () => signal.throwIfAborted(),
    });
    return { kept: toKeptFindings(outcome.review.findings), dropped: outcome.dropped.length };
  }
}
