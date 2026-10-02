#!/usr/bin/env python3
"""Data collector for the `workflow-retro` skill (manual only; never edits agents or skills).

  scripts/workflow-retro.sh [--session <id|path>] [--since <ISO>] [--until <ISO>] [--json]
  scripts/workflow-retro.sh --append-ledger --label <slug> --verdict <text> --actions "<a>; <b>" [...]

Reads the Claude Code transcript of a session from disk: ~/.claude/projects/<cwd-slug>/<session>.jsonl
(the lead) and <session>/**/agent-*.jsonl (every subagent, nested and workflow agents included —
a parent's `subagent_tokens` does not count what its children spent). Default session = the newest
transcript of this repo, i.e. the current session.

Per agent: tokens (input, cache write, cache read, output), cache hit %, estimated cost (prices in
scripts/workflow-retro-config.json), duration, API calls, peak context, tool calls, spawn depth and
parent, times the lead had to continue it (SendMessage), re-asks in its hand-back (Clarification
needed / BLOCKED / PARTIAL / "do it yourself"), permission denials, writes outside its scope.
Session: spawn order, peak and average parallelism, files read by >= 2 agents, commands run by
>= 2 agents, and pipeline steps that were skipped (INSIGHTS wrap-up, shared-contract drift check,
gates after the last code edit, migration for a schema change, review after implementation).

Usage entries are de-duplicated by API request id (one response = several transcript lines).
Fewer than 2 subagents in the window → prints a skip notice and exits 0.
"""
import argparse
import collections
import datetime as dt
import fnmatch
import glob
import json
import os
import re
import shlex
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
LEDGER = os.path.join(ROOT, "docs", "retros", "ledger.md")
CONFIG = json.load(open(os.path.join(ROOT, "scripts", "workflow-retro-config.json"), encoding="utf-8"))
USAGE_KEYS = ("input_tokens", "cache_creation_input_tokens", "cache_read_input_tokens", "output_tokens")
LEDGER_HEADER = (
    "| Date | Label | Session | Agents (nested) | Peak ∥ | Wall | Tokens total | Fresh | Cache hit "
    "| Cost ≈ | Tool calls | Verdict | Top actions |\n"
    "|---|---|---|---|---|---|---|---|---|---|---|---|---|\n"
)
DENIED = "Permission for this action was denied"
WRITE_TOOLS = ("Write", "Edit", "NotebookEdit")
READ_CMD = re.compile(r"^(?:cat|head|tail|sed\s+-n\s+\S+|less|bat)\s+(?:-\S+\s+)*([^\s|;&<>]+)")


def project_dir():
    return os.path.join(os.path.expanduser("~/.claude/projects"), re.sub(r"[^A-Za-z0-9]", "-", ROOT))


def parse_ts(s):
    return dt.datetime.fromisoformat(s.replace("Z", "+00:00")) if s else None


def resolve_session(arg):
    if arg and os.path.isfile(arg):
        return arg
    pdir = project_dir()
    if arg:
        path = os.path.join(pdir, arg + ".jsonl")
        if not os.path.isfile(path):
            sys.exit(f"session not found: {path}")
        return path
    files = glob.glob(os.path.join(pdir, "*.jsonl"))
    if not files:
        sys.exit(f"no transcripts in {pdir}")
    return max(files, key=os.path.getmtime)


def rel(path):
    if not path:
        return path
    p = os.path.normpath(path if os.path.isabs(path) else os.path.join(ROOT, path))
    return os.path.relpath(p, ROOT) if p.startswith(ROOT + os.sep) else p


def price_of(model):
    m = (model or "").replace("[1m]", "")
    m = CONFIG["model_aliases"].get(m, m)
    for key, p in CONFIG["pricing"].items():
        if m == key or m.startswith(key + "-"):
            return p
    return None


HEREDOC = re.compile(r"<<-?\s*['\"]?(\w+)['\"]?")
PY_OPEN = re.compile(r"open\(\s*(?:f?['\"]([^'\"]+)['\"]|(\w+))\s*,\s*['\"][wa]")
PY_ASSIGN = re.compile(r"\b(\w+)\s*=\s*['\"]([^'\"]+\.[A-Za-z]{1,6})['\"]")
PY_WRITE_TEXT = re.compile(r"Path\(\s*['\"]([^'\"]+)['\"]\s*\)\.write_text")


