#!/usr/bin/env python3
"""Tests for the commit-gate PreToolUse hook (spec: specs/2026-10-15-commit-test-gate.md).

    python3 .claude/hooks/test_commit_gate.py        # from the repo root; python3 >= 3.9, stdlib only

Hermetic: every test builds a temp git repo that holds a copy of the hook, scripts/gates.py
and the real .gitignore, so nothing is logged to the real .devdigest/ and no global git
config is read. Black-box tests run the copied hook as a subprocess with JSON on stdin.
"""
from __future__ import annotations

import contextlib
import importlib.util
import io
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest import mock

REAL_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
HOOK_SRC = os.path.join(REAL_ROOT, ".claude", "hooks", "commit-gate.py")
GATES_SRC = os.path.join(REAL_ROOT, "scripts", "gates.py")
IGNORE_SRC = os.path.join(REAL_ROOT, ".gitignore")
LOG_REL = os.path.join(".devdigest", "commit-gate", "log.jsonl")
GREEN = ("root:drift", "server:unit", "client:test")


class RepoCase(unittest.TestCase):
    """A temp repo `self.repo` with the hook installed, plus helpers."""

    def setUp(self):
        self.tmp = os.path.realpath(tempfile.mkdtemp(prefix="commit-gate-test-"))
        self.addCleanup(shutil.rmtree, self.tmp, True)
        open(os.path.join(self.tmp, "empty"), "w").close()
        env = {k: v for k, v in os.environ.items()
               if not k.startswith(("GIT_", "DEVDIGEST_")) and k != "CLAUDE_PROJECT_DIR"}
        env.update(
            GIT_CONFIG_GLOBAL=os.path.join(self.tmp, "empty"), GIT_CONFIG_NOSYSTEM="1", HOME=self.tmp,
            GIT_AUTHOR_NAME="t", GIT_AUTHOR_EMAIL="t@t", GIT_COMMITTER_NAME="t", GIT_COMMITTER_EMAIL="t@t",
        )
        self.env = env
        self.repo = os.path.join(self.tmp, "repo")
        os.makedirs(self.repo)
        self.git("init", "-q", "-b", "main")
        os.makedirs(os.path.join(self.repo, ".claude", "hooks"))
        os.makedirs(os.path.join(self.repo, "scripts"))
        shutil.copy(HOOK_SRC, os.path.join(self.repo, ".claude", "hooks", "commit-gate.py"))
        shutil.copy(GATES_SRC, os.path.join(self.repo, "scripts", "gates.py"))
        shutil.copy(IGNORE_SRC, os.path.join(self.repo, ".gitignore"))
        self.hook = os.path.join(self.repo, ".claude", "hooks", "commit-gate.py")
        for rel in ("server/src/a.ts", "server/src/c.ts", "client/src/b.ts", "README.md"):
            self.write(rel, "export const v = 1;\n")
        self.git("add", "-A")
        self.git("commit", "-q", "-m", "seed")

    # -- helpers
    def git(self, *args, cwd=None):
        res = subprocess.run(["git", *args], cwd=cwd or self.repo, env=self.env, capture_output=True,
                             text=True, check=False)
        self.assertEqual(res.returncode, 0, "git %s: %s" % (" ".join(args), res.stderr))
        return res.stdout

    def write(self, rel, text="export const v = 2;\n", root=None):
        path = os.path.join(root or self.repo, rel)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "w") as f:
            f.write(text)

    def state(self, root=None):
        root = root or self.repo
        res = subprocess.run([sys.executable, os.path.join(root, "scripts", "gates.py"), "--state"],
                             env=self.env, capture_output=True, text=True, check=True)
        return res.stdout.strip()

    def report(self, gates, state=None, root=None, raw=None):
        root = root or self.repo
        state = state or self.state(root)
        path = os.path.join(root, ".devdigest", "gates", state + ".json")
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "w") as f:
            f.write(raw if raw is not None else json.dumps(
                {"state": state, "gates": {g: {"id": g, "exit": e} for g, e in gates.items()}}))
        return state

    def green(self, *ids):
        return {g: 0 for g in (ids or GREEN)}

    def run_hook(self, command, cwd=None, extra_env=None, **payload):
        body = {"tool_name": "Bash", "tool_input": {"command": command}, "cwd": cwd or self.repo,
                "session_id": "sess-1"}
        body.update(payload)
        env = dict(self.env)
        env.update(extra_env or {})
        return subprocess.run([sys.executable, self.hook], input=json.dumps(body), env=env,
                              capture_output=True, text=True, check=False)

    def log_lines(self):
        path = os.path.join(self.repo, LOG_REL)
        if not os.path.exists(path):
            return []
        with open(path) as f:
            return [json.loads(line) for line in f if line.strip()]

    def log_lines_in(self, root):
        path = os.path.join(root, LOG_REL)
        if not os.path.exists(path):
            return []
        with open(path) as f:
            return [json.loads(line) for line in f if line.strip()]

    def load_module(self):
        spec = importlib.util.spec_from_file_location("commit_gate_under_test", self.hook)
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)
        return mod

    def run_main(self, mod, stdin):
        out, err = io.StringIO(), io.StringIO()
        with mock.patch.object(sys, "stdin", io.StringIO(stdin)), contextlib.redirect_stdout(out), \
                contextlib.redirect_stderr(err):
            rc = mod.main()
        return rc, out.getvalue(), err.getvalue()

    def payload(self, command, **extra):
        body = {"tool_name": "Bash", "tool_input": {"command": command}, "cwd": self.repo, "session_id": "s"}
        body.update(extra)
        return json.dumps(body)

    def stage_server(self):
        self.write("server/src/a.ts")
        self.git("add", "server/src/a.ts")


