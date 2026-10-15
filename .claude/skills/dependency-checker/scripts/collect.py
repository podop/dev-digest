#!/usr/bin/env python3
"""Collect dependency facts for every package of the repo.

Deterministic half of the `dependency-checker` skill: no model is involved, so the
same working tree always produces the same facts. The skill turns them into the
report (references/report-template.md); every number in the report comes from here.

    python3 .claude/skills/dependency-checker/scripts/collect.py [--package <dir> ...]
                                                                [--top N]
                                                                [--online]
                                                                [--out <file>]
                                                                [--repo <path>]

What it measures (offline, from disk only):
  - each top-level package that has a package.json (no workspace: each one is separate)
  - every declared dependency: type (prod/dev/peer/optional), declared range, the
    installed version, own size, closure size (itself + all transitive deps, unique)
  - usage: how many src / test / tooling files import it, string references,
    bin names used in package.json scripts → a status (used / types / unreferenced)
  - phantom imports (imported, not declared), prod deps used only in tests,
    dev deps imported from src
  - version drift of the same dependency across packages
  - internal edges: tsconfig path aliases (cross-package / vendored copy / module
    redirect), how many files use each alias, deep alias imports, relative imports
    that escape the package root
  - the @devdigest/shared drift gate (scripts/check-shared-drift.sh)
  - a ready Mermaid flowchart of the package graph

--online additionally runs `<pm> outdated` and `<pm> audit` per package (network).

Sizes are apparent sizes (sum of file sizes), not disk blocks. Output: JSON on stdout
(or --out). Exit 0 unless the repo cannot be read.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
from pathlib import Path

SKILL_DIR = Path(__file__).resolve().parent.parent
DEFAULT_REPO = SKILL_DIR.parent.parent.parent

DEP_FIELDS = {
    "dependencies": "prod",
    "devDependencies": "dev",
    "peerDependencies": "peer",
    "optionalDependencies": "optional",
}
SOURCE_EXT = {".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"}
SKIP_DIRS = {
    "node_modules", "dist", "build", ".next", "coverage", "clones", "results",
    ".turbo", ".git", "out", "__pycache__", "playwright-report", "test-results",
}
# Top-level directories that are never packages even if they hold a package.json.
NOT_PACKAGES = {"design", "node_modules", ".git", ".claude", ".cursor", "docs", "specs"}
TEST_RE = re.compile(r"(^|/)(test|tests|__tests__|__mocks__|e2e|fixtures)/|\.(test|spec|it\.test)\.[cm]?[jt]sx?$")
IMPORT_RE = re.compile(
    r"""(?:^|[^\w.$])(?:import|export)\s[^'"`;]*?\bfrom\s*['"]([^'"`\s]+)['"]"""
    r"""|(?:^|[^\w.$])import\s*['"]([^'"`\s]+)['"]"""
    r"""|(?:^|[^\w.$])(?:import|require)\s*\(\s*['"]([^'"`\s]+)['"]\s*\)""",
    re.MULTILINE,
)
NODE_BUILTINS = {
    "assert", "async_hooks", "buffer", "child_process", "cluster", "console", "constants",
    "crypto", "dgram", "diagnostics_channel", "dns", "domain", "events", "fs", "http",
    "http2", "https", "inspector", "module", "net", "os", "path", "perf_hooks", "process",
    "punycode", "querystring", "readline", "repl", "stream", "string_decoder", "sys",
    "timers", "tls", "trace_events", "tty", "url", "util", "v8", "vm", "wasi",
    "worker_threads", "zlib", "test",
}
FILE_CAP = 3  # example files kept per fact — enough to verify, small enough to read


# ---------------------------------------------------------------------------- utils


def load_json(path: Path) -> dict:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}


def load_jsonc(path: Path) -> dict:
    """tsconfig.json: strip // and /* */ comments (outside strings) and trailing commas."""
    try:
        text = path.read_text(encoding="utf-8")
    except OSError:
        return {}
    out, i, n, in_str = [], 0, len(text), False
    while i < n:
        c = text[i]
        if in_str:
            out.append(c)
            if c == "\\" and i + 1 < n:
                out.append(text[i + 1])
                i += 1
            elif c == '"':
                in_str = False
        elif c == '"':
            in_str = True
            out.append(c)
        elif text.startswith("//", i):
            while i < n and text[i] != "\n":
                i += 1
            continue
        elif text.startswith("/*", i):
            end = text.find("*/", i + 2)
            i = n if end == -1 else end + 2
            continue
        else:
            out.append(c)
        i += 1
    cleaned = re.sub(r",(\s*[}\]])", r"\1", "".join(out))
    try:
        return json.loads(cleaned)
    except ValueError:
        return {}


