#!/usr/bin/env python3
"""Deterministic checks for a spec written to the specreator template.

  scripts/spec-lint.sh specs/2026-10-01-foo.md [more specs…]

Errors (exit 1): missing required section or header; an FR/EC/NFR no AC traces; an AC
without `Traces:` or `Verify:`, with an unknown verify method, or tracing an unknown id;
duplicate ids; Mermaid C4 diagrams. Warnings (exit 0): vague words outside code blocks.
Struck-through items (`- ~~FR3 …~~`) are dropped requirements and are not checked.
Legacy `NN-*.md` specs predate the template and are not meant to pass.
"""
import re
import sys

REQUIRED = ("Goal", "Scope", "Functional requirements", "Acceptance criteria", "Traceability",
            "Open questions")
VERIFY = {"unit", "integration", "component", "e2e", "manual"}
ITEM = re.compile(r"^- (~~)?\s*(FR|EC|NFR|AC)(\d+)\b")
ID = re.compile(r"\b(?:FR|EC|NFR)\d+\b")
VAGUE = re.compile(r"\b(should probably|user-friendly|etc\.|as needed|TBD|fast|quickly|seamless(?:ly)?)(?![\w-])",
                   re.I)


def lint(path):
    errors, warnings = [], []
    text = open(path, encoding="utf-8").read()
    lines = text.split("\n")
    if not re.search(r"^Spec: .*Status: ", text, re.M):
        errors.append("header line `Spec: … · Status: …` missing")
    headings = [l for l in lines if l.startswith("## ")]
    for name in REQUIRED:
        if not any(name.lower() in h.lower() for h in headings):
            errors.append(f"section missing: {name}")

    defined, acs, fence, block = {}, {}, None, None
    for n, line in enumerate(lines, 1):
        if line.startswith("```"):
            if fence is None:
                fence = line[3:].strip()
                if fence == "mermaid":
                    nxt = next((l.strip() for l in lines[n:] if l.strip()), "")
                    if nxt.startswith("C4"):
                        errors.append(f"line {n + 1}: Mermaid C4 syntax does not render on GitHub")
            else:
                fence = None
            continue
        if fence is not None:
            continue
        for m in VAGUE.finditer(line):
            warnings.append(f"line {n}: vague word '{m.group(1)}'")
        m = ITEM.match(line)
        if m:
            struck, kind, num = m.group(1), m.group(2), m.group(3)
            key = f"{kind}{num}"
            if key in defined:
                errors.append(f"line {n}: duplicate id {key} (first at line {defined[key][0]})")
            defined[key] = (n, bool(struck))
            block = key if kind == "AC" and not struck else None
            if block:
                acs[block] = {"line": n, "text": line}
            continue
        if block and (line.startswith("  ") or not line.strip()) and not line.startswith("## "):
            acs[block]["text"] += "\n" + line
        else:
            block = None

    live = {k for k, (_, struck) in defined.items() if not struck}
    traced = set()
    for ac, info in acs.items():
        body = info["text"]
        tm = re.search(r"Traces:\s*([^·\n]+)", body)
        vm = re.search(r"Verify:\s*([^\n]+)", body)
        if not tm:
            errors.append(f"line {info['line']}: {ac} has no `Traces:`")
        else:
            for ref in ID.findall(tm.group(1)):
                if ref not in defined:
                    errors.append(f"line {info['line']}: {ac} traces unknown {ref}")
                traced.add(ref)
        if not vm:
            errors.append(f"line {info['line']}: {ac} has no `Verify:`")
        else:
            methods = {w.strip().lower() for w in re.split(r"[|,/]", vm.group(1)) if w.strip()}
            bad = methods - VERIFY
            if bad or not methods:
                errors.append(f"line {info['line']}: {ac} Verify must be one of {sorted(VERIFY)}, got {vm.group(1).strip()!r}")
    if not acs:
        errors.append("no acceptance criteria (`- AC1 …`)")
    for key in sorted(live, key=lambda k: (re.sub(r"\d", "", k), int(re.sub(r"\D", "", k)))):
        if not key.startswith("AC") and key not in traced:
            errors.append(f"line {defined[key][0]}: {key} is not traced by any AC")
    return errors, warnings


def main():
    if len(sys.argv) < 2:
        print(__doc__.strip(), file=sys.stderr)
        return 2
    failed = False
    for path in sys.argv[1:]:
        errors, warnings = lint(path)
        status = "FAIL" if errors else "ok"
        print(f"{status} {path} — {len(errors)} error(s), {len(warnings)} warning(s)")
        for e in errors:
            print(f"  error   {e}")
        for w in warnings:
            print(f"  warning {w}")
        failed |= bool(errors)
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
