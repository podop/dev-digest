/**
 * Run steps are model output derived from untrusted repo text (README, compose), and
 * the UI offers them for copy-paste. A step that downloads-and-executes, escalates
 * privileges or destroys data is dropped, never shown. Pure and conservative: a false
 * positive only costs one run step; a false negative could cost a user their machine.
 */

/** Always runs what it reads, whatever its arguments. */
const SHELLS = String.raw`(?:sh|bash|zsh|dash|ash|ksh|fish|csh|tcsh|iex|invoke-expression|powershell|pwsh|cmd)`;
/** Language interpreters: dangerous only when the program comes from stdin. */
const INTERPRETERS = String.raw`(?:python[\d.]*|nodejs|node|perl|ruby)`;
const DOWNLOADER = '(?:curl|wget|iwr|irm|invoke-webrequest|invoke-restmethod)';
/** `/bin/`, `/usr/bin/` -style path prefix, `./`, `~/bin/`. */
const PATH_PREFIX = String.raw`(?:[\w.~$-]*/)*`;
/** `sudo`, `env`, `xargs`… (with their flags / VAR=x) in front of the program that receives the pipe. */
const WRAPPERS = String.raw`(?:${PATH_PREFIX}(?:sudo|doas|env|xargs|nohup|exec|command|time|nice|stdbuf|timeout)\b(?:\s+(?:-\S+|\w+=\S*))*\s+)*`;
const NAME_END = String.raw`(?![\w-])`;
/** After an interpreter: nothing / a separator (reads stdin), or a standalone `-` (program from stdin). */
const STDIN_TAIL = String.raw`(?:\s+-[uBsSEIOq]+)*(?:\s*(?=$|[;&|)<>\n])|\s+-(?=\s|$))`;

const PIPE_TO = String.raw`\|\s*${WRAPPERS}${PATH_PREFIX}`;

