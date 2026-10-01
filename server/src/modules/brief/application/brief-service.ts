/**
 * PR Brief use cases: read the stored brief with its derived stale flag (never a model
 * call), and generate a new one — one model call over pre-computed facts (changed files
 * and ranges, intent, blast radius, current findings, attached spec documents, the linked
 * issue). The model's paths and lines are verified before anything is stored; the previous
 * brief survives every failure. No PR, document or issue text is ever logged.
 */
import type { BlastRadius, Intent, PrBrief, PrBriefResponse } from '@devdigest/shared';
import { AppError, ConflictError, ExternalServiceError, NotFoundError, ValidationError } from '../../../platform/errors.js';
import type { PromptLogPort } from '../../../platform/prompt-log.js';
import {
  DESCRIPTION_MAX_CHARS,
  GENERATION_TIMEOUT_MS,
  ISSUE_BODY_MAX_CHARS,
  PROMPT_VERSION,
} from '../domain/constants.js';
import {
  buildMissingInputs,
  changedRanges,
  linkedIssueNumber,
  promptBlast,
  selectFiles,
  selectFindings,
  truncateText,
  usableBlast,
  type ChangedFile,
  type FindingFact,
  type IssueOutcome,
  type SpecsOutcome,
} from '../domain/input.js';
import { normalizeBrief, isStale, type DroppedCounts } from '../domain/normalize.js';
import { buildMessages, trimToBudget, type BriefInput } from '../domain/prompt.js';
import { briefPromptSections } from './prompt-sections.js';
import type {
  BlastSource,
  BriefModel,
  BriefPull,
  BriefStore,
  Clock,
  CurrentReview,
  GenerateResult,
  IntentSource,
  IssueSource,
  Logger,
  ModelUsage,
  ResolvedModel,
  SpecDocResult,
  SpecsResolver,
} from './ports.js';

export interface BriefDeps {
  store: BriefStore;
  intent: IntentSource;
  blast: BlastSource;
  specs: SpecsResolver;
  issues: IssueSource;
  model: BriefModel;
  clock: Clock;
  promptLog?: PromptLogPort;
  /** NFR6: wall-clock budget of one generation; tests shorten it. */
  timeoutMs?: number;
}

/** What the NFR5 generation line reports: ids, counts and enum-like labels, never PR text. */
interface RunStats {
  provider: string | null;
  model: string | null;
  modelRequests: number | null;
  tokensIn: number | null;
  tokensOut: number | null;
  costUsd: number | null;
  estTokensIn: number | null;
  dropped: DroppedCounts | null;
  missingInputs: string[] | null;
  outcome: string;
}

const generationFailed = (message: string) => new ExternalServiceError(message, undefined, 'generation_failed');

/** Reject with `generation_failed` as soon as `signal` aborts, even when `p` ignores it. */
function raceAbort<T>(p: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    p.catch(() => undefined);
    return Promise.reject(generationFailed('Generation timed out'));
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(generationFailed('Generation timed out'));
    signal.addEventListener('abort', onAbort, { once: true });
    p.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
  });
}

interface SpecsGathered {
  /** Reviews with a current row (including those whose agent was deleted). */
  reviewed: number;
  /** FR3: distinct documents, agents newest review first, first occurrence wins. */
  docs: SpecDocResult[];
}

export class BriefService {
  /** FR10: PRs with a generation running (one local API process). */
  private readonly inFlight = new Set<string>();

  constructor(private readonly deps: BriefDeps) {}

  /** GET: the stored brief and whether the head commit or the prompt version moved on. Never calls the model. */
  async get(workspaceId: string, prId: string): Promise<PrBriefResponse> {
    const pull = await this.requirePull(workspaceId, prId);
    const brief = await this.deps.store.getBrief(prId);
    return { brief, stale: brief ? isStale(brief, pull.headSha) : false };
  }

