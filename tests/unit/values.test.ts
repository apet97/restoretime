import { describe, expect, it } from "vitest";
import { looselyEqual } from "../../src/domain/values.js";

describe("looselyEqual", () => {
  it("treats numeric strings and numbers as equal", () => {
    expect(looselyEqual("1", 1)).toBe(true);
    expect(looselyEqual(" 1 ", 1)).toBe(true);
  });

  it("keeps null-like values distinct from scalar strings", () => {
    expect(looselyEqual(null, "null")).toBe(false);
    expect(looselyEqual(undefined, "undefined")).toBe(false);
    expect(looselyEqual(null, undefined)).toBe(false);
    expect(looselyEqual(null, null)).toBe(true);
    expect(looselyEqual(undefined, undefined)).toBe(true);
  });

  it("does not coerce empty or whitespace strings to zero, and keeps non-finite string comparison", () => {
    expect(looselyEqual("", 0)).toBe(false);
    expect(looselyEqual("   ", 0)).toBe(false);
    expect(looselyEqual(NaN, NaN)).toBe(true);
    expect(looselyEqual(Infinity, Infinity)).toBe(true);
    expect(looselyEqual(-Infinity, -Infinity)).toBe(true);
  });

  it("keeps existing array order and object comparison behavior", () => {
    expect(looselyEqual({ enabled: true }, { enabled: true })).toBe(true);
    expect(looselyEqual({ first: 1, second: 2 }, { second: 2, first: 1 })).toBe(false);
    expect(looselyEqual(["a", "b"], ["b", "a"])).toBe(false);
  });

  it("uses string equality for non-numeric scalar values", () => {
    expect(looselyEqual(true, "true")).toBe(true);
    expect(looselyEqual("yes", "no")).toBe(false);
  });
});
