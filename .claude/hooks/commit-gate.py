#!/usr/bin/env python3
"""PreToolUse hook: block Claude's `git commit` / `git commit-tree` unless the gates report is green.

  registered in .claude/settings.json (event PreToolUse, matcher Bash); spec: specs/2026-10-15-commit-test-gate.md
  tests: python3 .claude/hooks/test_commit_gate.py   (from the repo root)

For a gated commit the hook computes the working-tree state (the same hash as
`./scripts/gates.sh --state`) and reads `.devdigest/gates/<state>.json`. It never runs
gates, never executes the command text and never calls an LLM. Allow = exit 0 with no
output; block = exit 2 with the reason on stderr. Docs-only commits are allowed unchecked.

Fail mode: an error before a call is identified as a gated commit lets it through; an
error after identification blocks it (`internal-error`). Escape hatch: launch Claude Code
with DEVDIGEST_COMMIT_GATE=off (the variable inside the command text has no effect).
Blocks, bypasses and internal errors are appended to .devdigest/commit-gate/log.jsonl.
"""
from __future__ import annotations

import datetime
import importlib.util
import json
import os
import re
import subprocess
import sys
from typing import Any, Dict, List, NamedTuple, Optional, Tuple

sys.dont_write_bytecode = True

HOOK_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
LOG_PATH = os.path.join(HOOK_ROOT, ".devdigest", "commit-gate", "log.jsonl")
PACKAGES = ("reviewer-core", "server", "client", "e2e", "mcp")
TEST_GATE = {
    "server": "server:unit",
    "client": "client:test",
    "reviewer-core": "reviewer-core:test",
    "mcp": "mcp:test",
    "e2e": "e2e:typecheck",
}
GIT_TIMEOUT = 5
MAX_DEPTH = 4
MAX_MSG = 1200

SHELLS = ("sh", "bash", "zsh", "dash", "ksh")
WRAPPERS = ("env", "command", "exec", "nohup", "time", "nice")
KEYWORDS = ("{", "}", "!", "if", "then", "else", "elif", "fi", "do", "done", "while", "until")
ASSIGN_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*=")
HEREDOC_RE = re.compile(r"(?<!<)<<(?!<)(-?)[ \t]*(?:'([^'\n]*)'|\"([^\"\n]*)\"|\\?([A-Za-z_][A-Za-z0-9_]*))")
SHELL_LINE_RE = re.compile(r"(?:^|[\s;&|(/])(?:ba|z|da|k)?sh(?:\s|$)")
GIT_WORD_RE = re.compile(r"\bgit\b")
COMMIT_WORD_RE = re.compile(r"\bcommit\b")

# git global options that take a separate value
GIT_OPTS_WITH_VALUE = ("-C", "-c", "--git-dir", "--work-tree", "--namespace", "--super-prefix", "--config-env")
GIT_OPTS_FORWARDED = ("-C", "--git-dir", "--work-tree")

# builtin subcommands: no alias lookup (and therefore no git process) for these
BUILTINS = frozenset("""
add am annotate apply archive bisect blame branch bugreport bundle cat-file check-attr check-ignore
check-mailmap check-ref-format checkout checkout-index cherry cherry-pick citool clean clone column
commit-graph config count-objects credential describe diagnose diff diff-files diff-index diff-tree
difftool fast-export fast-import fetch fetch-pack filter-branch fmt-merge-msg for-each-ref
for-each-repo format-patch fsck gc get-tar-commit-id grep gui hash-object help hook init
interpret-trailers log ls-files ls-remote ls-tree mailinfo mailsplit maintenance merge merge-base
merge-file merge-index merge-tree mergetool mktag mktree multi-pack-index mv name-rev notes
pack-objects pack-redundant pack-refs patch-id prune prune-packed pull push range-diff read-tree
rebase receive-pack reflog refs remote repack replace request-pull rerere reset restore rev-list
rev-parse revert rm scalar send-email send-pack shortlog show show-branch show-index show-ref
sparse-checkout stash status stripspace submodule switch symbolic-ref tag unpack-file
unpack-objects update-index update-ref update-server-info upload-archive upload-pack var verify-commit
verify-pack verify-tag version whatchanged worktree write-tree
""".split())

# `git commit` options whose value is the next argument
COMMIT_LONG_WITH_VALUE = frozenset("""
message file author date reuse-message reedit-message template cleanup fixup squash trailer
pathspec-from-file
""".split())


