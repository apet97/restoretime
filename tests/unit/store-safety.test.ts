import { describe, expect, it } from "vitest";
import { openDatabase } from "../../src/store/db.js";
import * as attempts from "../../src/store/attempts.js";
import * as entries from "../../src/store/entries.js";
import * as plans from "../../src/store/plans.js";
import type { DeletedTimeEntry } from "../../src/domain/entry.js";
import { insertAttemptFixture } from "../support/attempt-fixture.js";

const SOURCE: DeletedTimeEntry = {
  workspaceId: "ws-1",
  entryId: "source-1",
  ownerId: "user-1",
  ownerName: "User One",
  description: "safety",
  billable: false,
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

function newPlan(id: string, recoverableEntryId: string, createdAt = "2026-08-08T09:00:00Z") {
  return {
    id,
    recoverableEntryId,
    createdBy: "user-1",
    createdAt,
    sourceHash: "hash",
    choices: {},
    resolution: [],
    plannedRequest: {
      workspaceId: "ws-1",
      userId: "user-1",
      start: SOURCE.start,
      end: SOURCE.end!,
    },
    presentation: { project: null, task: null, tags: [], customFields: [], editable: [] },
    warnings: [],
    blockers: [],
    actionRequired: [],
    fidelity: "FULL" as const,
  };
}

function seedAmbiguous() {
  const db = openDatabase(":memory:");
  const entry = entries.ingestDeletedEntry(db, {
    id: "entry-1",
    workspaceId: "ws-1",
    sourceEntryId: SOURCE.entryId,
    ownerId: SOURCE.ownerId,
    detectedAt: "2026-08-08T09:00:00Z",
    source: SOURCE,
  }).entry;
  plans.createActive(db, newPlan("plan-1", entry.id));
  insertAttemptFixture(db, {
    id: "attempt-1",
    planId: "plan-1",
    recoverableEntryId: entry.id,
    startedAt: "2026-08-08T09:00:01Z",
    baseline: ["private-baseline"],
  });
  db.prepare("UPDATE recoverable_entries SET lifecycle_state='AMBIGUOUS' WHERE id=?").run(entry.id);
  return { db, entry };
}

describe("reconcile run fencing", () => {
  it("blocks a second and backward-clock run, permits takeover at 30 seconds, and rejects stale completion and adoption", () => {
    const { db, entry } = seedAmbiguous();
    const prior = {
      checkedAt: "2026-08-08T08:00:00Z",
      firstEligibleCheckAt: "2026-08-08T07:50:00Z",
      checks: 3,
      matchCount: 0,
      candidateIds: [],
      truncated: false,
    };
    attempts.updateReconcile(db, "attempt-1", prior);

    const begin = (checkedAt: string, runId: string) => attempts.beginReconcile(db, {
      recoverableEntryId: entry.id,
      workspaceId: "ws-1",
      expectedAttemptId: "attempt-1",
      checkedAt,
      runId,
      throttleMs: 30_000,
    });
    expect(begin("2026-08-08T09:00:00Z", "run-a")).toEqual({ kind: "started", prior });
    expect(begin("2026-08-08T08:59:59Z", "clock-rollback")).toEqual({ kind: "throttled" });
    expect(begin("2026-08-08T09:00:29.999Z", "too-early")).toEqual({ kind: "throttled" });
    expect(begin("2026-08-08T09:00:30Z", "run-b")).toEqual({ kind: "started", prior });

    expect(attempts.completeReconcile(db, {
      id: "attempt-1",
      runId: "run-a",
      checkedAt: "2026-08-08T09:00:31Z",
      countCheck: true,
      matchCount: 0,
      candidateIds: [],
      truncated: false,
    })).toBe(false);
    expect(entries.adopt(db, {
      id: entry.id,
      workspaceId: "ws-1",
      expectedAttemptId: "attempt-1",
      expectedReconcileRunId: "run-a",
      newEntryId: "stale-candidate",
      recreatedAt: "2026-08-08T09:00:31Z",
      recreatedBy: "user-1",
      diffs: [],
    })).toBeUndefined();
    expect(entries.getById(db, "ws-1", entry.id)?.lifecycleState).toBe("AMBIGUOUS");
    expect(attempts.cancelReconcile(db, "attempt-1", "run-a")).toBe(false);
    expect(attempts.cancelReconcile(db, "attempt-1", "run-b")).toBe(true);
    expect(attempts.getById(db, "attempt-1")?.reconcile).toEqual(prior);

    expect(begin("2026-08-08T09:00:31Z", "retry-now")).toEqual({ kind: "started", prior });
    db.close();
  });

  it("a failed first read restores NULL and permits an immediate retry", () => {
    const { db, entry } = seedAmbiguous();
    const input = {
      recoverableEntryId: entry.id,
      workspaceId: "ws-1",
      expectedAttemptId: "attempt-1",
      checkedAt: "2026-08-08T09:00:00Z",
      runId: "failed-read",
      throttleMs: 30_000,
    };
    expect(attempts.beginReconcile(db, input)).toEqual({ kind: "started", prior: null });
    expect(attempts.cancelReconcile(db, "attempt-1", "failed-read")).toBe(true);
    expect(attempts.getById(db, "attempt-1")?.reconcile).toBeNull();
    expect(attempts.beginReconcile(db, { ...input, runId: "immediate-retry" })).toEqual({ kind: "started", prior: null });
    db.close();
  });

  it("records a t0/t5/t10 evidence span and retains positive evidence across later zero and truncated reads", () => {
    const { db, entry } = seedAmbiguous();
    const complete = (
      runId: string,
      checkedAt: string,
      candidateIds: readonly string[],
      countCheck = true,
      truncated = false,
    ) => {
      expect(attempts.beginReconcile(db, {
        recoverableEntryId: entry.id,
        workspaceId: "ws-1",
        expectedAttemptId: "attempt-1",
        checkedAt,
        runId,
        throttleMs: 0,
      }).kind).toBe("started");
      expect(attempts.completeReconcile(db, {
        id: "attempt-1",
        runId,
        checkedAt,
        countCheck,
        matchCount: candidateIds.length,
        candidateIds,
        truncated,
      })).toBe(true);
    };
    complete("t0", "2026-08-08T09:00:00Z", ["candidate-positive"]);
    complete("t5", "2026-08-08T09:05:00Z", []);
    complete("t10", "2026-08-08T09:10:00Z", [], false, true);
    expect(attempts.getById(db, "attempt-1")?.reconcile).toEqual({
      checkedAt: "2026-08-08T09:10:00Z",
      firstEligibleCheckAt: "2026-08-08T09:00:00Z",
      checks: 2,
      matchCount: 0,
      candidateIds: ["candidate-positive"],
      truncated: true,
    });
    db.close();
  });

  it("counts complete zero-match checks at t0, t5, and t10 as one durable evidence span", () => {
    const { db, entry } = seedAmbiguous();
    for (const [runId, checkedAt] of [
      ["t0", "2026-08-08T09:00:00Z"],
      ["t5", "2026-08-08T09:05:00Z"],
      ["t10", "2026-08-08T09:10:00Z"],
    ] as const) {
      expect(attempts.beginReconcile(db, {
        recoverableEntryId: entry.id,
        workspaceId: "ws-1",
        expectedAttemptId: "attempt-1",
        checkedAt,
        runId,
        throttleMs: 0,
      }).kind).toBe("started");
      expect(attempts.completeReconcile(db, {
        id: "attempt-1",
        runId,
        checkedAt,
        countCheck: true,
        matchCount: 0,
        candidateIds: [],
        truncated: false,
      })).toBe(true);
    }
    expect(attempts.getById(db, "attempt-1")?.reconcile).toEqual({
      checkedAt: "2026-08-08T09:10:00Z",
      firstEligibleCheckAt: "2026-08-08T09:00:00Z",
      checks: 3,
      matchCount: 0,
      candidateIds: [],
      truncated: false,
    });
    db.close();
  });

  it("uses row insertion order for the latest attempt, not client-controlled timestamps", () => {
    const { db, entry } = seedAmbiguous();
    insertAttemptFixture(db, {
      id: "attempt-2",
      planId: "plan-1",
      recoverableEntryId: entry.id,
      startedAt: "2020-01-01T00:00:00Z",
      baseline: [],
    });
    expect(attempts.latestForEntry(db, entry.id)?.id).toBe("attempt-2");
    expect(attempts.beginReconcile(db, {
      recoverableEntryId: entry.id,
      workspaceId: "ws-1",
      expectedAttemptId: "attempt-1",
      checkedAt: "2026-08-08T09:00:00Z",
      runId: "old-attempt",
      throttleMs: 0,
    })).toEqual({ kind: "changed" });
    db.close();
  });
});

describe("lease clock fencing", () => {
  it("a backward clock cannot take over an unexpired recreation claim", () => {
    const db = openDatabase(":memory:");
    const entry = entries.ingestDeletedEntry(db, {
      id: "entry-lease",
      workspaceId: "ws-1",
      sourceEntryId: SOURCE.entryId,
      ownerId: SOURCE.ownerId,
      detectedAt: "2026-08-08T09:00:00Z",
      source: SOURCE,
    }).entry;
    expect(entries.claim(db, {
      id: entry.id,
      workspaceId: "ws-1",
      claimToken: "owner",
      now: new Date("2026-08-08T09:00:00Z"),
    })?.claimToken).toBe("owner");
    expect(entries.claim(db, {
      id: entry.id,
      workspaceId: "ws-1",
      claimToken: "rollback-takeover",
      now: new Date("2026-08-08T08:59:00Z"),
    })).toBeUndefined();
    expect(entries.getById(db, "ws-1", entry.id)?.claimToken).toBe("owner");
    db.close();
  });

  it("a backward clock at attempt start cannot shorten the existing lease", () => {
    const db = openDatabase(":memory:");
    const entry = entries.ingestDeletedEntry(db, {
      id: "entry-renewal",
      workspaceId: "ws-1",
      sourceEntryId: SOURCE.entryId,
      ownerId: SOURCE.ownerId,
      detectedAt: "2026-08-08T09:00:00Z",
      source: SOURCE,
    }).entry;
    plans.createActive(db, newPlan("plan-renewal", entry.id));
    expect(entries.claim(db, {
      id: entry.id,
      workspaceId: "ws-1",
      claimToken: "attempt-renewal",
      now: new Date("2026-08-08T09:00:00Z"),
    })?.claimExpiresAt).toBe("2026-08-08T09:01:00.000Z");

    expect(attempts.startForClaim(db, {
      id: "attempt-renewal",
      planId: "plan-renewal",
      recoverableEntryId: entry.id,
      startedAt: "2026-08-08T08:59:30.000Z",
      leaseExpiresAt: "2026-08-08T09:00:30.000Z",
      baseline: [],
    })).toBe(true);
    expect(entries.getById(db, "ws-1", entry.id)?.claimExpiresAt).toBe("2026-08-08T09:01:00.000Z");
    db.close();
  });
});

describe("bounded recreation plan history", () => {
  it("keeps attempted stale plans and at most one unattempted stale plan", () => {
    const db = openDatabase(":memory:");
    const entry = entries.ingestDeletedEntry(db, {
      id: "entry-1",
      workspaceId: "ws-1",
      sourceEntryId: SOURCE.entryId,
      ownerId: SOURCE.ownerId,
      detectedAt: "2026-08-08T09:00:00Z",
      source: SOURCE,
    }).entry;
    plans.createActive(db, newPlan("plan-1", entry.id, "2026-08-08T09:05:00Z"));
    plans.createActive(db, newPlan("plan-2", entry.id, "2026-08-08T09:04:00Z"));
    insertAttemptFixture(db, {
      id: "attempt-plan-1",
      planId: "plan-1",
      recoverableEntryId: entry.id,
      startedAt: "2026-08-08T09:10:00Z",
      baseline: [],
    });
    plans.createActive(db, newPlan("plan-3", entry.id, "2026-08-08T09:03:00Z"));
    plans.createActive(db, newPlan("plan-4", entry.id, "2026-08-08T09:02:00Z"));

    expect(plans.listForEntry(db, entry.id).map(({ id, status }) => ({ id, status }))).toEqual([
      { id: "plan-4", status: "ACTIVE" },
      { id: "plan-3", status: "STALE" },
      { id: "plan-1", status: "STALE" },
    ]);
    expect(plans.getById(db, "plan-2")).toBeUndefined();
    expect(plans.getById(db, "plan-1")).toBeDefined();
    db.close();
  });

  it("prunes consumed plans without attempts and retains consumed plans referenced by attempts", () => {
    const db = openDatabase(":memory:");
    const entry = entries.ingestDeletedEntry(db, {
      id: "entry-consumed",
      workspaceId: "ws-1",
      sourceEntryId: SOURCE.entryId,
      ownerId: SOURCE.ownerId,
      detectedAt: "2026-08-08T09:00:00Z",
      source: SOURCE,
    }).entry;
    plans.createActive(db, newPlan("consumed-unattempted", entry.id));
    db.prepare("UPDATE recreation_plans SET status='CONSUMED' WHERE id=?").run("consumed-unattempted");
    plans.createActive(db, newPlan("consumed-attempted", entry.id));
    db.prepare("UPDATE recreation_plans SET status='CONSUMED' WHERE id=?").run("consumed-attempted");
    insertAttemptFixture(db, {
      id: "attempt-consumed",
      planId: "consumed-attempted",
      recoverableEntryId: entry.id,
      startedAt: "2026-08-08T09:01:00Z",
      baseline: [],
    });
    plans.createActive(db, newPlan("current", entry.id));

    expect(plans.getById(db, "consumed-unattempted")).toBeUndefined();
    expect(plans.getById(db, "consumed-attempted")?.status).toBe("CONSUMED");
    expect(plans.getById(db, "current")?.status).toBe("ACTIVE");
    db.close();
  });
});
