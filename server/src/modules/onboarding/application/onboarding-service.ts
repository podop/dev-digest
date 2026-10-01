/**
 * Onboarding Tour use cases: read the stored tour with its derived stale flag, and
 * generate a new one — one LLM call over the repo-intel index and a few root files
 * read at the indexed commit; the model's paths are verified against the index
 * before anything is stored (the previous tour survives every failure).
 */
import type { OnboardingTour, OnboardingTourReady, OnboardingTourState } from '@devdigest/shared';
import { AppError, ConflictError, ExternalServiceError, NotFoundError, ValidationError } from '../../../platform/errors.js';
import {
  COMPOSE_CANDIDATES,
  ENV_EXAMPLE_PATH,
  GENERATION_TIMEOUT_MS,
  PACKAGE_JSON_PATH,
  PROMPT_VERSION,
  README_CANDIDATES,
  TODO_SCAN_FILES,
  TOP_FILES_COUNT,
} from '../domain/constants.js';
import {
  collectTodoLines,
  composeExcerpt,
  envVariableNames,
  findTodoLines,
  findUntestedFiles,
  packageScripts,
  readmeExcerpt,
} from '../domain/input.js';
import { buildMessages, type TourInput } from '../domain/prompt.js';
import { normalizeTour, staleness, type DroppedCounts } from '../domain/tour.js';
import type {
  Clock,
  Logger,
  OnboardingModel,
  OnboardingRepo,
  OnboardingStore,
  RepoFiles,
  RepoIndex,
} from './ports.js';

export interface OnboardingDeps {
  store: OnboardingStore;
  index: RepoIndex;
  files: RepoFiles;
  model: OnboardingModel;
  clock: Clock;
  /** Wall-clock budget of one generation (NFR5); tests shorten it. */
  timeoutMs?: number;
}

/** What the NFR4 log line reports; counts and ids only, never repo text. */
interface RunStats {
  provider: string | null;
  model: string | null;
  tokensIn: number | null;
  tokensOut: number | null;
  costUsd: number | null;
  dropped: DroppedCounts | null;
  outcome: string;
}

/** The text of the first candidate that exists, or null (`texts` aligns with `candidates`). */
function firstExisting(texts: readonly (string | null)[], from: number, count: number): string | null {
  for (let i = from; i < from + count; i++) {
    const text = texts[i];
    if (text !== null && text !== undefined) return text;
  }
  return null;
}

export class OnboardingService {
  /** FR8: repos with a generation running (one local API process). */
  private readonly inFlight = new Set<string>();

  constructor(private readonly deps: OnboardingDeps) {}

  /** GET: the stored tour and whether the index or the prompt moved on since. */
  async getTour(workspaceId: string, repoId: string): Promise<OnboardingTourState> {
    await this.requireRepo(workspaceId, repoId);
    const stored = await this.deps.store.getTour(repoId);
    if (!stored) return { status: 'none' };
    const state = await this.deps.index.getIndexState(repoId);
    const s = staleness(stored, state.lastIndexedSha || null);
    return s.stale
      ? { status: 'ready', stale: true, stale_reason: s.reason, tour: stored }
      : { status: 'ready', stale: false, tour: stored };
  }

  /** POST: generate, verify, store and return a fresh tour. One generation per repo at a time. */
  async generate(workspaceId: string, repoId: string, log: Logger): Promise<OnboardingTourReady> {
    const repo = await this.requireRepo(workspaceId, repoId);
    if (this.inFlight.has(repoId)) {
      throw new ConflictError('A tour is already being generated for this repository', undefined, 'generation_in_progress');
    }
    this.inFlight.add(repoId);
    const startedAt = Date.now();
    const stats: RunStats = {
      provider: null,
      model: null,
      tokensIn: null,
      tokensOut: null,
      costUsd: null,
      dropped: null,
      outcome: 'ok',
    };
    try {
      return await this.run(workspaceId, repo, stats);
    } catch (err) {
      stats.outcome = err instanceof AppError ? err.code : 'internal_error';
      throw err;
    } finally {
      const line = { repoId, ...stats, durationMs: Date.now() - startedAt };
      if (stats.outcome === 'ok') log.info(line, 'onboarding tour generated');
      else log.warn(line, 'onboarding tour generation failed');
      this.inFlight.delete(repoId);
    }
  }