class ParseError(Exception):
    pass


class GitError(Exception):
    pass


class ReportError(Exception):
    pass


class Commit(NamedTuple):
    kind: str  # commit | commit-tree | unparsed
    dir: str
    git_opts: List[str]
    args: List[str]


# --------------------------------------------------------------------------- git


def existing_dir(path: str) -> str:
    path = os.path.abspath(path)
    while not os.path.isdir(path):
        parent = os.path.dirname(path)
        if parent == path:
            break
        path = parent
    return path


def git(cwd: str, *args: str) -> Tuple[int, str, str]:
    """Run git with an argument vector: no shell, bounded time. Returns (rc, stdout, stderr)."""
    res = subprocess.run(
        ["git", *args], cwd=existing_dir(cwd), capture_output=True, text=True, errors="replace",
        timeout=GIT_TIMEOUT, check=False,
    )
    return res.returncode, res.stdout, res.stderr


# ------------------------------------------------------------------- tokenising


def strip_heredocs(text: str) -> Tuple[str, List[str]]:
    """Remove heredoc markers and bodies. Bodies fed to a shell come back as scripts."""
    lines = text.split("\n")
    out: List[str] = []
    scripts: List[str] = []
    i = 0
    while i < len(lines):
        pending: List[Tuple[bool, str]] = []

        def repl(m: "re.Match[str]") -> str:
            delim = m.group(2) if m.group(2) is not None else (m.group(3) if m.group(3) is not None else m.group(4))
            pending.append((m.group(1) == "-", delim))
            return ""

        line = HEREDOC_RE.sub(repl, lines[i])
        out.append(line)
        i += 1
        for strip_tabs, delim in pending:
            j = i
            body: List[str] = []
            while j < len(lines) and (lines[j].lstrip("\t") if strip_tabs else lines[j]) != delim:
                body.append(lines[j])
                j += 1
            if j >= len(lines):  # unterminated: keep the text, block more rather than less
                break
            if SHELL_LINE_RE.search(line):
                scripts.append("\n".join(body))
            i = j + 1
    return "\n".join(out), scripts


def match_paren(text: str, k: int) -> int:
    """Index of the `)` matching the `(` at text[k]."""
    depth = 0
    i = k
    n = len(text)
    while i < n:
        c = text[i]
        if c == "\\":
            i += 2
            continue
        if c == "'":
            j = text.find("'", i + 1)
            if j < 0:
                raise ParseError("unterminated '")
            i = j + 1
            continue
        if c == '"':
            i += 1
            while i < n and text[i] != '"':
                i += 2 if text[i] == "\\" else 1
            if i >= n:
                raise ParseError('unterminated "')
            i += 1
            continue
        if c == "(":
            depth += 1
        elif c == ")":
            depth -= 1
            if depth == 0:
                return i
        i += 1
    raise ParseError("unbalanced (")


def find_backtick(text: str, i: int) -> int:
    n = len(text)
    j = i + 1
    while j < n:
        if text[j] == "\\":
            j += 2
            continue
        if text[j] == "`":
            return j
        j += 1
    raise ParseError("unterminated `")


Item = Tuple[str, Any]  # ("cmd", [words]) | ("sub", script)