def kb(n_bytes: int) -> int:
    return (n_bytes + 1023) // 1024


def rel(path: Path, root: Path) -> str:
    try:
        return path.resolve().relative_to(root.resolve()).as_posix()
    except ValueError:
        return path.as_posix()


def package_name(spec: str) -> str | None:
    """Bare specifier → npm package name; None for relative/absolute/url/builtin."""
    if spec.startswith((".", "/", "#")) or ":" in spec.split("/")[0]:
        return None
    parts = spec.split("/")
    if spec.startswith("@"):
        return "/".join(parts[:2]) if len(parts) >= 2 else None
    return parts[0]


def semver(v: str | None) -> tuple[int, int, int] | None:
    m = re.search(r"(\d+)\.(\d+)\.(\d+)", v or "")
    return (int(m[1]), int(m[2]), int(m[3])) if m else None


def drift_level(versions: list[str]) -> str:
    parsed = [semver(v) for v in versions if v]
    parsed = [p for p in parsed if p]
    if len(set(parsed)) <= 1:
        return "same"
    if len({p[0] for p in parsed}) > 1:
        return "major"
    if len({p[:2] for p in parsed}) > 1:
        return "minor"
    return "patch"


# ---------------------------------------------------------------------------- sizes


class Sizer:
    """Apparent size of installed packages and their transitive closures (Node resolution)."""

    def __init__(self, repo: Path):
        self.repo = repo.resolve()
        self._own: dict[Path, int] = {}
        self._manifest: dict[Path, dict] = {}

    def own(self, pkg_dir: Path) -> int:
        """Bytes in the package directory, excluding nested node_modules (counted separately)."""
        real = pkg_dir.resolve()
        if real in self._own:
            return self._own[real]
        total = 0
        stack = [real]
        while stack:
            d = stack.pop()
            try:
                with os.scandir(d) as it:
                    for e in it:
                        if e.is_symlink():
                            continue
                        if e.is_dir(follow_symlinks=False):
                            if e.name != "node_modules":
                                stack.append(Path(e.path))
                        elif e.is_file(follow_symlinks=False):
                            total += e.stat(follow_symlinks=False).st_size
            except OSError:
                continue
        self._own[real] = total
        return total

    def manifest(self, pkg_dir: Path) -> dict:
        real = pkg_dir.resolve()
        if real not in self._manifest:
            self._manifest[real] = load_json(real / "package.json")
        return self._manifest[real]

    def resolve(self, name: str, from_dir: Path) -> Path | None:
        """Node's lookup: <ancestor>/node_modules/<name>, nearest first, never above the repo."""
        d = from_dir.resolve()
        while True:
            if d.name != "node_modules":
                cand = d / "node_modules" / name
                if (cand / "package.json").is_file():
                    return cand.resolve()
            if d == self.repo or d.parent == d:
                return None
            d = d.parent

    def closure(self, root: Path) -> dict:
        """The package plus every dependency/optionalDependency it pulls in, unique by real path."""
        seen: dict[Path, int] = {}
        stack = [root.resolve()]
        while stack:
            d = stack.pop()
            if d in seen:
                continue
            seen[d] = self.own(d)
            m = self.manifest(d)
            for field in ("dependencies", "optionalDependencies"):
                for dep in m.get(field) or {}:
                    hit = self.resolve(dep, d)
                    if hit and hit not in seen:
                        stack.append(hit)
        members = sorted(
            ((f'{self.manifest(p).get("name") or p.name}@{self.manifest(p).get("version")}', b)
             for p, b in seen.items() if p != root.resolve()),
            key=lambda x: -x[1],
        )
        return {
            "closure_kb": kb(sum(seen.values())),
            "closure_count": len(seen),
            "heaviest_members": [{"name": n, "kb": kb(b)} for n, b in members[:3]],
            "_paths": set(seen),
        }

    def tree(self, node_modules: Path) -> int:
        """Total bytes under a node_modules dir; symlinks are not followed (pnpm store counted once)."""
        if not node_modules.is_dir():
            return 0
        total = 0
        for dirpath, dirnames, filenames in os.walk(node_modules, followlinks=False):
            for f in filenames:
                p = os.path.join(dirpath, f)
                try:
                    st = os.lstat(p)
                except OSError:
                    continue
                if not os.path.islink(p):
                    total += st.st_size
        return total


