// UT-S01, UT-S02 (docs/13): plan hash / staleness (ADR-006).
import { describe, expect, it } from "vitest";
import { isPlanUsable, outcomesDiffer, sourceHash } from "../../src/domain/plan.js";
import type { DeletedTimeEntry, RecreationPlan } from "../../src/domain/entry.js";

const SOURCE: DeletedTimeEntry = {
  workspaceId: "ws-1",
  entryId: "entry-a",
  ownerId: "user-1",
  ownerName: "User One",
  description: "d",
  billable: true,
  start: "2026-08-08T10:00:00Z",
  end: "2026-08-08T11:00:00Z",
  wasRunning: false,
  type: "REGULAR",
  timeZone: "UTC",
  projectId: null,
  projectName: null,
  clientName: null,
  taskId: null,
  taskName: null,
  tags: [],
  customFieldValues: [],
};

function plan(overrides: Partial<RecreationPlan> = {}): RecreationPlan {
  return {
    id: "plan-1",
    recoverableEntryId: "re-1",
    createdBy: "user-1",
    createdAt: "2026-08-08T09:00:00Z",
    sourceHash: sourceHash(SOURCE),
    choices: {},
    resolution: [],
    plannedRequest: { workspaceId: "ws-1", userId: "user-1", start: SOURCE.start },
    presentation: { project: null, task: null, tags: [], customFields: [], editable: [] },
    warnings: [],
    blockers: [],
    actionRequired: [],
    fidelity: "FULL",
    status: "ACTIVE",
    ...overrides,
  };
}

describe("UT-S01 plan sourceHash mismatch -> STALE", () => {
  it("is usable when ACTIVE and the hash matches the current source", () => {
    expect(isPlanUsable(plan(), sourceHash(SOURCE))).toBe(true);
  });

  it("is unusable when the current source hash differs (tamper/staleness)", () => {
    const differentSource: DeletedTimeEntry = { ...SOURCE, description: "changed" };
    expect(isPlanUsable(plan(), sourceHash(differentSource))).toBe(false);
  });

  it("is unusable when the plan is not ACTIVE, even with a matching hash", () => {
    expect(isPlanUsable(plan({ status: "STALE" }), sourceHash(SOURCE))).toBe(false);
    expect(isPlanUsable(plan({ status: "CONSUMED" }), sourceHash(SOURCE))).toBe(false);
  });

  it("the same source always hashes identically", () => {
    expect(sourceHash(SOURCE)).toBe(sourceHash({ ...SOURCE }));
  });
});

describe("UT-S02 revalidation detects changed dependency -> STALE", () => {
  const base = {
    plannedRequest: { workspaceId: "ws-1", userId: "user-1", start: SOURCE.start, projectId: "proj-1" },
    resolution: [{ kind: "project" as const, refId: "proj-1", outcome: "kept" as const }],
    presentation: {
      project: { id: "proj-1", name: "Project One", outcome: "kept" as const },
      task: null,
      tags: [],
      customFields: [],
      editable: [],
    },
    warnings: [],
    blockers: [],
    actionRequired: [],
  };

  it("no difference -> not stale", () => {
    expect(outcomesDiffer(base, { ...base })).toBe(false);
  });

  it("a changed plannedRequest (e.g. the project disappeared) -> stale", () => {
    const changed = { ...base, plannedRequest: { workspaceId: "ws-1", userId: "user-1", start: SOURCE.start } };
    expect(outcomesDiffer(base, changed)).toBe(true);
  });

  it("a changed blocker set (e.g. the owner became inactive) -> stale", () => {
    const changed = {
      ...base,
      blockers: [{ ruleId: "P-OWNER", code: "OWNER_UNAVAILABLE", message: "gone" }],
    };
    expect(outcomesDiffer(base, changed)).toBe(true);
  });

  it("a changed warning set -> stale", () => {
    const changed = {
      ...base,
      warnings: [{ ruleId: "P-PROJ-ARCH", code: "ARCHIVED_PROJECT", message: "archived now" }],
    };
    expect(outcomesDiffer(base, changed)).toBe(true);
  });

  it("a changed resolution -> stale", () => {
    const changed = {
      ...base,
      resolution: [{ kind: "project" as const, refId: "proj-1", outcome: "dropped" as const }],
    };
    expect(outcomesDiffer(base, changed)).toBe(true);
  });

  it("a changed action requirement -> stale", () => {
    const changed = {
      ...base,
      actionRequired: [{ ruleId: "P-PROJ-GONE", message: "Select a current project." }],
    };
    expect(outcomesDiffer(base, changed)).toBe(true);
  });

  it("persisted editable controls do not make unchanged values stale", () => {
    const changed = {
      ...base,
      presentation: {
        ...base.presentation,
        editable: [{ ruleId: "P-PROJ-GONE", message: "Select a project." }],
      },
    };
    expect(outcomesDiffer(base, changed)).toBe(false);
  });
});