def tokenize(text: str) -> List[Item]:
    """Split a script into simple commands (word lists) and nested scripts, in source order."""
    items: List[Item] = []
    words: List[Tuple[str, bool]] = []
    cur: List[str] = []
    state = {"has": False, "quoted": False, "redir": False}
    n = len(text)

    def flush() -> None:
        if not state["has"]:
            return
        word = "".join(cur)
        quoted = state["quoted"]
        cur.clear()
        state["has"] = False
        state["quoted"] = False
        if state["redir"]:
            state["redir"] = False
            return
        if not words and not quoted and word in KEYWORDS:
            return
        words.append((word, quoted))

    def sep() -> None:
        flush()
        state["redir"] = False
        if words:
            items.append(("cmd", [w for w, _ in words]))
            words.clear()

    def add(s: str, quoted: bool = False) -> None:
        cur.append(s)
        state["has"] = True
        if quoted:
            state["quoted"] = True

    i = 0
    while i < n:
        c = text[i]
        if c in " \t":
            flush()
            i += 1
        elif c == "\n":
            sep()
            i += 1
        elif c == "\\":
            if i + 1 < n and text[i + 1] == "\n":
                i += 2
            elif i + 1 < n:
                add(text[i + 1], True)
                i += 2
            else:
                i += 1
        elif c == "#" and not state["has"]:
            while i < n and text[i] != "\n":
                i += 1
        elif c == "'":
            j = text.find("'", i + 1)
            if j < 0:
                raise ParseError("unterminated '")
            add(text[i + 1:j], True)
            i = j + 1
        elif c == '"':
            add("", True)
            i += 1
            while True:
                if i >= n:
                    raise ParseError('unterminated "')
                d = text[i]
                if d == '"':
                    i += 1
                    break
                if d == "\\" and i + 1 < n:
                    add(text[i + 1])
                    i += 2
                elif text.startswith("$(", i):
                    j = match_paren(text, i + 1)
                    items.append(("sub", text[i + 2:j]))
                    add("$()")
                    i = j + 1
                elif d == "`":
                    j = find_backtick(text, i)
                    items.append(("sub", text[i + 1:j]))
                    add("`")
                    i = j + 1
                else:
                    add(d)
                    i += 1
        elif c == "`":
            j = find_backtick(text, i)
            items.append(("sub", text[i + 1:j]))
            add("`")
            i = j + 1
        elif text.startswith("$(", i):
            j = match_paren(text, i + 1)
            items.append(("sub", text[i + 2:j]))
            add("$()")
            i = j + 1
        elif c in "<>" or (c == "&" and text[i + 1:i + 2] == ">"):
            if state["has"] and not state["quoted"] and "".join(cur).isdigit():
                cur.clear()  # a file descriptor number: `2>&1`
                state["has"] = False
            flush()
            if c == "&":
                i += 1
                c = ">"
            i += 1
            while i < n and text[i] in "<>" and len(text[i - 1:i + 1].strip("<>")) == 0:
                i += 1
            if i < n and text[i] in "&|":
                i += 1
            if text[i:i + 1] == "(":
                continue  # process substitution: the `(` is handled as a separator
            state["redir"] = True
        elif c in ";&|()":
            two = text[i:i + 2]
            sep()
            i += 2 if two in ("&&", "||", ";;", ";&", "|&") else 1
        else:
            add(c)
            i += 1
    sep()
    return items


# -------------------------------------------------------------------- detection


class _Scan:
    def __init__(self, cwd: str) -> None:
        self.cwd = cwd
        self.out: List[Commit] = []


def _basename(word: str) -> str:
    return os.path.basename(word)


def _script_of_shell(rest: List[str]) -> Optional[str]:
    for k, a in enumerate(rest):
        if a.startswith("-") and not a.startswith("--") and "c" in a[1:] and a[1:].isalpha():
            return rest[k + 1] if k + 1 < len(rest) else None
        if not a.startswith("-"):
            return None
    return None


def _scan(text: str, cur_dir: str, scan: _Scan, depth: int) -> None:
    if depth > MAX_DEPTH:
        raise ParseError("too deep")
    stripped, scripts = strip_heredocs(text)
    items = tokenize(stripped) + [("sub", s) for s in scripts]
    state = {"dir": cur_dir}
    for kind, payload in items:
        if kind == "sub":
            _scan(payload, state["dir"], scan, depth + 1)
        else:
            _command(payload, state, scan, depth)


def _command(argv: List[str], state: Dict[str, str], scan: _Scan, depth: int) -> None:
    i = 0
    while i < len(argv):
        w = argv[i]
        if ASSIGN_RE.match(w):
            i += 1
            continue
        b = _basename(w)
        if b in WRAPPERS:
            i += 1
            while i < len(argv):
                a = argv[i]
                if a.startswith("-"):
                    i += 2 if (b == "nice" and a == "-n") or (b == "env" and a in ("-u", "-C", "-S")) else 1
                elif ASSIGN_RE.match(a):
                    i += 1
                else:
                    break
            continue
        break
    if i >= len(argv):
        return
    head, rest = _basename(argv[i]), argv[i + 1:]
    if head in ("cd", "pushd"):
        target = next((a for a in rest if not a.startswith("-")), None)
        if target is None:
            target = "~"
        if "$" not in target and "`" not in target:
            state["dir"] = os.path.join(state["dir"], os.path.expanduser(target))
    elif head in SHELLS:
        script = _script_of_shell(rest)
        if script is not None:
            _scan(script, state["dir"], scan, depth + 1)
    elif head == "eval":
        _scan(" ".join(rest), state["dir"], scan, depth + 1)
    elif head == "git":
        _git(rest, state["dir"], scan)


