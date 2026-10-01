#!/usr/bin/env python3
"""Deep-mode data collector for the `workflow-retro` skill (manual only).

  scripts/workflow-retro.sh [--session <id|path>] [--since <ISO>] [--until <ISO>] [--json]
  scripts/workflow-retro.sh --append-ledger --label <slug> --verdict <text> --actions "<a>; <b>" [...]

Reads Claude Code transcripts from disk (~/.claude/projects/<cwd-slug>/<session>.jsonl and
<session>/**/agent-*.jsonl, which includes nested subagents and workflow agents), because the
parent's task-notification `subagent_tokens` does not include what a child's own children
spent. Prints per-agent tokens (fresh input, cache write, cache read, output), tool calls,
duration, spawn depth/parent, the spawn order, peak concurrency, and duplicate work across
agents (same file read, same command run). It reads, never writes — except `--append-ledger`,
which appends one row to docs/retros/ledger.md.

Usage entries are de-duplicated by API request id: one response with several content
blocks is written as several transcript lines carrying the same usage.
"""
import argparse
import collections
import datetime as dt
import glob
import json
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
LEDGER = os.path.join(ROOT, "docs", "retros", "ledger.md")
USAGE_KEYS = ("input_tokens", "cache_creation_input_tokens", "cache_read_input_tokens", "output_tokens")
SHORT = {"input_tokens": "in", "cache_creation_input_tokens": "cache_w",
         "cache_read_input_tokens": "cache_r", "output_tokens": "out"}
LEDGER_HEADER = (
    "| Date | Label | Session | Agents (nested) | Peak ∥ | Wall | Tokens total | Fresh | Cache read % "
    "| Tool calls | Verdict | Top actions |\n"
    "|---|---|---|---|---|---|---|---|---|---|---|---|\n"
)


def project_dir():
    slug = re.sub(r"[^A-Za-z0-9]", "-", ROOT)
    return os.path.join(os.path.expanduser("~/.claude/projects"), slug)


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


def in_window(ts, since, until):
    return ts is not None and (since is None or ts >= since) and (until is None or ts <= until)


def read_transcript(path, since, until):
    """One agent's stats from one transcript file."""
    usage = collections.Counter()
    seen_requests = set()
    tools = collections.Counter()
    files_read, commands, spawned = [], [], []
    tool_use_ids = set()
    first = last = None
    model = None
    peak_ctx = calls = 0
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
            if d["type"] != "assistant":
                continue
            msg = d.get("message") or {}
            model = msg.get("model") or model
            rid = d.get("requestId") or msg.get("id")
            u = msg.get("usage")
            if u and rid not in seen_requests:
                seen_requests.add(rid)
                calls += 1
                for k in USAGE_KEYS:
                    usage[k] += u.get(k) or 0
                ctx = sum((u.get(k) or 0) for k in USAGE_KEYS[:3])
                peak_ctx = max(peak_ctx, ctx)
            for block in msg.get("content") or []:
                if not isinstance(block, dict) or block.get("type") != "tool_use":
                    continue
                name, inp = block.get("name"), block.get("input") or {}
                tools[name] += 1
                tool_use_ids.add(block.get("id"))
                if name == "Read" and inp.get("file_path"):
                    files_read.append(os.path.relpath(inp["file_path"], ROOT))
                elif name == "Bash" and inp.get("command"):
                    commands.append(" ".join(inp["command"].split())[:160])
                elif name in ("Agent", "Task"):
                    spawned.append(block.get("id"))
    return {
        "usage": dict(usage), "calls": calls, "peak_context": peak_ctx, "tools": dict(tools),
        "tool_calls": sum(tools.values()), "files_read": files_read, "commands": commands,
        "tool_use_ids": tool_use_ids, "start": first, "end": last, "model": model,
        "spawned": spawned,
    }


def total(u):
    return sum(u.get(k, 0) for k in USAGE_KEYS)


def peak_concurrency(intervals):
    events = sorted([(s, 1) for s, e in intervals] + [(e, -1) for s, e in intervals],
                    key=lambda x: (x[0], x[1]))
    cur = best = 0
    for _, step in events:
        cur += step
        best = max(best, cur)
    return best


