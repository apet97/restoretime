import { describe, expect, it } from "vitest";
import { looselyEqual } from "../../src/domain/values.js";

describe("looselyEqual", () => {
  it("treats numeric strings and numbers as equal", () => {
    expect(looselyEqual("1", 1)).toBe(true);
  });

  it("compares object and array structure without scalar coercion", () => {
    expect(looselyEqual({ enabled: true }, { enabled: true })).toBe(true);
    expect(looselyEqual(["a", "b"], ["b", "a"])).toBe(false);
  });

  it("uses string equality for non-numeric scalar values", () => {
    expect(looselyEqual(true, "true")).toBe(true);
    expect(looselyEqual("yes", "no")).toBe(false);
  });
});
