import { describe, it, expect } from "vitest";
import { agentEvalsHref, evalHref, resolveAgentId } from "./helpers";

describe("eval route helpers", () => {
  it("resolves ?agent= (missing, empty, repeated)", () => {
    expect(resolveAgentId(undefined)).toBeNull();
    expect(resolveAgentId("")).toBeNull();
    expect(resolveAgentId("ag1")).toBe("ag1");
    expect(resolveAgentId(["ag1", "ag2"])).toBe("ag1");
  });

  it("builds the dashboard and Evals-tab URLs", () => {
    expect(evalHref()).toBe("/eval");
    expect(evalHref("ag 1")).toBe("/eval?agent=ag+1");
    expect(agentEvalsHref("ag1")).toBe("/agents/ag1?tab=evals");
  });
});
