import { ALLOWED_TRIGGERS, FORK_GUARD_EXPR, MAX_WORKFLOW_BYTES, SECRET_NAMES } from './constants.js';

/** Rule ids of the workflow rule list (spec §7) — the `details.rule` of 422 `workflow_insecure`. */
export type WorkflowRule =
  | 'invalid_yaml'
  | 'forbidden_trigger'
  | 'permissions'
  | 'secrets'
  | 'unpinned_action'
  | 'fork_guard'
  | 'untrusted_expression';

export type WorkflowCheck = { ok: true } | { ok: false; rule: WorkflowRule };

type Json = Record<string, unknown>;

const isMap = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);

// Owner never starts with `.` (so `./x`, `../x` local actions are rejected); repo is never `.`/`..`.
const PINNED_ACTION =
  /^[A-Za-z0-9_-][A-Za-z0-9_.-]*\/(?!\.{1,2}(?:\/|@))[A-Za-z0-9_.-]+(\/[A-Za-z0-9_./-]+)?@[0-9a-fA-F]{40}$/;
const EXPRESSION = /\$\{\{([\s\S]*?)\}\}/g;
const SECRET_REF = /\bsecrets\b(?:\.([A-Za-z0-9_]+))?/gi;
const UNTRUSTED = [
  'github.event.pull_request.title',
  'github.event.pull_request.body',
  'github.event.pull_request.head.ref',
  'github.event.pull_request.head.label',
  'github.head_ref',
  'github.event.comment',
  // Whole-object dumps would carry the same attacker-controlled fields.
  'tojson(github)',
  'tojson(github.event',
];

/** Every string scalar of the parsed document (keys excluded). */
function scalars(node: unknown, out: string[] = []): string[] {
  if (typeof node === 'string') out.push(node);
  else if (Array.isArray(node)) for (const v of node) scalars(v, out);
  else if (isMap(node)) for (const v of Object.values(node)) scalars(v, out);
  return out;
}

/** Values of every `if` key — GitHub evaluates them as expressions without `${{ }}`. */
function ifValues(node: unknown, out: string[] = []): string[] {
  if (Array.isArray(node)) for (const v of node) ifValues(v, out);
  else if (isMap(node)) {
    for (const [k, v] of Object.entries(node)) {
      if (k === 'if' && typeof v === 'string') out.push(v);
      else ifValues(v, out);
    }
  }
  return out;
}

/** All expression bodies of the document: `${{ … }}` blocks plus bare `if:` values. */
function expressions(doc: unknown): string[] {
  const out: string[] = [...ifValues(doc)];
  for (const s of scalars(doc)) for (const m of s.matchAll(EXPRESSION)) out.push(m[1] ?? '');
  return out;
}

/** `a['b']` -> `a.b`, lowercased, whitespace removed — so notation tricks cannot dodge the checks. */
const normalize = (expr: string): string =>
  expr
    .replace(/\[\s*['"]?([A-Za-z0-9_-]+)['"]?\s*\]/g, '.$1')
    .replace(/\s+/g, '')
    .toLowerCase();

function jobsOf(doc: Json): Json[] | null {
  if (!isMap(doc.jobs)) return null;
  const jobs = Object.values(doc.jobs);
  return jobs.length > 0 && jobs.every(isMap) ? jobs : null;
}

function triggerOk(on: unknown): boolean {
  if (!isMap(on)) return false;
  if (Object.keys(on).length !== 1 || !('pull_request' in on)) return false;
  const pr = on.pull_request;
  if (pr === null || pr === undefined) return true;
  if (!isMap(pr)) return false;
  const types = pr.types;
  if (types === undefined) return true;
  const list = Array.isArray(types) ? types : [types];
  return list.every((t) => typeof t === 'string' && (ALLOWED_TRIGGERS as readonly string[]).includes(t));
}

function permissionsOk(doc: Json, jobs: Json[]): boolean {
  const top = doc.permissions;
  if (!isMap(top)) return false;
  const entries = Object.entries(top);
  if (entries.length !== 2 || top.contents !== 'read' || top['pull-requests'] !== 'write') return false;
  for (const job of jobs) {
    const p = job.permissions;
    if (p === undefined) continue;
    if (!isMap(p)) return false; // `write-all` / `read-all` shorthand
    for (const [name, level] of Object.entries(p)) {
      if (level === 'write' && name !== 'pull-requests') return false;
    }
  }
  return true;
}

function secretsOk(jobs: Json[], exprs: string[]): boolean {
  if (jobs.some((j) => 'secrets' in j)) return false; // `secrets: inherit` / reusable-workflow secrets
  for (const expr of exprs) {
    for (const m of expr.matchAll(SECRET_REF)) {
      if (!(SECRET_NAMES as readonly string[]).includes(m[1] ?? '')) return false;
    }
  }
  return true;
}

function actionsPinned(jobs: Json[]): boolean {
  for (const job of jobs) {
    if ('uses' in job && !(typeof job.uses === 'string' && PINNED_ACTION.test(job.uses))) return false;
    const steps = Array.isArray(job.steps) ? job.steps : [];
    for (const step of steps) {
      if (isMap(step) && 'uses' in step && !(typeof step.uses === 'string' && PINNED_ACTION.test(step.uses))) {
        return false;
      }
    }
  }
  return true;
}

function forkGuarded(jobs: Json[]): boolean {
  return jobs.every((job) => {
    if (typeof job.if !== 'string') return false;
    const bare = job.if.trim().replace(/^\$\{\{([\s\S]*)\}\}$/, '$1').replace(/\s+/g, ' ').trim();
    return bare === FORK_GUARD_EXPR;
  });
}

/** True when the workflow text is over the size limit — checked BEFORE it is parsed. */
export const workflowTooLarge = (text: string): boolean =>
  new TextEncoder().encode(text).length > MAX_WORKFLOW_BYTES;

/**
 * Check an already-parsed workflow document against the rule list of spec §7. Pure; returns the
 * first broken rule. Size and YAML syntax are the caller's job (`invalid_yaml` before this runs).
 */
export function checkWorkflowDocument(doc: unknown): WorkflowCheck {
  if (!isMap(doc)) return { ok: false, rule: 'invalid_yaml' };

  const jobs = jobsOf(doc);
  if (!jobs) return { ok: false, rule: 'invalid_yaml' };

  if (!triggerOk(doc.on)) return { ok: false, rule: 'forbidden_trigger' };
  if (!permissionsOk(doc, jobs)) return { ok: false, rule: 'permissions' };

  const exprs = expressions(doc);
  if (!secretsOk(jobs, exprs)) return { ok: false, rule: 'secrets' };
  if (!actionsPinned(jobs)) return { ok: false, rule: 'unpinned_action' };
  if (!forkGuarded(jobs)) return { ok: false, rule: 'fork_guard' };
  if (exprs.some((e) => UNTRUSTED.some((u) => normalize(e).includes(u)))) {
    return { ok: false, rule: 'untrusted_expression' };
  }
  return { ok: true };
}
