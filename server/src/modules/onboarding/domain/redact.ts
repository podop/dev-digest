/**
 * Secret redaction for repo text that is sent to a third-party model (README,
 * docker-compose). Pure: text in, text out. Passes — (a) `scheme://user:PASS@host`
 * URL userinfo; (b) the VALUE of a `KEY: value` / `KEY=value` pair whose key looks
 * secret, at the start of a line (whole rest of the line, plus the body of a `|` / `>`
 * block scalar) or anywhere on a line (one-line JSON, YAML flow maps, `-e KEY=v`),
 * keeping the key so the model still sees the variable exists; (c) any secret-looking
 * token anywhere.
 *
 * A key is secret by its whole SEGMENTS (split on `_ - .` and camelCase), not by a
 * substring: `max_tokens`, `token_budget`, `authentication`, `author` stay.
 */

export const REDACTED = '<redacted>';

const STRONG_WORDS = new Set(['password', 'passwd', 'passphrase', 'pass', 'secret', 'credential', 'credentials', 'authorization', 'bearer', 'apikey']);
/** Compound lowercase keys (`dbpassword`, `clientsecret`, `authtoken`): a segment that ENDS with one of these. */
const STRONG_SUFFIXES = ['password', 'passwd', 'passphrase', 'secret', 'apikey'];
/** `token` (singular) is secret unless the key says it is a number, size or location of one. */
const TOKEN_BENIGN = new Set(['budget', 'limit', 'count', 'max', 'min', 'total', 'size', 'length', 'ttl', 'expiry', 'expires', 'usage', 'type', 'url', 'endpoint', 'path', 'file']);
/** `key` is secret only after one of these (`api_key`, `ssh-key`, `privateKey`); a bare `key` or `primary_key` is not. */
const KEY_PREFIXES = new Set(['access', 'private', 'secret', 'client', 'api', 'auth', 'signing', 'encryption', 'master', 'session', 'jwt', 'ssh', 'deploy']);

type Strength = 'strong' | 'weak';

function segmentsOf(key: string): string[] {
  return key
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .toLowerCase()
    .split(/[\s_.-]+/)
    .filter(Boolean);
}

/** `strong` = redact any non-reference value; `weak` = a token/key whose numeric value is not a secret. */
function classifyKey(key: string): Strength | null {
  const segs = segmentsOf(key);
  if (segs.some((s) => STRONG_WORDS.has(s) || STRONG_SUFFIXES.some((x) => s.endsWith(x)))) return 'strong';
  const hasToken = segs.some((s) => s.endsWith('token'));
  if (hasToken && !segs.some((s) => TOKEN_BENIGN.has(s))) return 'weak';
  const keyAt = segs.indexOf('key');
  if (keyAt > 0 && segs.slice(0, keyAt).some((s) => KEY_PREFIXES.has(s))) return 'weak';
  return null;
}