def collect(session_path, since, until):
    main = read_transcript(session_path, since, until)
    main.update(id="main", type="lead", description="lead session", depth=0, parent=None)
    agents = []
    sess_dir = session_path[:-len(".jsonl")]
    for path in sorted(glob.glob(os.path.join(sess_dir, "**", "agent-*.jsonl"), recursive=True)):
        stats = read_transcript(path, since, until)
        if stats["start"] is None:
            continue
        meta_path = path[:-len(".jsonl")] + ".meta.json"
        meta = {}
        if os.path.isfile(meta_path):
            with open(meta_path, encoding="utf-8") as fh:
                meta = json.load(fh)
        stats.update(
            id=os.path.basename(path)[len("agent-"):-len(".jsonl")],
            type=meta.get("agentType", "?"), description=meta.get("description", ""),
            depth=meta.get("spawnDepth", 1), spawn_tool_use=meta.get("toolUseId"),
            model=meta.get("model") or stats["model"],
        )
        agents.append(stats)
    owners = {tid: "main" for tid in main["tool_use_ids"]}
    for a in agents:
        owners.update({tid: a["id"] for tid in a["tool_use_ids"]})
    for a in agents:
        a["parent"] = owners.get(a.get("spawn_tool_use"), "?")
    agents.sort(key=lambda a: a["start"])
    return main, agents


def duplicates(agents, key, min_agents=2):
    seen = collections.defaultdict(set)
    for a in agents:
        for item in set(a[key]):
            seen[item].add(a["id"])
    rows = [(item, len(ids)) for item, ids in seen.items() if len(ids) >= min_agents]
    return sorted(rows, key=lambda r: -r[1])


def fmt_k(n):
    return f"{n / 1e6:.2f}M" if n >= 1e6 else f"{n / 1e3:.0f}k" if n >= 1e3 else str(n)


def fmt_dur(a):
    if not a["start"]:
        return "-"
    s = int((a["end"] - a["start"]).total_seconds())
    return f"{s // 60}m{s % 60:02d}s"


def report(main, agents):
    everyone = [main] + agents
    grand = collections.Counter()
    for a in everyone:
        grand.update(a["usage"])
    sub = collections.Counter()
    for a in agents:
        sub.update(a["usage"])
    intervals = [(a["start"], a["end"]) for a in agents]
    starts = [a["start"] for a in everyone if a["start"]]
    ends = [a["end"] for a in everyone if a["end"]]
    wall = int((max(ends) - min(starts)).total_seconds()) if starts else 0
    inputs = sum(grand[k] for k in USAGE_KEYS[:3])
    return {
        "agents": len(agents), "nested": sum(1 for a in agents if a["depth"] >= 2),
        "peak_parallel": peak_concurrency(intervals) if intervals else 0,
        "wall_s": wall, "tokens_total": total(grand),
        "tokens_fresh": total(grand) - grand["cache_read_input_tokens"], "subagent_tokens": total(sub),
        "lead_tokens": total(main["usage"]), "usage": dict(grand),
        "cache_read_pct": round(100 * grand["cache_read_input_tokens"] / inputs) if inputs else 0,
        "tool_calls": sum(a["tool_calls"] for a in everyone),
        "dup_reads": duplicates(agents, "files_read")[:15],
        "dup_commands": duplicates(everyone, "commands")[:10],
    }