# ---------------------------------------------------------------------------- S1


class TestDetection(RepoCase):
    def setUp(self):
        super().setUp()
        self.mod = self.load_module()

    def find(self, command, cwd=None):
        return self.mod.find_commits(command, cwd or self.repo)

    def test_ac2_forms_are_each_one_commit(self):
        forms = [
            "git commit -m x",
            "cd s && git commit -am x",
            "git -C s commit",
            "FOO=1 git commit",
            "/usr/bin/git commit",
            'bash -c "git commit"',
            "git -c alias.ci=commit ci",
            "git commit-tree HEAD^{tree}",
        ]
        for command in forms:
            with self.subTest(command=command):
                commits = self.find(command)
                self.assertEqual(len(commits), 1)
                self.assertIn(commits[0].kind, ("commit", "commit-tree"))

    def test_config_alias_expands_to_commit(self):
        self.git("config", "alias.co2", "commit -v")
        commits = self.find("git co2 -m x")
        self.assertEqual([c.kind for c in commits], ["commit"])
        self.assertEqual(commits[0].args, ["-v", "-m", "x"])

    def test_shell_alias_with_git_commit_is_gated(self):
        self.git("config", "alias.sh1", "!git add -A && git commit")
        self.assertEqual([c.kind for c in self.find("git sh1")], ["unparsed"])

    def test_more_grammar(self):
        for command in [
            "echo $(git commit -m x)", "echo `git commit -m x`", "(git commit -m x)", "time git commit -m x",
            "env FOO=1 git commit -m x", "if true; then git commit -m x; fi", "git --no-pager commit",
            "git --git-dir=.git commit", "echo hi > out && git commit -m x", "ls 2>&1 | git commit -F -",
            "eval 'git commit -m x'", "sh -c 'echo; git commit'", "bash -lc 'git commit'",
            "echo a\ngit commit -m x", "git commit -m a && git commit -m b",
            'echo "$(git commit -m x)"', "nohup git commit -m x &",
            "bash <<EOF\ngit commit -m x\nEOF",
        ]:
            with self.subTest(command=command):
                self.assertGreaterEqual(len(self.find(command)), 1)

    def test_ac3_non_commits_make_no_git_call(self):
        for command in ['grep "git commit" f', "echo git commit", "git log --grep commit",
                        "git commit-graph write", "echo '$(git commit)'", "cat <<EOF\ngit commit\nEOF",
                        "git status && git diff --stat", "# git commit"]:
            with self.subTest(command=command):
                fake = mock.Mock(side_effect=AssertionError("git must not run"))
                with mock.patch.object(self.mod, "git", fake), \
                        mock.patch.object(subprocess, "run", fake):
                    rc, out, err = self.run_main(self.mod, self.payload(command))
                self.assertEqual((rc, out, err), (0, "", ""))
                self.assertEqual(fake.call_count, 0)

    def test_ac4_unbalanced_quote_is_a_commit(self):
        self.assertEqual([c.kind for c in self.find('git commit -m "x')], ["unparsed"])
        self.assertEqual(self.find('echo "unterminated'), [])

    def test_too_deep_nesting_falls_back_to_unparsed(self):
        cmd = "git commit"
        for _ in range(6):
            cmd = "echo $(%s)" % cmd
        self.assertEqual([c.kind for c in self.find(cmd)], ["unparsed"])

    def test_heredoc_with_apostrophe_does_not_break_parsing(self):
        command = "git commit -m \"$(cat <<'EOF'\nfix: don't crash on `git commit`\n\nbody's text\nEOF\n)\""
        commits = self.find(command)
        self.assertEqual([c.kind for c in commits], ["commit"])
        self.assertEqual(commits[0].args[0], "-m")

    def test_cd_target_is_tracked(self):
        commits = self.find("cd sub && git commit -m x", cwd="/base")
        self.assertEqual(commits[0].dir, "/base/sub")
        self.assertEqual(self.find("git -C s commit")[0].git_opts, ["-C", "s"])
        self.assertEqual(self.find("git -c user.name=x commit")[0].git_opts, [])

    def test_command_text_is_never_executed(self):
        pwn = os.path.join(self.tmp, "pwn")
        self.find('git commit -m "$(touch %s)"' % pwn)
        self.find("echo `touch %s`" % pwn)
        self.assertFalse(os.path.exists(pwn))

    def test_commit_arg_parser(self):
        parse = self.mod.parse_commit_args
        self.assertEqual(parse(["-am", "msg"]), (True, [], False))
        self.assertEqual(parse(["-ma"]), (False, [], False))
        self.assertEqual(parse(["-m", "a", "--", "x.ts"]), (False, ["x.ts"], False))
        self.assertEqual(parse(["--all", "--author", "me", "f.ts", "-m", "x"]), (True, ["f.ts"], False))
        self.assertEqual(parse(["--pathspec-from-file", "list"]), (False, [], True))
        self.assertEqual(parse(["-m", "x", "$(echo f)"])[2], True)

    def test_errors_before_identification_allow(self):
        with mock.patch.object(self.mod, "find_commits", side_effect=RuntimeError("boom")):
            self.assertEqual(self.run_main(self.mod, self.payload("ls"))[0], 0)
        self.assertEqual(self.run_main(self.mod, "not json")[0], 0)
        self.assertEqual(self.run_main(self.mod, self.payload("git commit", tool_name="Read"))[0], 0)
        self.assertEqual(self.run_main(self.mod, json.dumps({"tool_name": "Bash", "tool_input": {}}))[0], 0)