def split_shell(raw):
    """(cwd, simple command) pairs outside heredoc bodies, and (cwd, heredoc body) pairs."""
    parts, bodies, body, term, cwd = [], [], [], None, ""
    for line in raw.split("\n"):
        if term is not None:
            if line.strip() == term:
                bodies.append((cwd, "\n".join(body)))
                body, term = [], None
            else:
                body.append(line)
            continue
        for part in re.split(r"\s*(?:&&|;|\|\|?)\s*", line):
            part = part.strip()
            m = re.match(r"^cd\s+([^\s;&|]+)$", part)
            if m:
                d = m.group(1).strip("'\"")
                cwd = rel(d) if os.path.isabs(d) else os.path.normpath(os.path.join(cwd, d))
                cwd = "" if cwd in (".", "") else cwd
            elif part:
                parts.append((cwd, part))
        m = HEREDOC.search(line)
        if m:
            term = m.group(1)
    if body:
        bodies.append((cwd, "\n".join(body)))
    return parts, bodies


def under(cwd, path):
    path = path.strip("'\"")
    if not path or path.startswith(("/dev/", "/tmp/", "$", "-")):
        return None
    r = rel(path) if os.path.isabs(path) else os.path.normpath(os.path.join(cwd, path))
    return None if os.path.isabs(r) or r.startswith("..") else r


def bash_reads(raw):
    out = []
    for cwd, part in split_shell(raw)[0]:
        m = READ_CMD.match(part)
        if m:
            r = under(cwd, m.group(1))
            if r:
                out.append(r)
    return out


def bash_writes(raw):
    """Heuristic: repo paths a shell command writes or deletes (redirects, sed -i, tee, rm, mv, cp, python open/write_text)."""
    parts, bodies = split_shell(raw)
    out = []
    for cwd, part in parts:
        try:
            tok = shlex.split(part, comments=False, posix=True)
        except ValueError:
            continue
        unquoted = re.sub(r"'[^']*'|\"(?:\\.|[^\"\\])*\"", " ", part)
        for m in re.finditer(r"(?<![<>&\d])\d?>>?\s*([^\s;&|<>()]+)", unquoted):
            if not m.group(1).startswith("&"):
                out.append((cwd, m.group(1)))
        if not tok:
            continue
        head = tok[0]
        args = [t for t in tok[1:] if not t.startswith("-")]
        if head == "sed" and any(t.startswith("-i") for t in tok[1:]) and args:
            out.append((cwd, args[-1]))
        elif head in ("rm", "tee") and args:
            out.extend((cwd, a) for a in args)
        elif head == "git" and len(tok) > 1 and tok[1] == "rm":
            out.extend((cwd, a) for a in args[1:])
        elif head in ("mv", "cp") and len(args) >= 2:
            out.append((cwd, args[-1]))
    for bcwd, body in bodies:
        names = dict(PY_ASSIGN.findall(body))
        for lit, var in PY_OPEN.findall(body):
            path = lit or names.get(var)
            if path:
                out.append((bcwd, path))
        out.extend((bcwd, p) for p in PY_WRITE_TEXT.findall(body))
    keep = []
    for cwd, p in out:
        r = under(cwd, p)
        if r and r != "/dev/null":
            keep.append(r)
    return keep


def in_window(ts, since, until):
    return ts is not None and (since is None or ts >= since) and (until is None or ts <= until)


