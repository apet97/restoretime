// UT-P13 (docs/13, docs/07 §8): reconcile fingerprint collisions. Pure tests: no I/O.
import { describe, expect, it } from "vitest";
import {
  decideReconcile,
  diffPlannedVsActual,
  fingerprintFromPlanned,
  fingerprintMatches,
  matchCandidates,
} from "../../src/clockify/recreate.js";
import type { ClockifyApi } from "clockify-sdk-ts-115";
import type { PlannedRequest } from "../../src/domain/entry.js";

type TimeEntry = ClockifyApi.TimeEntry;

const PLANNED: PlannedRequest = {
  workspaceId: "ws-1",
  userId: "user-1",
  start: "2026-08-08T10:00:00Z",
  end: "2026-08-08T11:00:00Z",
  description: "hello",
  billable: true,
  projectId: "proj-1",
  tagIds: ["tag-1", "tag-2"],
};

function candidate(overrides: Partial<TimeEntry> = {}): TimeEntry {
  return {
    id: "cand-1",
    workspaceId: "ws-1",
    userId: "user-1",
    description: "hello",
    billable: true,
    isLocked: false,
    projectId: "proj-1",
    tagIds: ["tag-2", "tag-1"],
    type: "REGULAR",
    timeInterval: { start: "2026-08-08T10:00:00Z", end: "2026-08-08T11:00:00Z" },
    ...overrides,
  };
}

describe("UT-P13 fingerprint matching and reconcile decision", () => {
  it("an exact match on start/end/description/billable/project/tags (sorted) -> matches", () => {
    const fp = fingerprintFromPlanned(PLANNED);
    expect(fingerprintMatches(fp, candidate())).toBe(true);
  });

  it("a different description does not match", () => {
    const fp = fingerprintFromPlanned(PLANNED);
    expect(fingerprintMatches(fp, candidate({ description: "different" }))).toBe(false);
  });

  it("a different tag set does not match", () => {
    const fp = fingerprintFromPlanned(PLANNED);
    expect(fingerprintMatches(fp, candidate({ tagIds: ["tag-1"] }))).toBe(false);
  });

  it("accepts only the billable mismatch when P-BILL allows the known override", () => {
    const fp = fingerprintFromPlanned(PLANNED);
    const changedBillable = candidate({ billable: false });
    expect(fingerprintMatches(fp, changedBillable)).toBe(false);
    expect(fingerprintMatches(fp, changedBillable, true)).toBe(true);
    expect(fingerprintMatches(fp, candidate({ billable: false, description: "different" }), true)).toBe(false);
  });

  it("baseline-delta excludes entries already present before the create", () => {
    const fp = fingerprintFromPlanned(PLANNED);
    const baseline = ["cand-1"];
    const freshList = [candidate({ id: "cand-1" })];
    expect(matchCandidates(fp, baseline, freshList)).toHaveLength(0);
  });

  it("zero matches -> decideReconcile 'none'", () => {
    expect(decideReconcile([])).toEqual({ kind: "none" });
  });

  it("exactly one match -> decideReconcile 'one'", () => {
    expect(decideReconcile([candidate({ id: "cand-1" })])).toEqual({ kind: "one", id: "cand-1" });
  });

  it("two identical candidates (a manual copy inside the window) -> decideReconcile 'many', user picks", () => {
    const fp = fingerprintFromPlanned(PLANNED);
    const freshList = [candidate({ id: "cand-1" }), candidate({ id: "cand-2" })];
    const matches = matchCandidates(fp, [], freshList);
    expect(matches).toHaveLength(2);
    expect(decideReconcile(matches)).toEqual({ kind: "many", candidateIds: ["cand-1", "cand-2"] });
  });
});

describe("post-create verification diff (docs/07 §9)", () => {
  it("no diffs when the actual entry matches the plan exactly", () => {
    const diffs = diffPlannedVsActual(PLANNED, candidate());
    expect(diffs).toHaveLength(0);
  });

  it("reports a description mismatch", () => {
    const diffs = diffPlannedVsActual(PLANNED, candidate({ description: "server changed it" }));
    expect(diffs.some((d) => d.field === "description")).toBe(true);
  });

  it("reports a billable mismatch (expected under P-BILL, still recorded)", () => {
    const diffs = diffPlannedVsActual(PLANNED, candidate({ billable: false }));
    expect(diffs.some((d) => d.field === "billable")).toBe(true);
  });

  it("numeric-tolerant custom-field comparison: a stored numeric string equals a planned number", () => {
    const withCf: PlannedRequest = { ...PLANNED, customFields: [{ customFieldId: "cf-1", sourceType: "WORKSPACE", value: 777.5 }] };
    const actual = candidate({ customFieldValues: [{ customFieldId: "cf-1", value: "777.5" }] });
    const diffs = diffPlannedVsActual(withCf, actual);
    expect(diffs.some((d) => d.field.startsWith("customFields."))).toBe(false);
  });

  it("reports a custom-field difference between null and the string null", () => {
    const withCf: PlannedRequest = { ...PLANNED, customFields: [{ customFieldId: "cf-1", sourceType: "WORKSPACE", value: null }] };
    const actual = candidate({ customFieldValues: [{ customFieldId: "cf-1", value: "null" }] });
    expect(diffPlannedVsActual(withCf, actual)).toContainEqual({
      field: "customFields.cf-1",
      planned: null,
      actual: "null",
    });
  });

  it("a verification-read failure records the fallback note as an informational diff entry", () => {
    const diffs = diffPlannedVsActual(PLANNED, candidate(), "verification read unavailable");
    expect(diffs.some((d) => d.field === "_verification" && d.actual === "verification read unavailable")).toBe(true);
  });
});
