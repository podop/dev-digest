/**
 * Constants of the Export-to-CI module (specs/export-to-ci.md). Pure data:
 * repo paths, names, pins and limits shared by the generators and by ingest.
 */

// --- `.devdigest/` layout written into the TARGET repo --------------------
export const AGENTS_DIR = '.devdigest/agents';
export const SKILLS_DIR = '.devdigest/skills';
export const MEMORY_FILE_PATH = '.devdigest/memory.jsonl';
export const RUNNER_ENTRY_PATH = '.devdigest/runner/index.js';
export const RUNNER_RUN_COMMAND = `node ${RUNNER_ENTRY_PATH}`;
export const WORKFLOWS_DIR = '.github/workflows';

export const manifestPathFor = (slug: string): string => `${AGENTS_DIR}/${slug}.yaml`;
export const skillPathFor = (skillSlug: string): string => `${SKILLS_DIR}/${skillSlug}.md`;
export const workflowPathFor = (slug: string): string =>
  `${WORKFLOWS_DIR}/devdigest-review-${slug}.yml`;

// --- Export PR ------------------------------------------------------------
export const CI_BRANCH = 'devdigest/ci';
export const CI_PR_TITLE = 'Add DevDigest CI review';
export const CI_COMMIT_MESSAGE = 'Add DevDigest CI review';

// --- Names the studio and the workflow agree on ---------------------------
/** Check (= job = workflow) name; the user marks it as a required status check. */
export const checkNameFor = (slug: string): string => `DevDigest Review · ${slug}`;
export const RESULT_FILE_NAME = 'devdigest-result.json';
export const artifactNameFor = (slug: string): string => `devdigest-result-${slug}`;

// --- Slugs ----------------------------------------------------------------
export const SLUG_MAX_LENGTH = 40;
/** Same shape the runner accepts for `DEVDIGEST_AGENT`. */
export const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{0,39}$/;
export const AGENT_SLUG_FALLBACK = 'agent';
export const SKILL_SLUG_FALLBACK = 'skill';

// --- Workflow generation --------------------------------------------------
export const ALLOWED_TRIGGERS = ['opened', 'synchronize', 'reopened'] as const;
export type CiTrigger = (typeof ALLOWED_TRIGGERS)[number];
export const POST_AS_VALUES = ['github_review', 'pr_comment', 'none'] as const;
export type CiPostAs = (typeof POST_AS_VALUES)[number];

export const RUNNER_OS = 'ubuntu-24.04';
export const NODE_VERSION = '22';
export const FORK_GUARD_EXPR =
  'github.event.pull_request.head.repo.full_name == github.repository';
export const SECRET_NAMES = ['OPENROUTER_API_KEY', 'GITHUB_TOKEN'] as const;

/** Full-commit-SHA pins — the same ones this repo's own workflows use. */
export const ACTION_PINS = {
  checkout: 'actions/checkout@11d5960a326750d5838078e36cf38b85af677262',
  setupNode: 'actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020',
  uploadArtifact: 'actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02',
} as const;

// --- Limits ---------------------------------------------------------------
export const MAX_WORKFLOW_BYTES = 65_536;
export const MAX_ARTIFACT_ZIP_BYTES = 1_048_576;
export const MAX_ARTIFACT_JSON_BYTES = 65_536;

// --- Refresh --------------------------------------------------------------
export const RUNS_PER_INSTALLATION = 30;
export const REFRESH_BUDGET_MS = 45_000;