def _config_alias(dir_: str, opts: List[str], name: str) -> Optional[str]:
    try:
        rc, out, _ = git(dir_, *opts, "config", "--get", "alias." + name)
    except (OSError, subprocess.SubprocessError):
        return None
    return out.strip() if rc == 0 and out.strip() else None


def _git(args: List[str], dir_: str, scan: _Scan) -> None:
    opts: List[str] = []
    aliases: Dict[str, str] = {}
    i = 0
    while i < len(args) and args[i].startswith("-"):
        a = args[i]
        name = a.split("=", 1)[0]
        if a in GIT_OPTS_WITH_VALUE:
            val = args[i + 1] if i + 1 < len(args) else ""
            i += 2
        elif name in GIT_OPTS_WITH_VALUE and a.startswith("--"):
            val = a.split("=", 1)[1]
            i += 1
        else:
            i += 1
            continue
        if name == "-c":
            key, _, v = val.partition("=")
            if key.lower().startswith("alias."):
                aliases[key.lower()[len("alias."):]] = v
        elif name in GIT_OPTS_FORWARDED:
            opts += [name, val]
    if i >= len(args):
        return
    sub, rest = args[i], args[i + 1:]
    for _ in range(MAX_DEPTH + 1):
        if sub in ("commit", "commit-tree"):
            scan.out.append(Commit(sub, dir_, opts, rest))
            return
        if sub.lower() in aliases:
            val = aliases[sub.lower()]
        elif sub in BUILTINS:
            return
        else:
            val = _config_alias(dir_, opts, sub)
            if val is None:
                return
        if val.startswith("!"):
            if GIT_WORD_RE.search(val) and COMMIT_WORD_RE.search(val):
                scan.out.append(Commit("unparsed", dir_, opts, []))
            return
        parts = val.split()
        if not parts:
            return
        sub, rest = parts[0], parts[1:] + rest
    scan.out.append(Commit("unparsed", dir_, opts, []))  # alias chain too deep


def find_commits(command: str, cwd: str) -> List[Commit]:
    """Every gated commit found in a Bash command. Never executes the command text."""
    scan = _Scan(cwd)
    try:
        _scan(command, cwd, scan, 0)
    except (ParseError, RecursionError):
        if GIT_WORD_RE.search(command) and COMMIT_WORD_RE.search(command):
            return [Commit("unparsed", cwd, [], [])]
        return []
    return scan.out


# --------------------------------------------------------------------- path set


def parse_commit_args(args: List[str]) -> Tuple[bool, List[str], bool]:
    """(all tracked changes?, explicit pathspecs, pathspecs unknowable?)"""
    all_flag = False
    dynamic = False
    specs: List[str] = []
    i = 0
    while i < len(args):
        a = args[i]
        if a == "--":
            specs += args[i + 1:]
            break
        if a.startswith("--"):
            name = a[2:].split("=", 1)[0]
            if name == "all":
                all_flag = True
            if name == "pathspec-from-file":
                dynamic = True
            if "=" not in a and name in COMMIT_LONG_WITH_VALUE:
                i += 1
        elif a.startswith("-") and len(a) > 1:
            letters = a[1:]
            for k, ch in enumerate(letters):
                if ch == "a":
                    all_flag = True
                elif ch in "mFcCt":
                    if k == len(letters) - 1:
                        i += 1
                    break
                elif ch in "Su":
                    break
        else:
            specs.append(a)
        i += 1
    dynamic = dynamic or any("$" in s or "`" in s for s in specs)
    return all_flag, specs, dynamic


def _names(dir_: str, opts: List[str], *args: str) -> List[str]:
    rc, out, err = git(dir_, *opts, *args)
    if rc != 0:
        raise GitError("git %s failed: %s" % (args[0], err.strip()[:200]))
    return [p for p in out.split("\0") if p]