  /** POST: generate, verify, store and return a fresh brief. One generation per PR at a time. */
  async generate(workspaceId: string, prId: string, log: Logger): Promise<PrBriefResponse> {
    const pull = await this.requirePull(workspaceId, prId);
    if (this.inFlight.has(prId)) {
      throw new ConflictError('A brief is already being generated for this pull request', undefined, 'generation_in_progress');
    }
    this.inFlight.add(prId);
    const startedAt = Date.now();
    const stats: RunStats = {
      provider: null,
      model: null,
      modelRequests: null,
      tokensIn: null,
      tokensOut: null,
      costUsd: null,
      estTokensIn: null,
      dropped: null,
      missingInputs: null,
      outcome: 'ok',
    };
    try {
      return await this.run(workspaceId, pull, stats, log);
    } catch (err) {
      stats.outcome = err instanceof AppError ? err.code : 'internal_error';
      throw err;
    } finally {
      const line = { evt: 'brief_generated', prId, ...stats, durationMs: Date.now() - startedAt };
      if (stats.outcome === 'ok') log.info(line, 'pr brief generated');
      else log.warn(line, 'pr brief generation failed');
      this.inFlight.delete(prId);
    }
  }

  private async run(workspaceId: string, pull: BriefPull, stats: RunStats, log: Logger): Promise<PrBriefResponse> {
    const { store, model } = this.deps;
    const rows = await store.listFiles(pull.id);
    if (rows.length === 0) {
      throw new ValidationError('The pull request has no changed files', undefined, 'no_changed_files');
    }
    const signal = AbortSignal.timeout(this.deps.timeoutMs ?? GENERATION_TIMEOUT_MS);
    const resolved = await model.resolve(workspaceId);
    stats.provider = resolved.provider;
    stats.model = resolved.model;

    const files: ChangedFile[] = rows.map((r) => ({
      path: r.path,
      additions: r.additions,
      deletions: r.deletions,
      ranges: changedRanges(r.patch),
    }));
    const reviews = await store.currentReviews(pull.id);
    const findings: FindingFact[] = reviews.flatMap((r) =>
      r.findings.map((f) => ({ severity: f.severity, file: f.file, startLine: f.startLine, endLine: f.endLine, title: f.title })),
    );
    const issueNumber = linkedIssueNumber(pull.body);
    const [intent, blastRaw, specs, issue] = await Promise.all([
      this.readIntent(workspaceId, pull.id, log),
      this.readBlast(workspaceId, pull.id, log),
      this.gatherSpecs(workspaceId, pull, reviews),
      issueNumber === null ? Promise.resolve(null) : this.deps.issues.fetch(pull.repo, issueNumber),
    ]);
    if (signal.aborted) throw generationFailed('Generation timed out');

    const blast = blastRaw ? usableBlast(blastRaw) : null;
    const selected = selectFiles(files);
    const input: BriefInput = {
      title: pull.title,
      description: pull.body ? truncateText(pull.body, DESCRIPTION_MAX_CHARS) : null,
      headSha: pull.headSha,
      files: selected.files,
      moreFiles: selected.moreFiles,
      intent,
      blast: blast ? promptBlast(blast) : null,
      findings: selectFindings(findings),
      issue: issue ? { number: issue.number, title: issue.title, body: issue.body ? truncateText(issue.body, ISSUE_BODY_MAX_CHARS) : null } : null,
      specs: specs.docs.flatMap((d) => (d.status === 'included' && d.text !== undefined ? [{ path: d.path, text: d.text }] : [])),
    };
    const trimmed = trimToBudget(input);
    stats.estTokensIn = trimmed.estTokens;

    const specsOutcome: SpecsOutcome = {
      reviewedAgents: specs.reviewed,
      attachedDocs: specs.docs.length,
      unreadable: specs.docs.filter((d) => d.status === 'missing' || d.status === 'too_large' || d.status === 'unreadable').length,
      overBudget: specs.docs.filter((d) => d.status === 'over_budget').length + trimmed.droppedSpecs,
    };
    const issueOutcome: IssueOutcome = issueNumber === null ? 'not_linked' : issue ? 'fetched' : 'fetch_failed';
    const missing = buildMissingInputs({
      description: pull.body,
      hasIntent: intent !== null,
      blast: blastRaw,
      specs: specsOutcome,
      issue: issueOutcome,
    });
    stats.missingInputs = missing.map((m) => `${m.input}/${m.reason}`);

    this.deps.promptLog?.assembled({
      feature: 'brief',
      correlationId: `brief:${pull.id}:${pull.headSha.slice(0, 12)}`,
      provider: resolved.provider,
      model: resolved.model,
      sections: briefPromptSections(trimmed.input),
    });

    const result = await this.callModel(resolved, buildMessages(trimmed.input), signal, pull.id, trimmed.estTokens, log);
    stats.tokensIn = result.tokensIn;
    stats.tokensOut = result.tokensOut;
    stats.costUsd = result.costUsd;
    stats.modelRequests = result.attempts;
    if (signal.aborted) throw generationFailed('Generation timed out');

    const normalized = normalizeBrief(result.data, { files, findings, blast });
    stats.dropped = normalized.dropped;
    const brief: PrBrief = {
      summary: normalized.summary,
      risks: { risks: normalized.risks },
      review_focus: normalized.review_focus,
      intent,
      blast,
      missing_inputs: missing,
      specs_used: trimmed.input.specs.map((s) => s.path),
      head_sha: pull.headSha,
      generated_at: this.deps.clock().toISOString(),
      prompt_version: PROMPT_VERSION,
      provider: resolved.provider,
      model: resolved.model,
      tokens_in: result.tokensIn,
      tokens_out: result.tokensOut,
      cost_usd: result.costUsd,
      model_requests: result.attempts >= 2 ? 2 : 1,
    };
    await store.upsertBrief(pull.id, brief);
    return { brief, stale: false };
  }