def read_transcript(path, since, until):
    usage = collections.Counter()
    seen = set()
    tools = collections.Counter()
    reads, cmds, writes, sends, tool_ids = [], [], [], [], set()
    timeline = []  # (ts, kind, detail) for pipeline checks
    denials = 0
    handback = ""
    first = last = model = None
    peak = calls = 0
    cost = 0.0
    with open(path, encoding="utf-8") as fh:
        for line in fh:
            try:
                d = json.loads(line)
            except ValueError:
                continue
            ts = parse_ts(d.get("timestamp"))
            if d.get("type") not in ("assistant", "user") or not in_window(ts, since, until):
                continue
            first = first or ts
            last = ts
            msg = d.get("message") or {}
            if d["type"] == "user":
                content = msg.get("content")
                if isinstance(content, list):
                    for b in content:
                        if isinstance(b, dict) and b.get("type") == "tool_result" and DENIED in str(b.get("content"))[:400]:
                            denials += 1
                elif isinstance(content, str) and "<task-notification>" not in content:
                    timeline.append((ts, "user_text", content[:300]))
                continue
            model = msg.get("model") or model
            rid = d.get("requestId") or msg.get("id")
            u = msg.get("usage")
            if u and rid not in seen:
                seen.add(rid)
                calls += 1
                for k in USAGE_KEYS:
                    usage[k] += u.get(k) or 0
                peak = max(peak, sum((u.get(k) or 0) for k in USAGE_KEYS[:3]))
                p = price_of(msg.get("model") or model)
                if p:
                    cc = u.get("cache_creation") or {}
                    w5 = cc.get("ephemeral_5m_input_tokens")
                    w1 = cc.get("ephemeral_1h_input_tokens")
                    if w5 is None and w1 is None:
                        w5, w1 = u.get("cache_creation_input_tokens") or 0, 0
                    cost += ((u.get("input_tokens") or 0) * p["input"] + (w5 or 0) * p["input"] * 1.25
                             + (w1 or 0) * p["input"] * 2 + (u.get("cache_read_input_tokens") or 0) * p["cache_read"]
                             + (u.get("output_tokens") or 0) * p["output"]) / 1e6
            for b in msg.get("content") or []:
                if not isinstance(b, dict):
                    continue
                if b.get("type") == "text" and b.get("text"):
                    timeline.append((ts, "text", b["text"][:2000]))
                    handback = b["text"]
                if b.get("type") != "tool_use":
                    continue
                name, inp = b.get("name"), b.get("input") or {}
                tools[name] += 1
                tool_ids.add(b.get("id"))
                if name == "Read" and inp.get("file_path"):
                    reads.append(rel(inp["file_path"]))
                elif name in WRITE_TOOLS and (inp.get("file_path") or inp.get("notebook_path")):
                    p = rel(inp.get("file_path") or inp.get("notebook_path"))
                    writes.append(p)
                    timeline.append((ts, "write", p))
                elif name == "Bash" and inp.get("command"):
                    c = " ".join(inp["command"].split())
                    cmds.append(c[:160])
                    timeline.append((ts, "bash", c))
                    reads.extend(bash_reads(inp["command"]))
                    for p in bash_writes(inp["command"]):
                        writes.append(p)
                        timeline.append((ts, "write", p))
                elif name == "SendMessage":
                    sends.append(str(inp.get("to", "")))
                elif name == "SubagentHandback":
                    handback = str(inp.get("message", ""))
                elif name in ("Agent", "Task"):
                    timeline.append((ts, "spawn", str(inp.get("subagent_type") or "general-purpose")))
    return {"usage": dict(usage), "calls": calls, "peak_context": peak, "tools": dict(tools),
            "tool_calls": sum(tools.values()), "reads": reads, "cmds": cmds, "writes": writes,
            "sends": sends, "tool_use_ids": tool_ids, "start": first, "end": last, "model": model,
            "cost": cost, "denials": denials, "handback": handback, "timeline": timeline}


def total(u):
    return sum(u.get(k, 0) for k in USAGE_KEYS)


def hit_pct(u):
    inputs = sum(u.get(k, 0) for k in USAGE_KEYS[:3])
    return round(100 * u.get("cache_read_input_tokens", 0) / inputs) if inputs else 0


