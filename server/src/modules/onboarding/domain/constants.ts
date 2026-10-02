/** Onboarding Tour limits (specs/2026-10-01-onboarding-generator.md FR2, FR3, FR9, NFR1). */

/** Bumping this marks every stored tour stale (`prompt_changed`). */
export const PROMPT_VERSION = 1; // v1: first version, output language pinned to English

/** Structured-output schema name (also the mock LLM's fixture key). */
export const ONBOARDING_SCHEMA_NAME = 'OnboardingTour';

/** NFR1: total estimated input, and the model's output budget. */
export const INPUT_MAX_TOKENS = 24_000;
export const LLM_MAX_OUTPUT_TOKENS = 4_000;
/** FR1: one retry on an invalid structured response (`maxRetries` = reprompts). */
export const LLM_MAX_RETRIES = 1;
/** NFR5: a generation completes or fails within this wall-clock budget. */
export const GENERATION_TIMEOUT_MS = 120_000;

/** FR2: top ranked files listed in the prompt. */
export const TOP_FILES_COUNT = 40;

/** FR3: the repo files read at the indexed commit (at most 4 are sent). */
export const README_CANDIDATES = ['README.md', 'README', 'readme.md'] as const;
export const PACKAGE_JSON_PATH = 'package.json';
export const COMPOSE_CANDIDATES = ['docker-compose.yml', 'docker-compose.yaml', 'compose.yml', 'compose.yaml'] as const;
export const ENV_EXAMPLE_PATH = '.env.example';
export const README_MAX_CHARS = 16 * 1024;
export const COMPOSE_MAX_CHARS = 8 * 1024;
/** `package.json#scripts` rendered text cap (the whole block is small in practice). */
export const SCRIPTS_MAX_CHARS = 4_000;
export const ENV_NAMES_MAX = 100;
/** A root file is never read past this size (readFileAt throws above it); excerpts are cut in the domain. */
export const FILE_FETCH_MAX_BYTES = 512 * 1024;
/** Concurrent `git show` reads while collecting TODO lines. */
export const READ_CONCURRENCY = 8;

/** FR9: first-task candidate signals. */
export const TODO_SCAN_FILES = 200;
export const TODO_MAX = 20;
export const TODO_LINE_MAX_CHARS = 160;
export const UNTESTED_MAX = 10;
