#!/usr/bin/env python3
"""Unit tests for the dependency collector — a synthetic repo built in a temp dir.

    python3 .claude/skills/dependency-checker/scripts/test_collect.py
"""

from __future__ import annotations

import json
import os
import tempfile
import unittest
from pathlib import Path

import collect


def write(path: Path, text: str = "") -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")


def npm_pkg(nm: Path, name: str, version: str, deps: dict | None = None, bin_: dict | None = None,
            payload: int = 0, peers: dict | None = None) -> Path:
    d = nm / name
    manifest = {"name": name, "version": version, "dependencies": deps or {}}
    if bin_:
        manifest["bin"] = bin_
    if peers:
        manifest["peerDependencies"] = peers
    write(d / "package.json", json.dumps(manifest))
    if payload:
        write(d / "index.js", "x" * payload)
    return d


def build_repo(root: Path) -> None:
    # server: npm/hoisted layout, path aliases, every usage status
    s = root / "server"
    write(s / "package.json", json.dumps({
        "name": "@demo/api",
        "scripts": {"test": "vitest run", "typecheck": "tsc --noEmit"},
        "dependencies": {"fastify": "^5.1.0", "moment": "^2.30.1", "testcontainers": "^10.0.0",
                         "zod": "3.23.8", "pino-pretty": "^11.0.0"},
        "devDependencies": {"@tc/pg": "^10.0.0", "vitest": "^2.1.0", "typescript": "^5.6.0",
                            "@types/node": "^22.0.0"},
    }))
    write(s / "pnpm-lock.yaml", "lockfileVersion: '9.0'\n")
    write(s / "tsconfig.json", """{
      // comments and trailing commas are legal in tsconfig
      "compilerOptions": {
        "paths": {
          "@demo/shared": ["./src/vendor/shared/index.ts"],
          "@demo/core": ["../core/src/index.ts"], /* cross-package */
          "@demo/core/*": ["../core/src/*"],
        },
        "description": "a // inside a string is not a comment",
      },
    }""")
    write(s / "src/vendor/shared/index.ts", "export const shared = 1;\n")
    write(s / "src/app.ts", "\n".join([
        "import Fastify from 'fastify';",
        "import { shared } from '@demo/shared';",
        "import { review } from '@demo/core';",
        "import { internals } from '@demo/core/pipeline/step';",
        "import { run } from '../../core/src/pipeline.js';",
        "import _ from 'lodash';",
        "import { readFile } from 'node:fs/promises';",
        "import path from 'path';",
        "const z = await import('zod');",
        "export const logger = { transport: { target: 'pino-pretty' } };",
    ]))
    write(s / "src/fixture-text.ts", 'export const sample = "import x from \'ghost-pkg\'";\n')
    write(s / "test/app.test.ts", "import { PostgreSqlContainer } from '@tc/pg';\n")
    nm = s / "node_modules"
    npm_pkg(nm, "fastify", "5.1.0", {"avvio": "^9"}, payload=2048)
    npm_pkg(nm, "avvio", "9.0.0", payload=1024)
    npm_pkg(nm, "moment", "2.30.1", payload=4096)
    npm_pkg(nm, "testcontainers", "10.0.0")
    npm_pkg(nm, "@tc/pg", "10.0.0", {"testcontainers": "^10.0.0"})
    npm_pkg(nm, "lodash", "4.17.21")  # installed (hoisted transitive) but never declared
    npm_pkg(nm, "zod", "3.23.8")
    npm_pkg(nm, "pino-pretty", "11.0.0")
    npm_pkg(nm, "vitest", "2.1.0", bin_={"vitest": "vitest.mjs"})
    npm_pkg(nm, "typescript", "5.6.0", bin_={"tsc": "bin/tsc"})
    npm_pkg(nm, "@types/node", "22.0.0")

    # core: no aliases, zod drifts from server
    c = root / "core"
    write(c / "package.json", json.dumps({"name": "@demo/core", "dependencies": {"zod": "3.22.4"}}))
    write(c / "package-lock.json", "{}")
    write(c / "src/index.ts", "import { z } from 'zod';\nexport const review = z.string();\n")
    write(c / "src/pipeline.ts", "export const run = 1;\n")
    npm_pkg(c / "node_modules", "zod", "3.22.4")

    # web: pnpm isolated layout (symlinks into the virtual store)
    w = root / "web"
    write(w / "package.json", json.dumps({"name": "@demo/web", "dependencies": {"react": "19.0.0"}}))
    write(w / "src/page.tsx", "import { useState } from 'react';\n")
    store = w / "node_modules" / ".pnpm"
    react = npm_pkg(store / "react@19.0.0" / "node_modules", "react", "19.0.0", {"loose-envify": "^1"}, payload=3000)
    envify = npm_pkg(store / "loose-envify@1.4.0" / "node_modules", "loose-envify", "1.4.0", payload=1000)
    os.symlink(envify, store / "react@19.0.0" / "node_modules" / "loose-envify")
    os.symlink(react, w / "node_modules" / "react")

    # not packages
    write(root / "design" / "package.json", "{}")