def path_set(commit: Commit) -> List[str]:
    d, o = commit.dir, commit.git_opts
    paths = set(_names(d, o, "diff", "--cached", "--name-only", "--no-renames", "-z"))
    if commit.kind == "commit-tree":
        paths |= set(_names(d, o, "ls-files", "-z", "--full-name", "-c", "-o", "--exclude-standard", "--", ":/"))
    elif commit.kind == "unparsed":
        paths |= set(_names(d, o, "diff", "HEAD", "--name-only", "--no-renames", "-z"))
    else:
        all_flag, specs, dynamic = parse_commit_args(commit.args)
        if dynamic:
            paths |= set(_names(d, o, "diff", "HEAD", "--name-only", "--no-renames", "-z"))
        else:
            if all_flag:
                paths |= set(_names(d, o, "diff", "--name-only", "--no-renames", "-z"))
            if specs:
                paths |= set(_names(d, o, "diff", "HEAD", "--name-only", "--no-renames", "-z", "--", *specs))
    return sorted(paths)


def touched_packages(paths: List[str]) -> List[str]:
    found = {p.split("/", 1)[0] for p in paths if "/" in p and not p.endswith(".md")}
    return [pkg for pkg in PACKAGES if pkg in found]


# --------------------------------------------------------------------- decision


def decide(report: Dict[str, Any], packages: List[str]) -> Tuple[Optional[str], List[str], List[str]]:
    """(reason | None, missing, failing). Raises ReportError on a malformed report."""
    gates = report.get("gates") if isinstance(report, dict) else None
    if not isinstance(gates, dict):
        raise ReportError("report has no gates")
    exits: Dict[str, Optional[int]] = {}
    for gid, entry in gates.items():
        code = entry.get("exit") if isinstance(entry, dict) else "bad"
        if code is not None and (isinstance(code, bool) or not isinstance(code, int)):
            raise ReportError("bad exit for " + str(gid))
        exits[gid] = code
    failing = [g for g, code in exits.items() if code not in (0, None)]
    missing = [g for g in required_gates(packages) if exits.get(g) != 0]
    if failing:
        return "gates-failed", missing, failing
    if missing:
        return "missing-test-gate", missing, failing
    return None, missing, failing


def required_gates(packages: List[str]) -> List[str]:
    return ["root:drift"] + [TEST_GATE[p] for p in packages]


def _cap(text: str, limit: int) -> str:
    return text if len(text) <= limit else text[: limit - 1] + "…"


def _join(items: List[str]) -> str:
    return _cap(", ".join(items), 300) if items else "none"


def format_block(reason: str, state: Optional[str], packages: List[str], missing: List[str],
                 failing: List[str], run_packages: List[str]) -> str:
    run = "./scripts/gates.sh" + (" --packages " + ",".join(run_packages) if run_packages else "")
    msg = "\n".join([
        "commit-gate: BLOCKED (%s) state %s" % (reason, state or "unknown"),
        "packages: " + _join(packages),
        "missing: %s · failing: %s" % (_join(missing), _join(failing)),
        "run: %s — then retry the commit. Do not bypass this gate." % _cap(run, 300),
    ])
    return _cap(msg, MAX_MSG)


# ------------------------------------------------------------------------ state


def load_gates_module(toplevel: str) -> Any:
    path = os.path.join(toplevel, "scripts", "gates.py")
    spec = importlib.util.spec_from_file_location("devdigest_gates", path)
    if spec is None or spec.loader is None or not os.path.isfile(path):
        raise GitError("scripts/gates.py not found in " + toplevel)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def current_state(toplevel: str) -> str:
    return str(load_gates_module(toplevel).state_hash())


def read_report(toplevel: str, state: str) -> Optional[Dict[str, Any]]:
    path = os.path.join(toplevel, ".devdigest", "gates", state + ".json")
    if not os.path.isfile(path):
        return None
    try:
        with open(path) as f:
            data = json.load(f)
    except (OSError, ValueError) as exc:
        raise ReportError("unreadable report: %s" % type(exc).__name__)
    return data


def repo_of(commit: Commit) -> Optional[str]:
    """Top-level of the commit's repo when it belongs to this project, else None."""
    rc, out, err = git(commit.dir, *commit.git_opts, "rev-parse", "--path-format=absolute",
                       "--show-toplevel", "--git-common-dir")
    if rc != 0:
        if "not a git repository" in err:
            return None
        raise GitError("rev-parse failed: " + err.strip()[:200])
    lines = out.split("\n")
    if len(lines) < 2:
        raise GitError("unexpected rev-parse output")
    rc2, own, err2 = git(HOOK_ROOT, "rev-parse", "--path-format=absolute", "--git-common-dir")
    if rc2 != 0:
        raise GitError("rev-parse failed in the hook repo: " + err2.strip()[:200])
    if os.path.realpath(lines[1]) != os.path.realpath(own.strip()):
        return None
    return lines[0]


