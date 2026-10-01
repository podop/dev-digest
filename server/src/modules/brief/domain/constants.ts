/** PR Brief limits (specs/2026-10-01-pr-brief.md FR1, FR2, FR5, NFR1, D9). */

/**
 * Stored in every brief; a different value marks it stale on read (FR9).
 * Bump it on any change to the prompt text, the output schema or the output language.
 */
export const PROMPT_VERSION = 'v1'; // v1: first version, output language pinned to English

/** Structured-output schema name (also the mock LLM's fixture key). */
export const BRIEF_SCHEMA_NAME = 'PrBriefLlm';

/** The language the model must write in (trusted rule in the system prompt). */
export const BRIEF_LANGUAGE = 'English';

/** NFR1: total estimated input, and the model's output budget. */
export const INPUT_MAX_TOKENS = 8_000;
export const LLM_MAX_OUTPUT_TOKENS = 2_000;
/** FR1: one re-ask on an invalid structured response (`maxRetries` = reprompts). */
export const LLM_MAX_RETRIES = 1;
/** NFR6: a generation completes or fails within this wall-clock budget. */
export const GENERATION_TIMEOUT_MS = 120_000;
/** D9: the linked-issue fetch is raced against this. */
export const ISSUE_FETCH_TIMEOUT_MS = 10_000;

/** FR2: input caps. */
export const DESCRIPTION_MAX_CHARS = 4_000;
export const ISSUE_BODY_MAX_CHARS = 3_000;
export const MAX_FILES = 100;
export const MAX_RANGES_PER_FILE = 20;
export const MAX_FINDINGS = 30;
export const FINDING_TITLE_MAX_CHARS = 120;
export const MAX_CALLERS = 30;

/** FR5: output limits (the stored contract enforces the same numbers). */
export const SUMMARY_MAX = 600;
export const RISKS_MAX = 6;
export const RISK_TITLE_MAX = 120;
export const RISK_EXPLANATION_MAX = 600;
export const RISK_KIND_MAX = 60;
export const FOCUS_MAX = 8;
export const FOCUS_REASON_MAX = 160;
