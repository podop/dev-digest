import { describe, it, expect } from "vitest";
import { visibleBody } from "./comments";

describe("visibleBody", () => {
  it("hides HTML comments like GitHub does, keeping the markdown", () => {
    expect(visibleBody("**bug**\n\nwhy\n\n<!-- devdigest-finding:f1 -->")).toBe("**bug**\n\nwhy");
    expect(visibleBody("a <!-- multi\nline --> b")).toBe("a  b");
    expect(visibleBody("plain")).toBe("plain");
  });
});
