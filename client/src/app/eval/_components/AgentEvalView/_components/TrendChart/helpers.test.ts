import { describe, it, expect } from "vitest";
import { makeRun } from "@/test/eval-fixtures";
import { lineSegments, metricPoints, toPolyline, xOf, yOf } from "./helpers";

describe("trend chart geometry", () => {
  it("puts 100 % at the top, 0 % at the bottom and a lone run in the middle", () => {
    expect(yOf(1)).toBeLessThan(yOf(0));
    expect(xOf(0, 1)).toBeGreaterThan(xOf(0, 2));
    expect(xOf(0, 3)).toBeLessThan(xOf(1, 3));
    expect(xOf(1, 3)).toBeLessThan(xOf(2, 3));
  });

  it("leaves a gap for an undefined metric and draws no line for a single point", () => {
    const runs = [makeRun({ id: "a", recall: 0.5 }), makeRun({ id: "b", recall: null }), makeRun({ id: "c", recall: 0.75 }), makeRun({ id: "d", recall: 1 })];
    expect(metricPoints(runs, "recall").map((p) => p.run.id)).toEqual(["a", "c", "d"]);
    const lines = lineSegments(runs, "recall");
    expect(lines).toHaveLength(1);
    expect(lines[0]!.map((p) => p.percent)).toEqual([75, 100]);
    expect(toPolyline(lines[0]!).split(" ")).toHaveLength(2);
  });
});