# ---------------------------------------------------------------------------- S2


class TestDecision(RepoCase):
    def blocked(self, res, reason):
        self.assertEqual(res.returncode, 2, res.stderr)
        self.assertEqual(res.stdout, "")
        self.assertIn("(%s)" % reason, res.stderr.split("\n")[0])
        return res.stderr

    def test_ac2_forms_block_without_a_report(self):
        self.stage_server()
        for command in [
            "git commit -m x", "cd server && git commit -am x", "git -C server commit -m x",
            "FOO=1 git commit -m x", "/usr/bin/git commit -m x", 'bash -c "git commit -m x"',
            "git -c alias.ci=commit ci -m x", "git commit-tree HEAD^{tree}",
            "git commit -m a && git commit -m b",
        ]:
            with self.subTest(command=command):
                self.blocked(self.run_hook(command), "no-report")

    def test_ac4_unbalanced_quote_blocks(self):
        self.stage_server()
        self.blocked(self.run_hook('git commit -m "x'), "no-report")

    def test_ac5_docs_only_and_empty_sets_are_allowed_without_a_report(self):
        self.write("README.md", "# doc\n")
        self.git("add", "README.md")
        self.write("server/README.md", "# s\n")
        self.git("add", "server/README.md")
        self.assertEqual(self.run_hook("git commit -m x").returncode, 0)
        self.git("commit", "-q", "-m", "docs")
        self.write("README.md", "# doc 2\n")
        self.assertEqual(self.run_hook("git commit -am x").returncode, 0)
        self.assertEqual(self.run_hook("git commit --amend -m reword").returncode, 0)
        self.assertEqual(self.run_hook("git commit --allow-empty -m x").returncode, 0)
        self.write("server/src/a.ts")
        self.blocked(self.run_hook("git commit -am x"), "no-report")

    def test_pathspec_limits_the_path_set(self):
        self.write("server/src/a.ts")
        self.write("README.md", "# doc 3\n")
        self.assertEqual(self.run_hook("git commit README.md -m x").returncode, 0)
        self.blocked(self.run_hook("git commit server/src/a.ts -m x"), "no-report")
        self.blocked(self.run_hook("git commit --pathspec-from-file=list -m x"), "no-report")
        self.blocked(self.run_hook('git commit "$(echo README.md)" -m x'), "no-report")

    def test_ac6_report_for_another_state_is_no_report(self):
        self.stage_server()
        self.report(self.green(), state="0000000000000000")
        err = self.blocked(self.run_hook("git commit -m x"), "no-report")
        self.assertIn("state " + self.state(), err.split("\n")[0])
        self.assertIn("packages: server", err)
        self.assertIn("--packages server", err)

    def test_ac7_failing_gate(self):
        self.stage_server()
        self.report({"root:drift": 0, "server:unit": 0, "client:test": 1})
        err = self.blocked(self.run_hook("git commit -m x"), "gates-failed")
        self.assertIn("failing: client:test", err)

    def test_ac8_missing_test_gate(self):
        self.stage_server()
        self.report({"root:drift": 0, "server:typecheck": 0, "client:lint": 0})
        err = self.blocked(self.run_hook("git commit -m x"), "missing-test-gate")
        self.assertIn("missing: server:unit", err)
        self.assertIn("run: ./scripts/gates.sh --packages server", err)

    def test_null_exit_counts_as_missing_not_failing(self):
        self.stage_server()
        self.report({"root:drift": 0, "server:unit": None, "server:integration": None})
        err = self.blocked(self.run_hook("git commit -m x"), "missing-test-gate")
        self.assertIn("missing: server:unit · failing: none", err)
        self.report({"root:drift": None, "server:unit": 0})
        self.assertIn("missing: root:drift", self.blocked(self.run_hook("git commit -m x"), "missing-test-gate"))

    def test_ac9_green_report_allows_silently(self):
        self.stage_server()
        self.report({"root:drift": 0, "server:unit": 0, "server:integration": None})
        res = self.run_hook("git commit -m x")
        self.assertEqual((res.returncode, res.stdout, res.stderr), (0, "", ""))

    def test_paths_outside_packages_need_drift_only(self):
        self.write("scripts/x.py", "print(1)\n")
        self.git("add", "scripts/x.py")
        self.report({"root:drift": 0})
        self.assertEqual(self.run_hook("git commit -m x").returncode, 0)
        self.report({"root:drift": 0, "e2e:lint": 2})
        self.blocked(self.run_hook("git commit -m x"), "gates-failed")

    def test_each_package_needs_its_own_test_gate(self):
        self.stage_server()
        self.write("client/src/b.ts")
        self.git("add", "client/src/b.ts")
        self.report({"root:drift": 0, "server:unit": 0})
        err = self.blocked(self.run_hook("git commit -m x"), "missing-test-gate")
        self.assertIn("packages: server, client", err)
        self.assertIn("run: ./scripts/gates.sh --packages client", err)

    def test_ac10_block_format(self):
        self.stage_server()
        err = self.blocked(self.run_hook("git commit -m x"), "no-report")
        lines = err.rstrip("\n").split("\n")
        self.assertEqual(len(lines), 4)
        self.assertTrue(lines[0].startswith("commit-gate: BLOCKED ("))
        self.assertTrue(lines[1].startswith("packages: "))
        self.assertTrue(lines[2].startswith("missing: ") and " · failing: " in lines[2])
        self.assertTrue(lines[3].startswith("run: ./scripts/gates.sh"))
        self.assertTrue(lines[3].endswith("then retry the commit. Do not bypass this gate."))
        self.assertLessEqual(len(err), 1200)

    def test_ac10_long_lists_are_truncated(self):
        mod = RepoCase.load_module(self)
        ids = ["pkg-%d:gate" % i for i in range(400)]
        msg = mod.format_block("gates-failed", None, ids, ids, ids, ids)
        self.assertLessEqual(len(msg), 1200)
        self.assertIn("…", msg)
        self.assertIn("state unknown", msg.split("\n")[0])

    def test_ac12_corrupt_or_malformed_reports_block_as_internal_error(self):
        self.stage_server()
        state = self.state()
        for raw in ["{not json", json.dumps({"state": state}), json.dumps({"gates": []}),
                    json.dumps({"gates": {"root:drift": {"exit": "0"}}}),
                    json.dumps({"gates": {"root:drift": {"exit": True}}}),
                    json.dumps({"gates": {"root:drift": 3}})]:
            with self.subTest(raw=raw):
                self.report({}, raw=raw)
                err = self.blocked(self.run_hook("git commit -m x"), "internal-error")
                self.assertIn("state " + state, err.split("\n")[0])

    def test_missing_gates_py_is_an_internal_error(self):
        self.stage_server()
        os.remove(os.path.join(self.repo, "scripts", "gates.py"))
        self.blocked(self.run_hook("git commit -m x"), "internal-error")

    def test_ac12_errors_on_non_commits_allow(self):
        res = self.run_hook("ls -la")
        self.assertEqual((res.returncode, res.stdout, res.stderr), (0, "", ""))
        bad = subprocess.run([sys.executable, self.hook], input="{", env=self.env, capture_output=True, text=True)
        self.assertEqual((bad.returncode, bad.stdout), (0, ""))

    def test_ac16_partial_staging_uses_the_whole_tree_state(self):
        self.write("server/src/a.ts")
        self.write("server/src/c.ts")
        self.git("add", "server/src/a.ts")
        self.report({"root:drift": 0, "server:unit": 0})
        self.assertEqual(self.run_hook("git commit -m x").returncode, 0)

    def test_ac17_worktree_is_judged_by_its_own_report(self):
        wt = os.path.join(self.tmp, "wt")
        self.git("worktree", "add", "-q", wt, "-b", "wt")
        self.write("server/src/a.ts", root=wt)
        self.git("add", "server/src/a.ts", cwd=wt)
        self.blocked(self.run_hook("git commit -m x", cwd=wt), "no-report")
        self.report(self.green("root:drift", "server:unit"), root=wt)
        self.assertEqual(self.run_hook("git commit -m x", cwd=wt).returncode, 0)
        self.assertFalse(os.path.exists(os.path.join(self.repo, ".devdigest", "gates")))

    def test_ac17_unrelated_repo_is_allowed(self):
        other = os.path.join(self.tmp, "other")
        os.makedirs(other)
        self.git("init", "-q", "-b", "main", cwd=other)
        self.write("server/src/a.ts", root=other)
        self.git("add", "-A", cwd=other)
        res = self.run_hook("git commit -m x", cwd=other)
        self.assertEqual((res.returncode, res.stdout, res.stderr), (0, "", ""))
        res = self.run_hook("git commit -m x", cwd=self.tmp)  # not a repository at all
        self.assertEqual(res.returncode, 0)

    def test_ac18_merge_commit_is_gated(self):
        self.git("checkout", "-q", "-b", "feat")
        self.write("server/src/a.ts")
        self.git("commit", "-q", "-am", "feat")
        self.git("checkout", "-q", "main")
        self.write("client/src/b.ts", "export const w = 9;\n")
        self.git("commit", "-q", "-am", "main")
        self.git("merge", "-q", "--no-commit", "--no-ff", "feat")
        self.blocked(self.run_hook("git commit --no-edit"), "no-report")

    def test_commit_tree_is_never_docs_only(self):
        self.git("rm", "-q", "-r", "--cached", "server", "client")
        self.git("commit", "-q", "-m", "docs only tree")
        err = self.blocked(self.run_hook("git commit-tree HEAD^{tree}"), "no-report")
        self.assertIn("missing: root:drift", err)

    def test_ac22_command_text_is_inert_and_decision_is_stable(self):
        self.stage_server()
        pwn = os.path.join(self.tmp, "pwn")
        runs = [self.run_hook('git commit -m "$(touch %s)"' % pwn) for _ in range(3)]
        self.assertFalse(os.path.exists(pwn))
        self.assertEqual({(r.returncode, r.stderr, r.stdout) for r in runs}, {(2, runs[0].stderr, "")})
        self.assertEqual(runs[0].returncode, 2)