class Fixture(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        cls.repo = Path(cls.tmp.name)
        build_repo(cls.repo)
        out = cls.repo / "out.json"
        collect.main(["--repo", str(cls.repo), "--out", str(out)])
        cls.report = json.loads(out.read_text())
        cls.pkgs = {p["dir"]: p for p in cls.report["packages"]}

    @classmethod
    def tearDownClass(cls):
        cls.tmp.cleanup()

    def dep(self, pkg: str, name: str) -> dict:
        return next(d for d in self.pkgs[pkg]["dependencies"] if d["name"] == name)


class TestHelpers(unittest.TestCase):
    def test_package_name_from_specifier(self):
        self.assertEqual(collect.package_name("@scope/pkg/sub/path"), "@scope/pkg")
        self.assertEqual(collect.package_name("lodash/fp"), "lodash")
        self.assertIsNone(collect.package_name("./local"))
        self.assertIsNone(collect.package_name("node:fs"))

    def test_drift_level(self):
        self.assertEqual(collect.drift_level(["3.23.8", "3.23.8"]), "same")
        self.assertEqual(collect.drift_level(["3.23.8", "3.23.1"]), "patch")
        self.assertEqual(collect.drift_level(["3.23.8", "3.22.4"]), "minor")
        self.assertEqual(collect.drift_level(["2.1.9", "3.2.7"]), "major")

    def test_jsonc_keeps_double_slash_inside_strings(self):
        with tempfile.TemporaryDirectory() as d:
            p = Path(d) / "tsconfig.json"
            p.write_text('{ "a": "http://x", // c\n "b": [1,], }')
            self.assertEqual(collect.load_jsonc(p), {"a": "http://x", "b": [1]})


class TestDiscovery(Fixture):
    def test_only_top_level_packages_and_never_design(self):
        self.assertEqual(self.report["packages_found"], ["core", "server", "web"])
        self.assertFalse(self.report["workspace"])

    def test_package_manager_from_lockfile(self):
        self.assertEqual(self.pkgs["server"]["package_manager"], "pnpm")
        self.assertEqual(self.pkgs["core"]["package_manager"], "npm")


class TestUsage(Fixture):
    def test_statuses(self):
        self.assertEqual(self.dep("server", "fastify")["status"], "used")
        self.assertEqual(self.dep("server", "zod")["status"], "used")  # dynamic import()
        self.assertEqual(self.dep("server", "moment")["status"], "unreferenced")
        self.assertEqual(self.dep("server", "testcontainers")["status"], "redundant-direct")
        self.assertEqual(self.dep("server", "testcontainers")["required_by"], ["@tc/pg:dep"])
        self.assertEqual(self.dep("server", "vitest")["status"], "used-by-config")
        self.assertEqual(self.dep("server", "typescript")["usage"]["bins_in_scripts"], ["tsc"])
        self.assertEqual(self.dep("server", "pino-pretty")["status"], "used-by-config")  # string ref only
        self.assertEqual(self.dep("server", "@types/node")["status"], "types")

    def test_file_kinds(self):
        u = self.dep("server", "@tc/pg")["usage"]
        self.assertEqual((u["src"], u["test"]), (0, 1))

    def test_phantom_imports_with_confidence(self):
        phantom = {p["name"]: p for p in self.pkgs["server"]["phantom_imports"]}
        self.assertEqual(phantom["lodash"]["confidence"], "high")
        self.assertEqual(phantom["lodash"]["resolves_to"], "server/node_modules/lodash")
        self.assertEqual(phantom["ghost-pkg"]["confidence"], "low")
        self.assertNotIn("path", phantom)  # builtins are not dependencies

    def test_prod_dep_used_only_in_tests_is_flagged(self):
        self.assertEqual(self.pkgs["server"]["prod_only_in_tests"], [])
        self.assertEqual(self.pkgs["server"]["dev_imported_from_src"], [])


class TestInternal(Fixture):
    def test_aliases_are_classified(self):
        edges = {e["alias"]: e for e in self.pkgs["server"]["internal"]}
        self.assertEqual(edges["@demo/shared"]["kind"], "vendored")
        self.assertEqual(edges["@demo/shared"]["target"], "server/src/vendor/shared")
        self.assertEqual(edges["@demo/core"]["kind"], "cross-package")
        self.assertEqual(edges["@demo/core"]["files"], 1)
        self.assertEqual(edges["@demo/core/*"]["deep_imports"], ["@demo/core/pipeline/step"])

    def test_relative_import_into_another_package_is_a_violation(self):
        v = self.pkgs["server"]["boundary_violations"]
        self.assertEqual(len(v), 1)
        self.assertEqual((v[0]["file"], v[0]["line"], v[0]["target_package"]), ("server/src/app.ts", 5, "core"))

    def test_alias_imports_are_not_external_dependencies(self):
        names = {p["name"] for p in self.pkgs["server"]["phantom_imports"]}
        self.assertFalse(names & {"@demo/shared", "@demo/core"})


class TestSizes(Fixture):
    def test_own_and_closure_sizes(self):
        fastify = self.dep("server", "fastify")
        self.assertGreaterEqual(fastify["own_kb"], 2)
        self.assertEqual(fastify["closure_count"], 2)  # fastify + avvio
        self.assertGreater(fastify["closure_kb"], fastify["own_kb"])
        self.assertEqual(fastify["heaviest_members"][0]["name"], "avvio@9.0.0")

    def test_pnpm_symlinked_store_is_resolved(self):
        react = self.dep("web", "react")
        self.assertEqual(react["installed"], "19.0.0")
        self.assertEqual(react["closure_count"], 2)  # react + loose-envify through the store symlink
        self.assertEqual(self.pkgs["web"]["size"]["installed_packages"], 2)


class TestCrossPackage(Fixture):
    def test_version_drift(self):
        zod = next(d for d in self.report["version_drift"] if d["name"] == "zod")
        self.assertEqual(zod["level"], "minor")
        self.assertEqual({p["package"]: p["installed"] for p in zod["packages"]},
                         {"core": "3.22.4", "server": "3.23.8"})

    def test_shared_drift_gate_absent_is_reported_not_faked(self):
        self.assertFalse(self.report["shared_drift"]["ran"])

    def test_mermaid_graph(self):
        m = self.report["mermaid"]
        self.assertTrue(m.startswith("flowchart LR"))
        self.assertIn('server -->|"@demo/core · 1 files"| core', m)
        self.assertIn('server_src_vendor_shared[("server/src/vendor/shared")]', m)
        self.assertIn('server -.->|"relative import ⚠"| core', m)
        self.assertIn("classDef drift", m)


if __name__ == "__main__":
    unittest.main(verbosity=2)
