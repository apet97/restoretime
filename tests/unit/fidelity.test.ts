// UT-F01 (docs/13): fidelity classification matrix (docs/07 §10).
import { describe, expect, it } from "vitest";
import { classifyFidelity } from "../../src/domain/fidelity.js";

describe("UT-F01 fidelity classification matrix", () => {
  it("IMPOSSIBLE: any blocker present, regardless of the other flags", () => {
    expect(classifyFidelity({ hasBlockers: true, hasPartialLoss: false, hasAdjustment: false })).toBe("IMPOSSIBLE");
    expect(classifyFidelity({ hasBlockers: true, hasPartialLoss: true, hasAdjustment: true })).toBe("IMPOSSIBLE");
  });

  it("PARTIAL: no blockers, a source value cannot be represented", () => {
    expect(classifyFidelity({ hasBlockers: false, hasPartialLoss: true, hasAdjustment: false })).toBe("PARTIAL");
  });

  it("PARTIAL outranks ADJUSTED when both are present", () => {
    expect(classifyFidelity({ hasBlockers: false, hasPartialLoss: true, hasAdjustment: true })).toBe("PARTIAL");
  });

  it("ADJUSTED: no blockers, no partial loss, an explicit substitution/drop/input", () => {
    expect(classifyFidelity({ hasBlockers: false, hasPartialLoss: false, hasAdjustment: true })).toBe("ADJUSTED");
  });

  it("FULL: none of the above — including running->running recreation", () => {
    expect(classifyFidelity({ hasBlockers: false, hasPartialLoss: false, hasAdjustment: false })).toBe("FULL");
  });
});