# ---------------------------------------------------------------------------- scanning


def installed_count(nm: Path) -> int:
    """Installed package directories: the pnpm virtual store when present, else top-level dirs."""
    if not nm.is_dir():
        return 0
    store = nm / ".pnpm"  # node-linker=hoisted keeps only .pnpm/lock.yaml here → fall through
    in_store = sum(1 for e in store.iterdir() if e.is_dir() and e.name != "node_modules") if store.is_dir() else 0
    if in_store:
        return in_store
    return sum(1 for _ in nm.glob("*/package.json")) + sum(1 for _ in nm.glob("@*/*/package.json"))


def discover_packages(repo: Path, only: list[str]) -> list[Path]:
    pkgs = []
    for child in sorted(repo.iterdir()):
        if not child.is_dir() or child.name in NOT_PACKAGES or child.name.startswith("."):
            continue
        if (child / "package.json").is_file():
            pkgs.append(child)
    if only:
        wanted = {o.strip("/") for o in only}
        pkgs = [p for p in pkgs if p.name in wanted]
    return pkgs


def source_files(pkg: Path) -> list[Path]:
    files = []
    for dirpath, dirnames, filenames in os.walk(pkg):
        dirnames[:] = sorted(d for d in dirnames if d not in SKIP_DIRS and not d.startswith("."))
        for f in sorted(filenames):
            if Path(f).suffix in SOURCE_EXT and not f.endswith(".d.ts"):
                files.append(Path(dirpath) / f)
    return files


def file_kind(relpath: str) -> str:
    if TEST_RE.search(relpath):
        return "test"
    if "/" not in relpath or relpath.startswith("scripts/"):
        return "tooling"  # package-root configs (vitest.config.ts, next.config.mjs, …) and scripts/
    return "src"


def scan_imports(pkg: Path) -> list[dict]:
    """Every import specifier in the package: file (relative to pkg), line, kind, spec."""
    found = []
    for f in source_files(pkg):
        try:
            text = f.read_text(encoding="utf-8", errors="replace")
        except OSError:
            continue
        relpath = f.relative_to(pkg).as_posix()
        kind = file_kind(relpath)
        for m in IMPORT_RE.finditer(text):
            spec = m.group(1) or m.group(2) or m.group(3)
            start = m.start() + (0 if m.group(0)[0].isalpha() else 1)  # skip the boundary char
            line = text.count("\n", 0, start) + 1
            found.append({"file": relpath, "line": line, "kind": kind, "spec": spec, "abs": f})
    return found


def string_refs(pkg: Path, names: list[str]) -> dict[str, list[str]]:
    """Files that mention a dependency as a quoted string (configs, transports, plugin names)."""
    refs: dict[str, list[str]] = {n: [] for n in names}
    texts = []
    for f in source_files(pkg):
        try:
            texts.append((f.relative_to(pkg).as_posix(), f.read_text(encoding="utf-8", errors="replace")))
        except OSError:
            pass
    # root configs (.npmrc, tsconfig.json, components.json, …) and stylesheets (`@import "tailwindcss"`)
    extras = [pkg / ".npmrc", *sorted(pkg.glob("*.json"))]
    for dirpath, dirnames, filenames in os.walk(pkg):
        dirnames[:] = sorted(d for d in dirnames if d not in SKIP_DIRS and not d.startswith("."))
        extras += [Path(dirpath) / f for f in sorted(filenames) if f.endswith((".css", ".scss"))]
    for p in extras:
        if p.is_file() and p.name not in ("package.json", "package-lock.json"):
            texts.append((p.relative_to(pkg).as_posix(), p.read_text(encoding="utf-8", errors="replace")))
    for name in names:
        pat = re.compile(r"""['"`]""" + re.escape(name) + r"""(?:/[^'"`]*)?['"`]""")
        for relpath, text in texts:
            if pat.search(text):
                refs[name].append(relpath)
    return refs


