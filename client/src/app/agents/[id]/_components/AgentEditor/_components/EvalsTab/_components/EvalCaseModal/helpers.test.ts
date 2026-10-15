import { describe, it, expect } from "vitest";
import { ApiError } from "@/lib/api";
import { makeCase } from "@/test/eval-fixtures";
import { buildPatch, formValues, parseLine, saveErrorKey, validate } from "./helpers";

const c = makeCase(); // lines 10–12

describe("EvalCaseModal helpers", () => {
  it("formValues overlays the draft on the stored case", () => {
    expect(formValues(c, {})).toEqual({ name: "stripe-key-leak", notes: "", startLine: "10", endLine: "12" });
    expect(formValues(c, { name: "x", endLine: "20" })).toMatchObject({ name: "x", startLine: "10", endLine: "20" });
  });

  it("parseLine accepts positive whole numbers only", () => {
    expect([parseLine("3"), parseLine("0"), parseLine("-1"), parseLine("1.5"), parseLine(""), parseLine("x")]).toEqual([3, null, null, null, null, null]);
  });

  it("validate flags an empty/too long name, bad lines and an inverted range", () => {
    const ok = formValues(c, {});
    expect(validate(ok)).toEqual({ nameOk: true, linesOk: true, rangeInverted: false });
    expect(validate({ ...ok, name: "   " }).nameOk).toBe(false);
    expect(validate({ ...ok, name: "x".repeat(121) }).nameOk).toBe(false);
    expect(validate({ ...ok, startLine: "" })).toMatchObject({ linesOk: false, rangeInverted: false });
    expect(validate({ ...ok, startLine: "13" })).toMatchObject({ linesOk: false, rangeInverted: true });
  });

  it("buildPatch sends changed fields only, both lines together, and null for no change", () => {
    const base = formValues(c, {});
    expect(buildPatch(c, base)).toBeNull();
    expect(buildPatch(c, { ...base, name: "  new  " })).toEqual({ name: "new" });
    expect(buildPatch(c, { ...base, notes: "why" })).toEqual({ notes: "why" });
    expect(buildPatch(makeCase({ notes: "old" }), { ...base, notes: "  " })).toEqual({ notes: null });
    expect(buildPatch(c, { ...base, endLine: "15" })).toEqual({ start_line: 10, end_line: 15 });
  });

  it("saveErrorKey maps API errors", () => {
    expect(saveErrorKey(new ApiError("m", 422, "validation_error"))).toBe("validation");
    expect(saveErrorKey(new ApiError("m", 400, "validation_error"))).toBe("validation");
    expect(saveErrorKey(new ApiError("m", 404, "not_found"))).toBe("notFound");
    expect(saveErrorKey(new ApiError("m", 500))).toBe("generic");
    expect(saveErrorKey(new Error("x"))).toBe("generic");
  });
});