def collect(session_path, since, until):
    main = read_transcript(session_path, since, until)
    main.update(id="main", type="lead", description="lead session", depth=0, parent=None)
    agents = []
    for path in sorted(glob.glob(os.path.join(session_path[:-6], "**", "agent-*.jsonl"), recursive=True)):
        s = read_transcript(path, since, until)
        if s["start"] is None:
            continue
        meta_path = path[:-6] + ".meta.json"
        meta = json.load(open(meta_path, encoding="utf-8")) if os.path.isfile(meta_path) else {}
        s.update(id=os.path.basename(path)[6:-6], type=meta.get("agentType", "?"),
                 description=meta.get("description", ""), depth=meta.get("spawnDepth", 1),
                 spawn_tool_use=meta.get("toolUseId"), model=meta.get("model") or s["model"])
        agents.append(s)
    owners = {t: "main" for t in main["tool_use_ids"]}
    for a in agents:
        owners.update({t: a["id"] for t in a["tool_use_ids"]})
    everyone = [main] + agents
    for a in agents:
        a["parent"] = owners.get(a.get("spawn_tool_use"), "?")
        a["continued"] = sum(1 for x in everyone for to in x["sends"] if to and (to == a["id"] or a["id"].startswith(to)))
        a["reasks"] = sorted({p for p in CONFIG["reask_patterns"] if re.search(p, a["handback"] or "", re.I)})
        a["out_of_scope"] = out_of_scope(a)
    agents.sort(key=lambda a: a["start"])
    return main, agents


def matches(path, globs):
    return any(fnmatch.fnmatch(path, g) or (g.endswith("/**") and path.startswith(g[:-3] + "/")) for g in globs)


def out_of_scope(a):
    rule = CONFIG["scope"].get(a["type"])
    if rule is None:
        return []
    bad = []
    for p in sorted(set(a["writes"])):
        allowed = "*" in rule.get("allow", []) or matches(p, rule.get("allow", []))
        if not allowed or matches(p, rule.get("deny", [])):
            bad.append(p)
    return bad


def pipeline_checks(main, agents):
    """Steps of the SDD pipeline that the transcript shows as skipped (heuristic, evidence-based)."""
    events = sorted((ev for a in [main] + agents for ev in a["timeline"]), key=lambda e: e[0])
    writes = [(t, p) for t, k, p in events if k == "write"]
    bash = [(t, c) for t, k, c in events if k == "bash"]
    texts = [(t, c) for t, k, c in events if k in ("text",)]
    code = [(t, p) for t, p in writes if any(p.startswith(d) for d in CONFIG["code_dirs"])]
    code += [(a["end"], "(%s run)" % a["type"]) for a in agents if a["type"] in ("implementer", "test-writer")]
    code.sort(key=lambda x: x[0])
    out = []

    def after(ts, pred, seq):
        return any(t >= ts and pred(x) for t, x in seq)

    if code:
        pkgs = sorted({p.split("/")[0] for _, p in code if not p.startswith("(")}) or ["code"]
        last = code[-1][0]
        ok = after(code[0][0], lambda c: "append_insight.py" in c, bash) or any(
            "nothing new worth recording" in x for _, x in texts) or any(
            p.endswith("INSIGHTS.md") and t >= code[0][0] for t, p in writes)
        out.append(("INSIGHTS wrap-up for " + ", ".join(pkgs), ok,
                    "append_insight.py or 'Insights: nothing new' after code edits"))
        out.append(("gates after the last code edit", after(last, lambda c: "gates.sh" in c or "pnpm test" in c
                                                             or "vitest run" in c, bash),
                    "./scripts/gates.sh (or package tests) after %s" % last.strftime("%H:%M:%S")))
    shared = [(t, p) for t, p in writes if any(p.startswith(d) for d in CONFIG["shared_dirs"])]
    if shared:
        out.append(("shared-contract drift check", after(shared[-1][0], lambda c: "check-shared-drift" in c
                                                         or "gates.sh" in c, bash),
                    "check-shared-drift.sh or gates.sh root:drift after the last @devdigest/shared edit"))
    schema = [(t, p) for t, p in writes if any(p.startswith(d) for d in CONFIG["schema_dirs"])]
    if schema:
        ok = any(p.startswith("server/src/db/migrations/") for _, p in writes) or after(
            schema[0][0], lambda c: "db:generate" in c, bash)
        out.append(("migration for the schema change", ok, "new file in server/src/db/migrations/ or pnpm db:generate"))
    impl = [a for a in agents if a["type"] == "implementer"]
    if impl:
        last_impl = max(a["end"] for a in impl)
        ok = any(a["type"] in CONFIG["reviewer_types"] and a["start"] >= last_impl for a in agents)
        out.append(("review after the last implementer", ok, "plan-verifier / architecture-reviewer / delta-reviewer"))
    return out