# ---------------------------------------------------------------------------- S3


class TestLogAndBypass(RepoCase):
    def test_ac11_env_bypass_vs_command_text(self):
        self.stage_server()
        res = self.run_hook("git commit -m x", extra_env={"DEVDIGEST_COMMIT_GATE": "off"})
        self.assertEqual((res.returncode, res.stdout, res.stderr), (0, "", ""))
        lines = self.log_lines()
        self.assertEqual([(e["decision"], e["reason"]) for e in lines], [("bypassed", "env-off")])
        self.assertEqual(lines[0]["packages"], ["server"])
        self.assertEqual(lines[0]["state"], self.state())
        res = self.run_hook("DEVDIGEST_COMMIT_GATE=off git commit -m x")
        self.assertEqual(res.returncode, 2)
        res = self.run_hook("git commit -m x", extra_env={"DEVDIGEST_COMMIT_GATE": "OFF"})
        self.assertEqual(res.returncode, 2)

    def test_bypass_only_logs_gated_commits(self):
        self.write("README.md", "# d\n")
        self.git("add", "README.md")
        res = self.run_hook("git commit -m x", extra_env={"DEVDIGEST_COMMIT_GATE": "off"})
        self.assertEqual(res.returncode, 0)
        self.assertEqual(self.log_lines(), [])

    def test_bypass_survives_errors(self):
        self.stage_server()
        os.remove(os.path.join(self.repo, "scripts", "gates.py"))
        res = self.run_hook("git commit -m x", extra_env={"DEVDIGEST_COMMIT_GATE": "off"})
        self.assertEqual(res.returncode, 0)
        self.assertEqual(self.log_lines()[0]["state"], None)

    def _fresh_repo_with_staged_server(self):
        fresh = os.path.join(self.tmp, "fresh")
        os.makedirs(os.path.join(fresh, ".claude", "hooks"))
        os.makedirs(os.path.join(fresh, "scripts"))
        shutil.copy(HOOK_SRC, os.path.join(fresh, ".claude", "hooks", "commit-gate.py"))
        shutil.copy(GATES_SRC, os.path.join(fresh, "scripts", "gates.py"))
        self.git("init", "-q", "-b", "main", cwd=fresh)
        self.write("server/src/a.ts", root=fresh)
        self.git("add", "server/src/a.ts", cwd=fresh)
        self.hook = os.path.join(fresh, ".claude", "hooks", "commit-gate.py")
        return fresh

    def test_bypass_survives_path_set_errors(self):
        # no commits: `git diff HEAD -- <pathspec>` fails, but the hatch is off, so the commit passes
        fresh = self._fresh_repo_with_staged_server()
        for command in ("git commit -m x server/src/a.ts", 'git commit -m "unterminated'):
            with self.subTest(command=command):
                res = self.run_hook(command, cwd=fresh, extra_env={"DEVDIGEST_COMMIT_GATE": "off"})
                self.assertEqual((res.returncode, res.stdout, res.stderr), (0, "", ""))
        lines = self.log_lines_in(fresh)
        self.assertTrue(lines)
        self.assertTrue(all(e["decision"] == "bypassed" and e["reason"].startswith("env-off") for e in lines))
        self.assertTrue(any("Error" in e["reason"] for e in lines))
        # the same commit with the hatch on is still blocked, not allowed
        self.assertEqual(self.run_hook("git commit -m x server/src/a.ts", cwd=fresh).returncode, 2)

    def test_bypass_survives_git_error_and_timeout(self):
        self.stage_server()
        mod = self.load_module()
        for exc in (mod.GitError("boom"), subprocess.TimeoutExpired("git", 1)):
            with self.subTest(exc=type(exc).__name__), mock.patch.object(mod, "repo_of", side_effect=exc), \
                    mock.patch.dict(os.environ, {"DEVDIGEST_COMMIT_GATE": "off"}):
                rc, _, err = self.run_main(mod, self.payload("git commit -m x"))
                self.assertEqual((rc, err), (0, ""))
        self.assertEqual([e["decision"] for e in self.log_lines()], ["bypassed", "bypassed"])
        with mock.patch.object(mod, "repo_of", side_effect=mod.GitError("boom")):
            rc, _, _ = self.run_main(mod, self.payload("git commit -m x"))
        self.assertEqual(rc, 2)

    def test_ac13_log_line_fields_truncation_and_ignore(self):
        self.stage_server()
        command = 'git commit -m "%s"' % ("x" * 2000)
        res = self.run_hook(command, extra_env={"SECRET_TOKEN": "hunter2"}, agent_type="implementer")
        self.assertEqual(res.returncode, 2)
        with open(os.path.join(self.repo, LOG_REL)) as f:
            raw = f.read()
        self.assertNotIn("hunter2", raw)
        (entry,) = self.log_lines()
        self.assertEqual(set(entry), {"ts", "session_id", "agent_type", "decision", "reason", "state",
                                      "packages", "missing", "failing", "command"})
        self.assertEqual(len(entry["command"]), 500)
        self.assertEqual(entry["command"], command[:500])
        self.assertEqual((entry["decision"], entry["reason"], entry["agent_type"], entry["session_id"]),
                         ("blocked", "no-report", "implementer", "sess-1"))
        self.assertEqual(entry["state"], self.state())
        self.assertRegex(entry["ts"], r"^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d[+-]\d\d:\d\d$")
        self.git("check-ignore", "-q", LOG_REL)

    def test_main_agent_has_null_agent_type(self):
        self.stage_server()
        self.run_hook("git commit -m x")
        self.assertIsNone(self.log_lines()[0]["agent_type"])

    def test_logging_does_not_change_the_state(self):
        self.stage_server()
        before = self.state()
        self.run_hook("git commit -m x")
        self.assertTrue(self.log_lines())
        self.assertEqual(self.state(), before)

    def test_ac19_three_blocks_three_lines(self):
        self.stage_server()
        for _ in range(3):
            self.assertEqual(self.run_hook("git commit -m x").returncode, 2)
        self.assertEqual([e["decision"] for e in self.log_lines()], ["blocked"] * 3)

    def test_internal_errors_are_logged(self):
        self.stage_server()
        self.report({}, raw="{")
        self.assertEqual(self.run_hook("git commit -m x").returncode, 2)
        entry = self.log_lines()[-1]
        self.assertEqual(entry["decision"], "internal-error")
        self.assertTrue(entry["reason"].startswith("ReportError"))
        mod = self.load_module()
        with mock.patch.object(mod, "find_commits", side_effect=RuntimeError("boom")):
            rc, _, _ = self.run_main(mod, self.payload("git status"))
        self.assertEqual(rc, 0)
        entry = self.log_lines()[-1]
        self.assertEqual((entry["decision"], entry["reason"]), ("internal-error", "allowed: RuntimeError"))

    def test_log_failure_never_breaks_the_hook(self):
        self.stage_server()
        os.makedirs(os.path.join(self.repo, ".devdigest"), exist_ok=True)
        open(os.path.join(self.repo, ".devdigest", "commit-gate"), "w").close()  # a file where the dir should be
        self.assertEqual(self.run_hook("git commit -m x").returncode, 2)