def print_markdown(session_path, main, agents, r):
    print(f"# workflow-retro data — session {os.path.basename(session_path)[:8]}\n")
    print(f"Agents: {r['agents']} (nested {r['nested']}) · peak parallel {r['peak_parallel']} · "
          f"wall {r['wall_s'] // 60}m · tokens {fmt_k(r['tokens_total'])} "
          f"(lead {fmt_k(r['lead_tokens'])}, subagents {fmt_k(r['subagent_tokens'])}; "
          f"fresh = total − cache read {fmt_k(r['tokens_fresh'])}) · "
          f"cache read {r['cache_read_pct']}% · tool calls {r['tool_calls']}")
    print("Usage: " + " · ".join(f"{SHORT[k]} {fmt_k(r['usage'].get(k, 0))}" for k in USAGE_KEYS))
    print("\n## Agents in spawn order\n")
    print("| # | Start | Agent | Description | Depth/parent | Model | Dur | Calls | Tokens | "
          "Cache r | Out | Peak ctx | Tools |")
    print("|---|---|---|---|---|---|---|---|---|---|---|---|---|")
    for i, a in enumerate([main] + agents):
        u = a["usage"]
        tools = ", ".join(f"{k}×{v}" for k, v in sorted(a["tools"].items(), key=lambda x: -x[1])[:4])
        start = a["start"].strftime("%H:%M:%S") if a["start"] else "-"
        print(f"| {i} | {start} | {a['type']} | {a['description'][:40]} | {a['depth']}/{a['parent'] or '-'} "
              f"| {(a['model'] or '-').replace('claude-', '')} | {fmt_dur(a)} | {a['calls']} "
              f"| {fmt_k(total(u))} | {fmt_k(u.get('cache_read_input_tokens', 0))} "
              f"| {fmt_k(u.get('output_tokens', 0))} | {fmt_k(a['peak_context'])} | {tools} |")
    print("\n## Files read by ≥ 2 subagents (pre-load / context-pack candidates)\n")
    for path, n in r["dup_reads"] or [("none", 0)]:
        print(f"- {path} — {n} agents" if n else "- none")
    print("\n## Commands run by ≥ 2 agents (cache / cite candidates)\n")
    for cmd, n in r["dup_commands"] or [("none", 0)]:
        print(f"- `{cmd}` — {n} agents" if n else "- none")


def append_ledger(args):
    os.makedirs(os.path.dirname(LEDGER), exist_ok=True)
    if not os.path.isfile(LEDGER):
        with open(LEDGER, "w", encoding="utf-8") as fh:
            fh.write("# Workflow retro ledger\n\nOne row per `/workflow-retro` run (manual). "
                     "Columns are produced by `scripts/workflow-retro.sh --append-ledger`.\n\n"
                     + LEDGER_HEADER)
    session_path = resolve_session(args.session)
    main, agents = collect(session_path, args.since, args.until)
    r = report(main, agents)
    cell = lambda s: s.replace("|", "/").replace("\n", " ").strip()
    row = (f"| {dt.date.today().isoformat()} | {cell(args.label)} | {os.path.basename(session_path)[:8]} "
           f"| {r['agents']} ({r['nested']}) | {r['peak_parallel']} | {r['wall_s'] // 60}m "
           f"| {fmt_k(r['tokens_total'])} | {fmt_k(r['tokens_fresh'])} | {r['cache_read_pct']}% | {r['tool_calls']} "
           f"| {cell(args.verdict)} | {cell(args.actions)} |\n")
    with open(LEDGER, "a", encoding="utf-8") as fh:
        fh.write(row)
    print(row, end="")


def main_cli():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--session", help="session id or .jsonl path (default: newest in this project)")
    p.add_argument("--since", type=parse_ts, help="ISO timestamp, e.g. 2026-10-01T12:00:00Z")
    p.add_argument("--until", type=parse_ts)
    p.add_argument("--json", action="store_true")
    p.add_argument("--append-ledger", action="store_true")
    p.add_argument("--label", default="")
    p.add_argument("--verdict", default="")
    p.add_argument("--actions", default="")
    args = p.parse_args()
    if args.append_ledger:
        if not args.label:
            sys.exit("--append-ledger needs --label")
        return append_ledger(args)
    session_path = resolve_session(args.session)
    main, agents = collect(session_path, args.since, args.until)
    r = report(main, agents)
    if args.json:
        slim = lambda a: {k: (v.isoformat() if isinstance(v, dt.datetime) else v) for k, v in a.items()
                          if k not in ("tool_use_ids", "files_read", "commands", "spawned")}
        print(json.dumps({"session": session_path, "summary": r,
                          "agents": [slim(a) for a in [main] + agents]}, indent=1, default=str))
    else:
        print_markdown(session_path, main, agents, r)


if __name__ == "__main__":
    main_cli()
