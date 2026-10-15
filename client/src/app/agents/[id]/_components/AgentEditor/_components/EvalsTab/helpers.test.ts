import { describe, it, expect } from "vitest";
import { makeCase, makeRun } from "@/test/eval-fixtures";
import { countPassing, dashboardHref, followedRunId, runningRun } from "./helpers";

describe("EvalsTab helpers", () => {
  it("countPassing counts cases whose last run passed", () => {
    const status = (s: "passed" | "failed" | "error") => ({ run_id: "r", status: s, ran_at: "2026-10-14T10:00:00.000Z" });
    const cases = [makeCase({ last_result: status("passed") }), makeCase({ last_result: status("failed") }), makeCase({ last_result: status("error") }), makeCase()];
    expect(countPassing(cases)).toBe(1);
    expect(countPassing([])).toBe(0);
  });

  it("dashboardHref targets the per-agent view", () => {
    expect(dashboardHref("ag 1")).toBe("/eval?agent=ag%201");
  });

  it("followedRunId prefers the running run of the list over the one just started", () => {
    const runs = [makeRun({ id: "a", status: "running" }), makeRun({ id: "b" })];
    expect(followedRunId(runs, "z")).toBe("a");
    expect(followedRunId([makeRun({ id: "b" })], "z")).toBe("z");
    expect(followedRunId(undefined, undefined)).toBeUndefined();
  });

  it("runningRun trusts the polled detail over the list", () => {
    const running = makeRun({ id: "a", status: "running", cases_finished: 2 });
    const finished = makeRun({ id: "a" });
    expect(runningRun(undefined, [running])).toBe(running);
    expect(runningRun({ run: finished, results: [] }, [running])).toBeNull();
    expect(runningRun(undefined, [finished])).toBeNull();
  });
});