# ---------------------------------------------------------------------------- S5


class TestRegistration(unittest.TestCase):
    def settings(self):
        with open(os.path.join(REAL_ROOT, ".claude", "settings.json")) as f:
            return json.load(f)

    def test_ac1_one_pre_tool_use_command_hook_on_bash(self):
        pre = self.settings()["hooks"]["PreToolUse"]
        self.assertEqual(len(pre), 1)
        self.assertEqual(pre[0]["matcher"], "Bash")
        self.assertEqual(pre[0]["hooks"], [{
            "type": "command",
            "command": 'python3 "$CLAUDE_PROJECT_DIR/.claude/hooks/commit-gate.py"',
            "timeout": 10,
        }])
        self.assertNotIn("if", pre[0])

    def test_ac1_other_keys_equal_head(self):
        res = subprocess.run(["git", "-C", REAL_ROOT, "show", "HEAD:.claude/settings.json"],
                             capture_output=True, text=True, check=False)
        if res.returncode != 0:
            self.skipTest("no HEAD copy of settings.json")
        head = json.loads(res.stdout)
        now = self.settings()
        if "PreToolUse" in head.get("hooks", {}):
            self.skipTest("registration already committed: HEAD is the baseline no more")
        now["hooks"].pop("PreToolUse")
        self.assertEqual(now, head)

    def test_hook_has_no_shell_or_eval(self):
        with open(HOOK_SRC) as f:
            src = f.read()
        for banned in ("shell=True", "os.system", "eval(", "exec("):
            self.assertNotIn(banned, src)


if __name__ == "__main__":
    unittest.main(verbosity=2)