const BOOLEAN_RE = /^(?:true|false|yes|no|on|off|null|~)$/i;
const NUMBER_RE = /^[+-]?\d+(?:\.\d+)?$/;
/** `${VAR}` / `${VAR:-x}` or `$UPPER_NAME` — a reference, not a literal. `$ecret` is a literal. */
const ENV_REF_RE = /^(?:\$\{[A-Za-z_][^}\s]*\}|\$[A-Z_][A-Z0-9_]*)$/;
/** A line that only opens a collection (`"credentials": {`): the secrets are on the lines below. */
const OPENER_RE = /^[[{]\s*[\]}]?,?$/;
const BLOCK_SCALAR_RE = /^[|>][+-]?\d*[+-]?\s*(?:#.*)?$/;

function unquote(v: string): string {
  const q = v[0];
  return v.length >= 2 && (q === '"' || q === "'") && v.endsWith(q) ? v.slice(1, -1) : v;
}

function isRedactable(strength: Strength, rawValue: string): boolean {
  const v = unquote(rawValue.trim());
  if (v === '' || v === REDACTED || OPENER_RE.test(v) || BOOLEAN_RE.test(v) || ENV_REF_RE.test(v)) return false;
  if (strength === 'weak' && NUMBER_RE.test(v)) return false;
  return true;
}

/** prefix (indent, `- `, `export `) · optional quote · key · optional quote · `:`/`=` · value */
const KEY_VALUE_LINE_RE = /^(\s*(?:-\s+)?(?:export\s+)?)(["']?)([A-Za-z_][\w.-]*)\2(\s*[:=]\s*)(.*)$/;

/** `key: value` / `"key":"value"` / `KEY=value` anywhere on a line; a value is a quoted string or one unspaced word (optionally `Bearer x`). */
const EMBEDDED_PAIR_RE =
  /(?<![\w.])(["']?)([A-Za-z_][\w.-]*)\1(\s*[:=]\s*)("(?:[^"\\\n]|\\.)*"|'[^'\n]*'|\$\{[^}\s]*\}|(?:(?:Bearer|Basic)\s+)?[^\s,{}[\]"']+)/gi;

/** `scheme://user:PASSWORD@host` — only the password part. */
const URL_USERINFO_RE = /\b([a-z][a-z0-9+.-]*:\/\/[^\s:@/]*:)([^\s@/]+)@/gi;

const TOKEN_RES: readonly RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g,
  /\bsk-[A-Za-z0-9_-]{10,}/g,
  /\b[sp]k_(?:live|test)_[A-Za-z0-9]{8,}/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}/g,
];

function redactUrlUserinfo(text: string): string {
  return text.replace(URL_USERINFO_RE, (all, head: string, password: string) =>
    password === REDACTED || ENV_REF_RE.test(password) ? all : `${head}${REDACTED}@`,
  );
}

function redactEmbedded(line: string): string {
  return line.replace(EMBEDDED_PAIR_RE, (all, quote: string, key: string, sep: string, value: string) => {
    const strength = classifyKey(key);
    if (!strength || !isRedactable(strength, value)) return all;
    const q = value[0] === '"' || value[0] === "'" ? value[0] : '';
    return `${quote}${key}${quote}${sep}${q}${REDACTED}${q}`;
  });
}

interface LineResult {
  line: string;
  /** Set when the line opens a block scalar of a secret key: the deeper-indented lines that follow are its body. */
  blockIndent: number | null;
}

function redactLine(line: string): LineResult {
  const m = KEY_VALUE_LINE_RE.exec(line);
  if (m) {
    const [, prefix = '', quote = '', key = '', sep = '', value = ''] = m;
    const strength = classifyKey(key);
    if (strength) {
      const v = value.trim();
      if (BLOCK_SCALAR_RE.test(v)) return { line, blockIndent: (/^\s*/.exec(line)?.[0] ?? '').length };
      if (isRedactable(strength, v)) return { line: `${prefix}${quote}${key}${quote}${sep}${REDACTED}`, blockIndent: null };
    }
  }
  return { line: redactEmbedded(line), blockIndent: null };
}

export function redactSecrets(text: string): string {
  let out = redactUrlUserinfo(text);
  for (const re of TOKEN_RES) out = out.replace(re, REDACTED);

  const lines = out.split('\n');
  const result: string[] = [];
  const strip = (l: string) => (l.endsWith('\r') ? l.slice(0, -1) : l);
  const cr = (l: string) => (l.endsWith('\r') ? '\r' : '');
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i] ?? '';
    const { line, blockIndent } = redactLine(strip(raw));
    result.push(line + cr(raw));
    if (blockIndent === null) continue;
    // Body of a `|` / `>` block scalar: every non-blank line indented deeper than its key.
    for (let next = lines[i + 1]; next !== undefined; next = lines[i + 1]) {
      const body = strip(next);
      const indent = (/^\s*/.exec(body)?.[0] ?? '').length;
      if (body.trim() !== '' && indent <= blockIndent) break;
      result.push((body.trim() === '' ? body : `${body.slice(0, indent)}${REDACTED}`) + cr(next));
      i += 1;
    }
  }
  return result.join('\n');
}