def peak_concurrency(intervals):
    ev = sorted([(s, 1) for s, _ in intervals] + [(e, -1) for _, e in intervals], key=lambda x: (x[0], x[1]))
    cur = best = 0
    for _, step in ev:
        cur += step
        best = max(best, cur)
    return best


def duplicates(agents, key, n=2):
    seen = collections.defaultdict(set)
    for a in agents:
        for item in set(a[key]):
            seen[item].add(a["type"] + ":" + a["id"][:6])
    return sorted(((i, len(s)) for i, s in seen.items() if len(s) >= n), key=lambda r: -r[1])


def summary(main, agents):
    everyone = [main] + agents
    grand, sub = collections.Counter(), collections.Counter()
    for a in everyone:
        grand.update(a["usage"])
    for a in agents:
        sub.update(a["usage"])
    starts = [a["start"] for a in everyone if a["start"]]
    ends = [a["end"] for a in everyone if a["end"]]
    wall = int((max(ends) - min(starts)).total_seconds()) if starts else 0
    busy = sum((a["end"] - a["start"]).total_seconds() for a in agents)
    return {
        "agents": len(agents), "nested": sum(1 for a in agents if a["depth"] >= 2),
        "peak_parallel": peak_concurrency([(a["start"], a["end"]) for a in agents]) if agents else 0,
        "avg_parallel": round(busy / wall, 2) if wall else 0, "wall_s": wall,
        "tokens_total": total(grand), "tokens_fresh": total(grand) - grand["cache_read_input_tokens"],
        "subagent_tokens": total(sub), "lead_tokens": total(main["usage"]), "usage": dict(grand),
        "cache_hit_pct": hit_pct(grand), "cost": round(sum(a["cost"] for a in everyone), 2),
        "tool_calls": sum(a["tool_calls"] for a in everyone),
        "dup_reads": duplicates(agents, "reads")[:15], "dup_cmds": duplicates(everyone, "cmds")[:10],
        "checks": pipeline_checks(main, agents),
    }


def k(n):
    return f"{n / 1e6:.2f}M" if n >= 1e6 else f"{n / 1e3:.0f}k" if n >= 1e3 else str(n)


def dur(a):
    s = int((a["end"] - a["start"]).total_seconds()) if a["start"] else 0
    return f"{s // 60}m{s % 60:02d}s"