# ---------------------------------------------------------------------------- per package


def alias_table(pkg: Path, repo: Path, tsconfig: dict, packages: list[Path]) -> list[dict]:
    """tsconfig paths → classified edges."""
    paths = (tsconfig.get("compilerOptions") or {}).get("paths") or {}
    base = pkg / ((tsconfig.get("compilerOptions") or {}).get("baseUrl") or ".")
    pkg_names = {p.name for p in packages}
    out = []
    for alias, targets in paths.items():
        if not targets:
            continue
        target = (base / targets[0].replace("*", "")).resolve()
        if target.suffix:  # a barrel file → show its directory
            target = target.parent
        target_rel = rel(target, repo).rstrip("/")
        owner = target_rel.split("/")[0]
        if "node_modules" in target.parts:
            kind = "module-redirect"
        elif owner != pkg.name and owner in pkg_names:
            kind = "cross-package"
        elif "/vendor/" in target_rel + "/":
            kind = "vendored"
        else:
            kind = "local"
        out.append({"alias": alias, "target": target_rel, "owner": owner, "kind": kind,
                    "vendored": "/vendor/" in target_rel + "/"})
    return out


def alias_matches(spec: str, alias: str) -> bool:
    if alias.endswith("/*"):
        return spec.startswith(alias[:-1])
    return spec == alias