  private async run(workspaceId: string, repo: OnboardingRepo, stats: RunStats): Promise<OnboardingTourReady> {
    const { index, files, model, store } = this.deps;
    const state = await index.getIndexState(repo.id);
    if (state.filesIndexed === 0 || !state.lastIndexedSha) {
      throw new ValidationError('The repository index is not ready yet', undefined, 'index_not_ready');
    }
    const sha = state.lastIndexedSha;
    const signal = AbortSignal.timeout(this.deps.timeoutMs ?? GENERATION_TIMEOUT_MS);
    const resolved = await model.resolve(workspaceId);
    stats.provider = resolved.provider;
    stats.model = resolved.model;

    const [repoMap, ranked, chains, indexedPaths] = await Promise.all([
      index.getRepoMap(repo.id),
      index.getTopFilesByRank(repo.id, TODO_SCAN_FILES),
      index.getCriticalPaths(repo.id),
      index.listIndexedFiles(repo.id),
    ]);
    const rootPaths = [...README_CANDIDATES, PACKAGE_JSON_PATH, ...COMPOSE_CANDIDATES, ENV_EXAMPLE_PATH];
    const [rootTexts, scanTexts] = await Promise.all([
      files.readMany(repo, sha, rootPaths, signal),
      files.readMany(repo, sha, ranked, signal),
    ]);
    if (signal.aborted) throw new ExternalServiceError('Generation timed out', undefined, 'generation_failed');

    const readme = firstExisting(rootTexts, 0, README_CANDIDATES.length);
    const pkg = rootTexts[README_CANDIDATES.length] ?? null;
    const compose = firstExisting(rootTexts, README_CANDIDATES.length + 1, COMPOSE_CANDIDATES.length);
    const env = rootTexts[rootPaths.length - 1] ?? null;
    const input: TourInput = {
      repoName: repo.fullName,
      defaultBranch: repo.defaultBranch,
      repoMap: repoMap.text,
      topFiles: ranked.slice(0, TOP_FILES_COUNT),
      chains,
      readme: readme === null ? null : readmeExcerpt(readme),
      packageScripts: pkg === null ? null : packageScripts(pkg),
      compose: compose === null ? null : composeExcerpt(compose),
      envNames: env === null ? [] : envVariableNames(env),
      todoLines: collectTodoLines(ranked.map((p, i) => findTodoLines(p, scanTexts[i] ?? ''))),
      untestedFiles: findUntestedFiles(ranked, indexedPaths),
    };

    const result = await model.generate(resolved, buildMessages(input), signal);
    stats.tokensIn = result.tokensIn;
    stats.tokensOut = result.tokensOut;
    stats.costUsd = result.costUsd;

    const { tour: content, dropped } = normalizeTour(result.data, indexedPaths);
    stats.dropped = dropped;
    const tour: OnboardingTour = {
      repo_id: repo.id,
      generated_at: this.deps.clock().toISOString(),
      indexed_sha: sha,
      files_indexed: state.filesIndexed,
      provider: resolved.provider,
      model: resolved.model,
      tokens_in: result.tokensIn,
      tokens_out: result.tokensOut,
      cost_usd: result.costUsd,
      prompt_version: PROMPT_VERSION,
      language: 'en',
      ...content,
    };
    await store.upsertTour(repo.id, tour);
    return { status: 'ready', stale: false, tour };
  }

  private async requireRepo(workspaceId: string, repoId: string): Promise<OnboardingRepo> {
    const repo = await this.deps.store.findRepo(workspaceId, repoId);
    if (!repo) throw new NotFoundError('Repo not found', undefined, 'repo_not_found');
    return repo;
  }
}