# -------------------------------------------------------------------------- log


def append_log(entry: Dict[str, Any]) -> None:
    try:
        os.makedirs(os.path.dirname(LOG_PATH), exist_ok=True)
        with open(LOG_PATH, "a") as f:
            f.write(json.dumps(entry, ensure_ascii=False) + "\n")
    except Exception:
        pass


def log_entry(payload: Dict[str, Any], command: str, decision: str, reason: str, ctx: Dict[str, Any]) -> None:
    agent = payload.get("agent_type")
    append_log({
        "ts": datetime.datetime.now().astimezone().isoformat(timespec="seconds"),
        "session_id": payload.get("session_id"),
        "agent_type": agent if isinstance(agent, str) else None,
        "decision": decision,
        "reason": reason,
        "state": ctx.get("state"),
        "packages": ctx.get("packages", []),
        "missing": ctx.get("missing", []),
        "failing": ctx.get("failing", []),
        "command": command[:500],
    })


# ------------------------------------------------------------------------- main


def evaluate(commit: Commit, ctx: Dict[str, Any], env: Dict[str, str]) -> Optional[Tuple[str, str]]:
    """None = allow; ("blocked" | "bypassed", reason) otherwise (bypass lets the call through)."""
    bypass = env.get("DEVDIGEST_COMMIT_GATE") == "off"
    toplevel: Optional[str] = None
    paths: Optional[List[str]] = None
    error: Optional[str] = None
    try:
        toplevel = repo_of(commit)
        if toplevel is None:
            return None
        paths = path_set(commit)
    except Exception as exc:
        if not bypass:
            raise
        # FR10: with the hatch off the hook never blocks, even when the commit cannot be analysed.
        error = type(exc).__name__
    if paths is not None:
        if commit.kind != "commit-tree" and all(p.endswith(".md") for p in paths):
            return None
        packages = touched_packages(paths)
        ctx.update(packages=packages, missing=[], failing=[])
    if bypass:
        if toplevel is not None:
            try:
                ctx["state"] = current_state(toplevel)
            except Exception:
                pass
        return "bypassed", "env-off" if error is None else "env-off: " + error
    assert toplevel is not None and paths is not None
    state = current_state(toplevel)
    ctx["state"] = state
    report = read_report(toplevel, state)
    if report is None:
        ctx.update(missing=required_gates(packages), run_packages=packages)
        return "blocked", "no-report"
    reason, missing, failing = decide(report, packages)
    if reason is None:
        return None
    ctx.update(missing=missing, failing=failing,
               run_packages=[p for p in packages if TEST_GATE[p] in missing])
    return "blocked", reason


def main() -> int:
    payload: Dict[str, Any] = {}
    command = ""
    try:
        data = json.loads(sys.stdin.read())
        payload = data if isinstance(data, dict) else {}
        if payload.get("tool_name") != "Bash":
            return 0
        tool_input = payload.get("tool_input")
        command = tool_input.get("command") if isinstance(tool_input, dict) else ""
        if not isinstance(command, str) or "git" not in command:
            return 0
        cwd = payload.get("cwd") if isinstance(payload.get("cwd"), str) else os.getcwd()
        commits = find_commits(command, cwd)
        if not commits:
            return 0
    except Exception as exc:
        log_entry(payload, command, "internal-error", "allowed: " + type(exc).__name__, {})
        return 0

    ctx: Dict[str, Any] = {}
    try:
        for commit in commits:
            ctx = {}
            verdict = evaluate(commit, ctx, dict(os.environ))
            if verdict is None:
                continue
            decision, reason = verdict
            log_entry(payload, command, decision, reason, ctx)
            if decision == "blocked":
                sys.stderr.write(format_block(reason, ctx.get("state"), ctx.get("packages", []),
                                              ctx.get("missing", []), ctx.get("failing", []),
                                              ctx.get("run_packages", [])) + "\n")
                return 2
        return 0
    except Exception as exc:
        log_entry(payload, command, "internal-error", type(exc).__name__ + ": " + str(exc)[:200], ctx)
        sys.stderr.write(format_block("internal-error", ctx.get("state"), ctx.get("packages", []),
                                      [], [], ctx.get("packages", [])) + "\n")
        return 2


if __name__ == "__main__":
    sys.exit(main())