def analyze_package(pkg: Path, repo: Path, sizer: Sizer, packages: list[Path], top: int) -> dict:
    manifest = load_json(pkg / "package.json")
    tsconfig = load_jsonc(pkg / "tsconfig.json")
    lockfile = next((f for f in ("pnpm-lock.yaml", "package-lock.json", "yarn.lock", "bun.lockb")
                     if (pkg / f).is_file()), None)
    pm = (manifest.get("packageManager") or "").split("@")[0] or (
        {"pnpm-lock.yaml": "pnpm", "package-lock.json": "npm", "yarn.lock": "yarn", "bun.lockb": "bun"}.get(lockfile or "", "npm")
    )
    aliases = alias_table(pkg, repo, tsconfig, packages)
    imports = scan_imports(pkg)
    scripts_text = " ".join((manifest.get("scripts") or {}).values())

    declared: dict[str, dict] = {}
    for field, dtype in DEP_FIELDS.items():
        for name, spec in (manifest.get(field) or {}).items():
            declared.setdefault(name, {"name": name, "type": dtype, "declared": spec})
    refs = string_refs(pkg, list(declared))

    # imports grouped by external package name
    by_pkg: dict[str, list[dict]] = {}
    internal_hits: dict[str, list[dict]] = {a["alias"]: [] for a in aliases}
    escapes = []
    for imp in imports:
        spec = imp["spec"]
        alias = next((a for a in aliases if alias_matches(spec, a["alias"])), None)
        if alias:
            internal_hits[alias["alias"]].append(imp)
            if alias["kind"] != "module-redirect":
                continue
        if spec.startswith("."):
            target = (imp["abs"].parent / spec).resolve()
            owner = rel(target, repo).split("/")[0]
            if owner != pkg.name and owner in {p.name for p in packages}:
                escapes.append({
                    "file": f"{pkg.name}/{imp['file']}", "line": imp["line"], "spec": spec,
                    "kind": imp["kind"], "target_package": owner, "target": rel(target, repo),
                })
            continue
        name = package_name(spec)
        if not name or name.startswith("node:") or name in NODE_BUILTINS:
            continue
        by_pkg.setdefault(name, []).append(imp)

    nm = pkg / "node_modules"
    deps = []
    prod_paths: set[Path] = set()
    for name, d in declared.items():
        installed_dir = (nm / name) if (nm / name / "package.json").is_file() else None
        rec = dict(d)
        uses = by_pkg.get(name, [])
        counts = {k: len({u["file"] for u in uses if u["kind"] == k}) for k in ("src", "test", "tooling")}
        dep_manifest = sizer.manifest(installed_dir) if installed_dir else {}
        bins = dep_manifest.get("bin") or {}
        bin_names = [Path(dep_manifest.get("name") or name).name] if isinstance(bins, str) else list(bins)
        bin_hits = sorted({b for b in bin_names if re.search(r"(^|[\s;&|(])" + re.escape(b) + r"(\s|$)", scripts_text)})
        rec["usage"] = {
            **counts,
            "example_files": sorted({u["file"] for u in uses})[:FILE_CAP],
            "string_refs": refs[name][:FILE_CAP],
            "bins_in_scripts": bin_hits,
        }
        if name.startswith("@types/"):
            rec["status"] = "types"
        elif counts["src"] or counts["test"] or counts["tooling"]:
            rec["status"] = "used"
        elif bin_hits or refs[name]:
            rec["status"] = "used-by-config"
        else:
            rec["status"] = "unreferenced"
        if installed_dir:
            rec["installed"] = dep_manifest.get("version")
            rec["own_kb"] = kb(sizer.own(installed_dir))
            c = sizer.closure(installed_dir)
            if d["type"] == "prod":
                prod_paths |= c["_paths"]
            rec.update({k: v for k, v in c.items() if not k.startswith("_")})
        else:
            rec["installed"] = None  # not installed (or peer provided by the host)
        deps.append(rec)
    deps.sort(key=lambda r: (-(r.get("closure_kb") or 0), r["name"]))

    # Who else needs it: a peer of another declared dep must stay declared; a plain transitive
    # dep of another declared dep is a redundant direct declaration (unless it pins a version).
    installed = {r["name"]: sizer.manifest(nm / r["name"]) for r in deps if r.get("installed")}
    for r in deps:
        r["required_by"] = sorted(
            f"{other}:{rel_kind}"
            for other, m in installed.items() if other != r["name"]
            for rel_kind, field in (("peer", "peerDependencies"), ("dep", "dependencies"))
            if r["name"] in (m.get(field) or {})
        )
        if r["status"] == "unreferenced" and any(x.endswith(":peer") for x in r["required_by"]):
            r["status"] = "peer-of-declared"
        elif r["status"] == "unreferenced" and r["required_by"]:
            r["status"] = "redundant-direct"

    phantom = []
    for name, uses in sorted(by_pkg.items()):
        if name in declared or any(alias_matches(name, a["alias"]) for a in aliases):
            continue
        hit = sizer.resolve(name, pkg)
        phantom.append({
            "name": name,
            "files": sorted({f"{pkg.name}/{u['file']}" for u in uses})[:FILE_CAP],
            "kinds": sorted({u["kind"] for u in uses}),
            "resolves_to": rel(hit, repo) if hit else None,
            # resolves → works only by hoisting (real); does not → usually import text inside a string
            "confidence": "high" if hit else "low",
        })
    prod_only_tests = [r["name"] for r in deps if r["type"] == "prod" and r["status"] == "used"
                       and not r["usage"]["src"] and (r["usage"]["test"] or r["usage"]["tooling"])]
    dev_in_src = [r["name"] for r in deps if r["type"] == "dev" and r["usage"]["src"]]

    internal = []
    for a in aliases:
        hits = internal_hits[a["alias"]]
        deep = sorted({h["spec"] for h in hits if a["alias"].endswith("/*")})
        internal.append({
            **a,
            "files": len({h["file"] for h in hits}),
            "example_files": sorted({f"{pkg.name}/{h['file']}" for h in hits})[:FILE_CAP],
            "deep_imports": deep[:10],
        })

    total_nm = sizer.tree(nm)
    prod_kb = kb(sum(sizer.own(p) for p in prod_paths))
    return {
        "dir": pkg.name,
        "name": manifest.get("name"),
        "package_manager": pm,
        "lockfile": lockfile,
        "installed": nm.is_dir(),
        "counts": {t: sum(1 for r in deps if r["type"] == t) for t in ("prod", "dev", "peer", "optional")},
        "size": {
            "node_modules_kb": kb(total_nm),
            "prod_closure_kb": prod_kb,
            "tooling_kb": max(kb(total_nm) - prod_kb, 0),
            "installed_packages": installed_count(nm),
        },
        "dependencies": deps,
        "top_prod": [r["name"] for r in deps if r["type"] == "prod" and r.get("closure_kb")][:top],
        "internal": internal,
        "boundary_violations": escapes,
        "phantom_imports": phantom,
        "prod_only_in_tests": prod_only_tests,
        "dev_imported_from_src": dev_in_src,
    }


# ---------------------------------------------------------------------------- cross-package