def print_markdown(path, main, agents, r):
    print(f"# workflow-retro — session {os.path.basename(path)[:8]}\n")
    print(f"Agents {r['agents']} (nested {r['nested']}) · parallel peak {r['peak_parallel']}, avg {r['avg_parallel']} · "
          f"wall {r['wall_s'] // 60}m · tokens {k(r['tokens_total'])} (fresh {k(r['tokens_fresh'])}; lead "
          f"{k(r['lead_tokens'])}, subagents {k(r['subagent_tokens'])}) · cache hit {r['cache_hit_pct']}% · "
          f"cost ≈ ${r['cost']:.2f} · tool calls {r['tool_calls']}\n")
    print("| # | Start | Agent | Description | Model | Dur | Calls | Tokens | Hit | Cost ≈ | Peak ctx | Tools | Flags |")
    print("|---|---|---|---|---|---|---|---|---|---|---|---|---|")
    for i, a in enumerate([main] + agents):
        flags = []
        if a.get("continued"):
            flags.append(f"continued×{a['continued']}")
        if a.get("reasks"):
            flags.append("re-ask")
        if a["denials"]:
            flags.append(f"denied×{a['denials']}")
        if a.get("out_of_scope"):
            flags.append(f"scope×{len(a['out_of_scope'])}")
        if a["depth"] >= 2:
            flags.append(f"nested←{a['parent'][:6]}")
        top = ", ".join(f"{n}×{c}" for n, c in sorted(a["tools"].items(), key=lambda x: -x[1])[:3])
        print(f"| {i} | {a['start'].strftime('%H:%M') if a['start'] else '-'} | {a['type']} | {a['description'][:34]} "
              f"| {(a['model'] or '-').replace('claude-', '')} | {dur(a)} | {a['calls']} | {k(total(a['usage']))} "
              f"| {hit_pct(a['usage'])}% | ${a['cost']:.2f} | {k(a['peak_context'])} | {top} | {' '.join(flags) or '-'} |")
    print("\n## Pipeline checks\n")
    for name, ok, hint in r["checks"] or [("no code edits in window", True, "")]:
        print(f"- {'ok     ' if ok else 'MISSING'} {name}" + ("" if ok else f" — expected: {hint}"))
    issues = [(a, kind, v) for a in agents for kind, v in (("re-ask", a["reasks"]), ("out of scope", a["out_of_scope"])) if v]
    print("\n## Re-asks and scope\n")
    for a, kind, v in issues or []:
        print(f"- {a['type']} «{a['description'][:40]}» — {kind}: {', '.join(v)[:200]}")
    if not issues:
        print("- none")
    print("\n## Files read by ≥ 2 subagents (context-pack / pre-load candidates)\n")
    for p, n in r["dup_reads"] or [("none", 0)]:
        print(f"- {p} — {n} agents" if n else "- none")
    print("\n## Commands run by ≥ 2 agents (cache / cite candidates)\n")
    for c, n in r["dup_cmds"] or [("none", 0)]:
        print(f"- `{c}` — {n} agents" if n else "- none")


def append_ledger(args, main, agents, r, path):
    if not os.path.isfile(LEDGER) or LEDGER_HEADER.splitlines()[0] not in open(LEDGER, encoding="utf-8").read():
        sys.exit(f"{LEDGER} missing or has an old header — fix the header first")
    cell = lambda s: s.replace("|", "/").replace("\n", " ").strip()
    row = (f"| {dt.date.today().isoformat()} | {cell(args.label)} | {os.path.basename(path)[:8]} | {r['agents']} ({r['nested']}) "
           f"| {r['peak_parallel']} | {r['wall_s'] // 60}m | {k(r['tokens_total'])} | {k(r['tokens_fresh'])} | {r['cache_hit_pct']}% "
           f"| ${r['cost']:.2f} | {r['tool_calls']} | {cell(args.verdict)} | {cell(args.actions)} |\n")
    with open(LEDGER, "a", encoding="utf-8") as fh:
        fh.write(row)
    print(row, end="")


def main_cli():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--session", help="session id or .jsonl path (default: newest in this repo = current session)")
    p.add_argument("--since", type=parse_ts, help="ISO timestamp, e.g. 2026-10-01T12:00:00Z")
    p.add_argument("--until", type=parse_ts)
    p.add_argument("--json", action="store_true")
    p.add_argument("--append-ledger", action="store_true")
    p.add_argument("--label", default="")
    p.add_argument("--verdict", default="")
    p.add_argument("--actions", default="")
    args = p.parse_args()
    path = resolve_session(args.session)
    main, agents = collect(path, args.since, args.until)
    if len(agents) < 2:
        print(f"workflow-retro: {len(agents)} subagent(s) in the window — nothing to compare, retro skipped.")
        return
    r = summary(main, agents)
    if args.append_ledger:
        if not args.label:
            sys.exit("--append-ledger needs --label")
        return append_ledger(args, main, agents, r, path)
    if args.json:
        drop = ("tool_use_ids", "reads", "cmds", "sends", "timeline", "handback", "writes")
        slim = lambda a: {x: (v.isoformat() if isinstance(v, dt.datetime) else v) for x, v in a.items() if x not in drop}
        print(json.dumps({"session": path, "summary": r, "agents": [slim(a) for a in [main] + agents]}, indent=1, default=str))
    else:
        print_markdown(path, main, agents, r)


if __name__ == "__main__":
    main_cli()