const DANGEROUS: readonly RegExp[] = [
  // downloaded content piped into a shell (optionally behind sudo / env / xargs, by path)…
  new RegExp(String.raw`\b${DOWNLOADER}\b[^\n]*${PIPE_TO}${SHELLS}${NAME_END}`, 'i'),
  // …or into an interpreter that reads its program from stdin (`| python`, `| node -`; not `| python -m json.tool`)
  new RegExp(String.raw`\b${DOWNLOADER}\b[^\n]*${PIPE_TO}${INTERPRETERS}${NAME_END}${STDIN_TAIL}`, 'i'),
  // sh -c "$(curl …)" · bash <(curl …) · iex (iwr …)
  new RegExp(String.raw`\b(?:${SHELLS}|${INTERPRETERS})\b[^\n]*(?:\$\(|<\(|\(|\x60)\s*${DOWNLOADER}\b`, 'i'),
  // privilege escalation
  /(?:^|[\s;&|(])sudo\b/i,
  // rm of the filesystem root or the home directory
  /\brm\s+(?:-{1,2}[\w-]+\s+)+(?:--\s+)?(?:\/|~\/?|\$HOME\/?)\*?(?=\s|$|[;&|])/i,
  // filesystem creation / raw disk reads and writes
  /\bmkfs(?:\.\w+)?\b/i,
  /\bdd\s+(?:\S+\s+)*if=/i,
  // fork bomb
  /:\s*\(\s*\)\s*\{/,
  // base64 decoded straight into a shell / eval
  new RegExp(String.raw`\bbase64\b[^\n|]*(?:-d|-D|--decode)\b[^\n]*${PIPE_TO}${SHELLS}${NAME_END}`, 'i'),
  new RegExp(String.raw`\b(?:eval|${SHELLS}|${INTERPRETERS})\b[^\n]*\bbase64\b[^\n]*(?:-d|-D|--decode)\b`, 'i'),
];

// --- download to a file, run that file later -------------------------------------------

const SEPARATORS = new Set([';', '&', '|', '\n', '(', ')']);
const WRAPPER_WORDS = new Set(['sudo', 'doas', 'env', 'nohup', 'exec', 'command', 'time', 'nice', 'stdbuf', 'timeout', 'xargs']);
const RUNNER_RE = new RegExp(String.raw`^(?:${SHELLS}|${INTERPRETERS}|source|\.)$`, 'i');
const DOWNLOADER_RE = new RegExp(`^${DOWNLOADER}$`, 'i');

/** Split a command line into simple commands, each a list of unquoted words. */
function tokenize(command: string): string[][] {
  const commands: string[][] = [];
  let words: string[] = [];
  let word = '';
  let inWord = false;
  let quote = '';
  const endWord = () => {
    if (inWord) words.push(word);
    word = '';
    inWord = false;
  };
  const endCommand = () => {
    endWord();
    if (words.length > 0) commands.push(words);
    words = [];
  };
  for (let i = 0; i < command.length; i++) {
    const c = command[i] ?? '';
    if (quote) {
      if (c === quote) quote = '';
      else word += c;
    } else if (c === '"' || c === "'") {
      quote = c;
      inWord = true;
    } else if (c === '\\' && i + 1 < command.length) {
      word += command[++i];
      inWord = true;
    } else if (SEPARATORS.has(c)) endCommand();
    else if (/\s/.test(c)) endWord();
    else {
      word += c;
      inWord = true;
    }
  }
  endCommand();
  return commands;
}

const baseName = (p: string): string => (p.split(/[?#]/)[0] ?? '').replace(/\/+$/, '').split('/').pop() ?? '';

/** Files a downloader command writes: `-o f` (curl), `-O f` (wget), `-OutFile f`, or the URL's name for `curl -O` / bare `wget`. */
function downloadedFiles(words: string[]): string[] {
  const at = words.findIndex((w) => DOWNLOADER_RE.test(baseName(w)));
  if (at < 0) return [];
  const tool = baseName(words[at] ?? '').toLowerCase();
  const args = words.slice(at + 1);
  const files: string[] = [];
  let remoteName = tool === 'wget';
  for (let i = 0; i < args.length; i++) {
    const a = args[i] ?? '';
    const next = args[i + 1];
    if (tool === 'curl') {
      if (/^--output$/.test(a) || /^-[A-Za-z]*o$/.test(a)) {
        if (next) files.push(next);
      } else if (/^--output=/.test(a)) files.push(a.slice('--output='.length));
      else if (a === '--remote-name' || /^-[A-Za-z]*O[A-Za-z]*$/.test(a)) remoteName = true;
    } else if (tool === 'wget') {
      if (a === '--output-document' || a === '-O' || /^-[A-Za-z]*O$/.test(a)) {
        if (next) files.push(next);
        remoteName = false;
      } else if (a.startsWith('--output-document=')) {
        files.push(a.slice('--output-document='.length));
        remoteName = false;
      }
    } else if (/^-outfile$/i.test(a) && next) files.push(next);
  }
  if (remoteName) for (const a of args) if (/^[a-z][a-z0-9+.-]*:\/\//i.test(a)) files.push(baseName(a) || 'index.html');
  return files.map(baseName).filter(Boolean);
}

/** Does this simple command execute (a shell/interpreter on, or directly) one of `files`? */
function runsOneOf(words: string[], files: Set<string>): boolean {
  let i = 0;
  while (i < words.length) {
    const w = words[i] ?? '';
    if (WRAPPER_WORDS.has(baseName(w).toLowerCase()) || w.startsWith('-') || /^\w+=/.test(w)) i += 1;
    else break;
  }
  const head = words[i];
  if (head === undefined) return false;
  if (files.has(baseName(head))) return true;
  if (!RUNNER_RE.test(baseName(head))) return false;
  const script = words.slice(i + 1).find((a) => !a.startsWith('-'));
  return script !== undefined && files.has(baseName(script));
}

function downloadsThenRuns(command: string): boolean {
  const commands = tokenize(command);
  for (let i = 0; i < commands.length; i++) {
    const files = new Set(downloadedFiles(commands[i] ?? []));
    if (files.size === 0) continue;
    if (commands.slice(i + 1).some((c) => runsOneOf(c, files))) return true;
  }
  return false;
}

export function isDangerousCommand(command: string): boolean {
  return DANGEROUS.some((re) => re.test(command)) || downloadsThenRuns(command);
}