def version_drift(pkgs: list[dict]) -> list[dict]:
    by_name: dict[str, list[dict]] = {}
    for p in pkgs:
        for d in p["dependencies"]:
            by_name.setdefault(d["name"], []).append(
                {"package": p["dir"], "type": d["type"], "declared": d["declared"], "installed": d.get("installed")}
            )
    out = []
    for name, where in sorted(by_name.items()):
        if len(where) < 2:
            continue
        level = drift_level([w["installed"] or w["declared"] for w in where])
        out.append({"name": name, "level": level, "packages": where})
    rank = {"major": 0, "minor": 1, "patch": 2, "same": 3}
    out.sort(key=lambda d: (rank[d["level"]], d["name"]))
    return out


def shared_drift(repo: Path) -> dict:
    script = repo / "scripts" / "check-shared-drift.sh"
    if not script.is_file():
        return {"ran": False, "reason": "scripts/check-shared-drift.sh not found"}
    try:
        out = subprocess.run(["bash", str(script)], cwd=repo, capture_output=True, text=True, timeout=60)
    except (OSError, subprocess.TimeoutExpired) as e:
        return {"ran": False, "reason": str(e)}
    lines = (out.stdout + out.stderr).strip().splitlines()
    return {"ran": True, "exit": out.returncode, "identical": out.returncode == 0, "tail": lines[-6:]}


def run_json(cmd: list[str], cwd: Path) -> tuple[int | None, object]:
    try:
        out = subprocess.run(cmd, cwd=cwd, capture_output=True, text=True, timeout=180)
    except (OSError, subprocess.TimeoutExpired) as e:
        return None, str(e)
    try:
        return out.returncode, json.loads(out.stdout or "null")
    except ValueError:
        return out.returncode, (out.stderr or out.stdout).strip()[-400:]


def online_checks(pkg: Path, pm: str) -> dict:
    """outdated + audit via the package's own manager. Network; failures are reported, not fatal."""
    if pm == "pnpm":
        outdated_cmd, audit_cmd = ["pnpm", "outdated", "--format", "json"], ["pnpm", "audit", "--json"]
    else:
        outdated_cmd, audit_cmd = ["npm", "outdated", "--json"], ["npm", "audit", "--json"]
    res: dict = {}
    code, data = run_json(outdated_cmd, pkg)
    if isinstance(data, dict):
        res["outdated"] = [
            {"name": n, "current": v.get("current"), "wanted": v.get("wanted"), "latest": v.get("latest"),
             "major_behind": (semver(v.get("latest")) or (0,))[0] - (semver(v.get("current")) or (0,))[0]}
            for n, v in sorted(data.items()) if isinstance(v, dict)
        ]
    else:
        res["outdated_error"] = data
    code, data = run_json(audit_cmd, pkg)
    if isinstance(data, dict):
        meta = (data.get("metadata") or {}).get("vulnerabilities") or {}
        advisories = []
        for adv in (data.get("advisories") or {}).values():  # pnpm / npm v6 shape
            advisories.append({"module": adv.get("module_name"), "severity": adv.get("severity"),
                               "title": adv.get("title"), "fixed_in": adv.get("patched_versions"),
                               "paths": [f.get("paths", [])[:2] for f in adv.get("findings", [])][:2]})
        for name, v in (data.get("vulnerabilities") or {}).items():  # npm v7+ shape
            advisories.append({"module": name, "severity": v.get("severity"), "direct": v.get("isDirect"),
                               "fix_available": bool(v.get("fixAvailable")), "via": [
                                   x.get("title") if isinstance(x, dict) else x for x in v.get("via", [])][:3]})
        res["audit"] = {"counts": meta, "advisories": advisories[:30]}
    else:
        res["audit_error"] = data
    return res


# ---------------------------------------------------------------------------- mermaid


def node_id(text: str) -> str:
    return re.sub(r"[^A-Za-z0-9_]", "_", text)


def human(kb_value: int) -> str:
    return f"{kb_value / 1024:.1f} MB" if kb_value >= 1024 else f"{kb_value} KB"