  /** The one model call, with the NFR5 per-request log lines (attempt n, outcome; no text). */
  private async callModel(
    resolved: ResolvedModel,
    messages: Parameters<BriefModel['generate']>[1],
    signal: AbortSignal,
    prId: string,
    estTokensIn: number,
    log: Logger,
  ): Promise<GenerateResult> {
    const usages: ModelUsage[] = [];
    let ok = false;
    try {
      const result = await raceAbort(this.deps.model.generate(resolved, messages, signal, (u) => usages.push(u)), signal);
      ok = true;
      return result;
    } finally {
      usages.forEach((u, i) => {
        const last = i === usages.length - 1;
        log.info(
          {
            evt: 'brief_model_request',
            feature: 'brief',
            prId,
            attempt: i + 1,
            model: resolved.model,
            estTokensIn,
            tokensIn: u.tokensIn,
            tokensOut: u.tokensOut,
            outcome: !last ? 'invalid_output' : ok ? 'ok' : 'failed',
          },
          'pr brief model request',
        );
      });
    }
  }

  /** Per agent with a current review (newest first): its attached documents; merged, first path occurrence wins. */
  private async gatherSpecs(workspaceId: string, pull: BriefPull, reviews: readonly CurrentReview[]): Promise<SpecsGathered> {
    const agentIds = reviews.flatMap((r) => (r.agentId ? [r.agentId] : []));
    const perAgent = await Promise.all(
      agentIds.map(async (agentId) => {
        const skills = await this.deps.store.enabledSkills(agentId);
        const res = await this.deps.specs.resolveForRun({
          workspaceId,
          repoId: pull.repoId,
          repo: pull.repo,
          base: pull.base,
          headSha: pull.headSha,
          agentId,
          skills: skills.map((s) => ({ ...s, enabled: true })),
        });
        return res.docs;
      }),
    );
    const seen = new Set<string>();
    const docs: SpecDocResult[] = [];
    for (const d of perAgent.flat()) {
      if (seen.has(d.path)) continue;
      seen.add(d.path);
      docs.push(d);
    }
    return { reviewed: reviews.length, docs };
  }

  /** A failed intent read is "not derived": the brief is still generated. */
  private async readIntent(workspaceId: string, prId: string, log: Logger): Promise<Intent | null> {
    try {
      return await this.deps.intent.get(workspaceId, prId);
    } catch (err) {
      log.warn({ prId, err }, 'pr brief: intent read failed');
      return null;
    }
  }

  /** A failed blast read is "degraded" (null): the brief is still generated. */
  private async readBlast(workspaceId: string, prId: string, log: Logger): Promise<BlastRadius | null> {
    try {
      return await this.deps.blast.getBlast(workspaceId, prId, log);
    } catch (err) {
      log.warn({ prId, err }, 'pr brief: blast read failed');
      return null;
    }
  }

  private async requirePull(workspaceId: string, prId: string): Promise<BriefPull> {
    const pull = await this.deps.store.findPull(workspaceId, prId);
    if (!pull) throw new NotFoundError('Pull request not found');
    return pull;
  }
}