def mermaid(pkgs: list[dict], drift: list[dict]) -> str:
    drifted = {d["name"] for d in drift if d["level"] in ("major", "minor")}
    lines = ["flowchart LR"]
    vendored, edges, ext = {}, [], {}
    for p in pkgs:
        c, s = p["counts"], p["size"]
        lines.append(f'  {node_id(p["dir"])}["<b>{p["dir"]}</b><br/>{p["name"]}<br/>'
                     f'{c["prod"]} prod · {c["dev"]} dev · {human(s["node_modules_kb"])}"]:::pkg')
        for e in p["internal"]:
            if e["alias"].endswith("/*") or e["kind"] == "local":
                continue
            if e["vendored"]:  # own or another package's vendored copy → its own node
                vid = node_id(e["target"])
                vendored[vid] = e["target"]
                edges.append(f'  {node_id(p["dir"])} -->|"{e["alias"]} · {e["files"]} files"| {vid}')
            elif e["kind"] == "cross-package":
                edges.append(f'  {node_id(p["dir"])} -->|"{e["alias"]} · {e["files"]} files"| {node_id(e["owner"])}')
        for v in p["boundary_violations"]:
            edges.append(f'  {node_id(p["dir"])} -.->|"relative import ⚠"| {node_id(v["target_package"])}')
        for name in p["top_prod"]:
            dep = next(d for d in p["dependencies"] if d["name"] == name)
            ext.setdefault(name, {"kb": dep.get("closure_kb") or 0, "vers": set()})
            ext[name]["vers"].add(dep.get("installed") or dep["declared"])
            edges.append(f'  {node_id(p["dir"])} -.-> ext_{node_id(name)}')
    for vid, target in sorted(vendored.items()):
        lines.append(f'  {vid}[("{target}")]:::vendored')
    for name, info in sorted(ext.items()):
        cls = "drift" if name in drifted else "ext"
        lines.append(f'  ext_{node_id(name)}(["{name} {"/".join(sorted(info["vers"]))}<br/>{human(info["kb"])}"]):::{cls}')
    lines += sorted(set(edges), key=edges.index)
    lines += [
        "  classDef pkg fill:#e8f0fe,stroke:#3b6fd8,color:#0b2a66",
        "  classDef vendored fill:#fff4e5,stroke:#d9822b,color:#5c3200",
        "  classDef ext fill:#f4f4f4,stroke:#999,color:#333",
        "  classDef drift fill:#fdecea,stroke:#d93025,color:#7a1010",
    ]
    return "\n".join(lines)


# ---------------------------------------------------------------------------- main


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--package", action="append", default=[], help="limit to these top-level package dirs")
    ap.add_argument("--top", type=int, default=3, help="heaviest prod deps per package shown in the graph")
    ap.add_argument("--online", action="store_true", help="also run <pm> outdated + audit (network)")
    ap.add_argument("--out", help="write JSON here instead of stdout")
    ap.add_argument("--repo", default=str(DEFAULT_REPO), help=argparse.SUPPRESS)
    args = ap.parse_args(argv)

    repo = Path(args.repo).resolve()
    all_pkgs = discover_packages(repo, [])
    selected = discover_packages(repo, args.package)
    if not selected:
        print(f"no package.json found under {repo} for {args.package or 'any top-level dir'}", file=sys.stderr)
        return 1
    sizer = Sizer(repo)
    pkgs = [analyze_package(p, repo, sizer, all_pkgs, args.top) for p in selected]
    if args.online:
        for p in pkgs:
            p["online"] = online_checks(repo / p["dir"], p["package_manager"])
    drift = version_drift(pkgs)
    report = {
        "repo": repo.name,
        "workspace": (repo / "pnpm-workspace.yaml").is_file() or "workspaces" in load_json(repo / "package.json"),
        "packages_found": [p.name for p in all_pkgs],
        "packages": pkgs,
        "version_drift": drift,
        "shared_drift": shared_drift(repo),
        "online": args.online,
        "mermaid": mermaid(pkgs, drift),
        "notes": [
            "sizes are apparent bytes from the local node_modules; a missing node_modules means 'not installed', not 'zero'",
            "status 'unreferenced' is a CANDIDATE: verify with grep before calling a dependency unused",
            "closure_kb counts shared transitive deps in every closure that needs them; do not sum closures",
        ],
    }
    text = json.dumps(report, indent=1, ensure_ascii=False)
    if args.out:
        Path(args.out).write_text(text + "\n", encoding="utf-8")
        print(f"wrote {args.out}")
    else:
        print(text)
    return 0


if __name__ == "__main__":
    sys.exit(main())
