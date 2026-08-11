// ADR-007 crash recovery. An unfinished attempt means that Clockify may already have accepted the
// create request. Lease expiry must make that uncertainty visible. It must never authorize a
// second create request.
import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClockifyClient } from "clockify-sdk-ts-115";
import { openDatabase } from "../../src/store/db.js";
import * as attempts from "../../src/store/attempts.js";
import { insertAttemptFixture } from "../support/attempt-fixture.js";
import * as entries from "../../src/store/entries.js";
import * as plans from "../../src/store/plans.js";
import { attemptRecreation } from "../../src/clockify/recreate.js";
import type { DeletedTimeEntry, PlannedRequest } from "../../src/domain/entry.js";

const WORKSPACE_ID = "ws-1";
const USER_ID = "user-1";

const SOURCE: DeletedTimeEntry = {
  workspaceId: WORKSPACE_ID,
  entryId: "source-entry-1",
  ownerId: USER_ID,
  ownerName: "User One",
  description: "crash recovery",
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

const PLANNED: PlannedRequest = {
  workspaceId: WORKSPACE_ID,
  userId: USER_ID,
  start: SOURCE.start,
  end: "2026-08-08T11:00:00Z",
  description: SOURCE.description,
  billable: SOURCE.billable,
};

const CREATED_ENTRY = {
  id: "created-entry",
  workspaceId: WORKSPACE_ID,
  userId: USER_ID,
  description: SOURCE.description,
  billable: false,
  tagIds: [],
  type: "REGULAR",
  timeInterval: { start: SOURCE.start, end: SOURCE.end },
};

function successfulClient(onCreate: () => void = () => undefined) {
  const fetchStub: typeof fetch = async (input, init) => {
    const request = input instanceof Request ? input : undefined;
    const url = new URL(request?.url ?? String(input));
    const method = (init?.method ?? request?.method ?? "GET").toUpperCase();
    if (method === "GET" && url.pathname.endsWith("/time-entries") && url.pathname.includes("/user/")) {
      return Response.json([]);
    }
    if (method === "POST" && url.pathname.endsWith("/time-entries")) {
      onCreate();
      return Response.json(CREATED_ENTRY, { status: 201 });
    }
    if (method === "GET" && url.pathname.endsWith(`/time-entries/${CREATED_ENTRY.id}`)) {
      return Response.json(CREATED_ENTRY);
    }
    return Response.json({ message: "unstubbed" }, { status: 404 });
  };
  return createClockifyClient({
    addonToken: "token",
    baseUrl: "https://developer.clockify.me/api/v1",
    timeoutInSeconds: 30,
    fetch: fetchStub,
  });
}

function runAttempt(
  db: ReturnType<typeof freshDb>,
  entryId: string,
  claimToken: string,
  client = successfulClient(),
) {
  return attemptRecreation({
    db,
    client,
    entryId,
    workspaceId: WORKSPACE_ID,
    planId: "plan-1",
    plannedRequest: PLANNED,
    claimToken,
    recreatedBy: USER_ID,
    now: new Date("2026-08-08T09:01:01Z"),
  });
}

let dir = "";

function freshDb() {
  dir = mkdtempSync(join(tmpdir(), "restoretime-ambiguous-write-"));
  return openDatabase(join(dir, "restoretime.sqlite"));
}

afterEach(() => {
  if (dir.length > 0) rmSync(dir, { recursive: true, force: true });
  dir = "";
});

function seed(db: ReturnType<typeof freshDb>) {
  const entry = entries.ingestDeletedEntry(db, {
    id: "recoverable-1",
    workspaceId: WORKSPACE_ID,
    sourceEntryId: SOURCE.entryId,
    ownerId: USER_ID,
    detectedAt: "2026-08-08T09:00:00Z",
    source: SOURCE,
  }).entry;
  plans.createActive(db, {
    id: "plan-1",
    recoverableEntryId: entry.id,
    createdBy: USER_ID,
    createdAt: "2026-08-08T09:00:30Z",
    sourceHash: "hash",
    choices: {},
    resolution: [],
    plannedRequest: PLANNED,
    warnings: [],
    blockers: [],
    actionRequired: [],
    fidelity: "FULL",
  });
  return entry;
}

describe("expired recreation attempts", () => {
  it("does not issue a second create when the first process crashed after it could send one", async () => {
    const db = freshDb();
    const entry = seed(db);
    const firstToken = "attempt-that-may-have-sent-create";
    entries.claim(db, {
      id: entry.id,
      workspaceId: WORKSPACE_ID,
      claimToken: firstToken,
      now: new Date("2026-08-08T09:01:00Z"),
    });
    insertAttemptFixture(db, {
      id: firstToken,
      planId: "plan-1",
      recoverableEntryId: entry.id,
      startedAt: "2026-08-08T09:01:01Z",
      baseline: [],
    });
    // The process can crash after the SDK sends the create and before it records an outcome. The
    // durable state is an expired RECREATING row plus this unfinished attempt.

    const secondToken = "attempt-that-must-not-send-create";
    const reclaimed = entries.claim(db, {
      id: entry.id,
      workspaceId: WORKSPACE_ID,
      claimToken: secondToken,
      now: new Date("2026-08-08T09:02:01Z"),
    });

    let createCalls = 0;
    if (reclaimed) {
      await runAttempt(db, entry.id, secondToken, successfulClient(() => createCalls += 1));
    }

    expect(reclaimed).toBeUndefined();
    expect(createCalls).toBe(0);
    expect(entries.getById(db, WORKSPACE_ID, entry.id)?.lifecycleState).toBe("AMBIGUOUS");
    expect(attempts.getById(db, firstToken)?.outcome).toBe("AMBIGUOUS");
    db.close();
  });

  it("can reclaim before an attempt exists and fences the old process before create", () => {
    const db = freshDb();
    const entry = seed(db);
    const firstToken = "expired-before-attempt";
    entries.claim(db, {
      id: entry.id,
      workspaceId: WORKSPACE_ID,
      claimToken: firstToken,
      now: new Date("2026-08-08T09:01:00Z"),
    });

    const secondToken = "current-claim";
    const reclaimed = entries.claim(db, {
      id: entry.id,
      workspaceId: WORKSPACE_ID,
      claimToken: secondToken,
      now: new Date("2026-08-08T09:02:01Z"),
    });
    expect(reclaimed?.claimToken).toBe(secondToken);

    expect(attempts.startForClaim(db, {
      id: firstToken,
      planId: "plan-1",
      recoverableEntryId: entry.id,
      startedAt: "2026-08-08T09:02:02Z",
      baseline: [],
    })).toBe(false);
    expect(attempts.startForClaim(db, {
      id: secondToken,
      planId: "plan-1",
      recoverableEntryId: entry.id,
      startedAt: "2026-08-08T09:02:02Z",
      baseline: [],
    })).toBe(true);
    db.close();
  });

  it("a lazy read recovery returns an expired claim with no attempt to IDLE", () => {
    const db = freshDb();
    const entry = seed(db);
    const staleToken = "expired-without-attempt";
    entries.claim(db, {
      id: entry.id,
      workspaceId: WORKSPACE_ID,
      claimToken: staleToken,
      now: new Date("2026-08-08T09:01:00Z"),
    });

    const recovered = entries.recoverExpiredClaim(db, {
      id: entry.id,
      workspaceId: WORKSPACE_ID,
      now: new Date("2026-08-08T09:02:01Z"),
    });

    expect(recovered).toMatchObject({
      lifecycleState: "IDLE",
      claimToken: null,
      claimExpiresAt: null,
    });
    expect(attempts.startForClaim(db, {
      id: staleToken,
      planId: "plan-1",
      recoverableEntryId: entry.id,
      startedAt: "2026-08-08T09:02:02Z",
      baseline: [],
    })).toBe(false);
    db.close();
  });

  it("projects a definitive stored SUCCESS when the old entry-state write was lost", () => {
    const db = freshDb();
    const entry = seed(db);
    const claimToken = "legacy-half-committed-success";
    entries.claim(db, {
      id: entry.id,
      workspaceId: WORKSPACE_ID,
      claimToken,
      now: new Date("2026-08-08T09:01:00Z"),
    });
    insertAttemptFixture(db, {
      id: claimToken,
      planId: "plan-1",
      recoverableEntryId: entry.id,
      startedAt: "2026-08-08T09:01:01Z",
      baseline: [],
    });
    attempts.finish(db, {
      id: claimToken,
      finishedAt: "2026-08-08T09:01:02Z",
      outcome: "SUCCESS",
      newEntryId: "definitively-created-entry",
      errorStatus: null,
      errorCode: null,
      errorMessage: null,
      diffs: [],
    });

    const retry = entries.claim(db, {
      id: entry.id,
      workspaceId: WORKSPACE_ID,
      claimToken: "forbidden-retry",
      now: new Date("2026-08-08T09:02:01Z"),
    });

    expect(retry).toBeUndefined();
    expect(entries.getById(db, WORKSPACE_ID, entry.id)).toMatchObject({
      lifecycleState: "RECREATED",
      newEntryId: "definitively-created-entry",
      recreatedAt: "2026-08-08T09:01:02Z",
      recreatedBy: USER_ID,
      claimToken: null,
    });
    expect(attempts.getById(db, claimToken)?.outcome).toBe("SUCCESS");
    db.close();
  });

  it("records adoption and the SUCCESS attempt in one state transition", () => {
    const db = freshDb();
    const entry = seed(db);
    const claimToken = "ambiguous-attempt";
    entries.claim(db, {
      id: entry.id,
      workspaceId: WORKSPACE_ID,
      claimToken,
      now: new Date("2026-08-08T09:01:00Z"),
    });
    insertAttemptFixture(db, {
      id: claimToken,
      planId: "plan-1",
      recoverableEntryId: entry.id,
      startedAt: "2026-08-08T09:01:01Z",
      baseline: [],
    });
    entries.setAmbiguous(db, { id: entry.id, workspaceId: WORKSPACE_ID, claimToken });

    const adopted = entries.adopt(db, {
      id: entry.id,
      workspaceId: WORKSPACE_ID,
      expectedAttemptId: claimToken,
      newEntryId: "adopted-entry",
      recreatedAt: "2026-08-08T09:03:00Z",
      recreatedBy: USER_ID,
      diffs: [{ field: "description", planned: "old", actual: "new" }],
    });

    expect(adopted?.lifecycleState).toBe("RECREATED");
    expect(attempts.getById(db, claimToken)).toMatchObject({
      outcome: "SUCCESS",
      newEntryId: "adopted-entry",
      finishedAt: "2026-08-08T09:03:00Z",
      diffs: [{ field: "description", planned: "old", actual: "new" }],
    });
    db.close();
  });

  it("rolls back a partial SUCCESS record and recovers it without a retry", async () => {
    const db = freshDb();
    const entry = seed(db);
    const claimToken = "database-failure-after-create";
    entries.claim(db, {
      id: entry.id,
      workspaceId: WORKSPACE_ID,
      claimToken,
      now: new Date("2026-08-08T09:01:00Z"),
    });
    db.exec(
      `CREATE TRIGGER reject_recreated_transition
       BEFORE UPDATE OF lifecycle_state ON recoverable_entries
       WHEN NEW.lifecycle_state='RECREATED'
       BEGIN SELECT RAISE(ABORT, 'injected entry-state failure'); END`,
    );

    let createCalls = 0;
    await expect(
      runAttempt(db, entry.id, claimToken, successfulClient(() => createCalls += 1)),
    ).rejects.toThrow("injected entry-state failure");

    expect(createCalls).toBe(1);
    expect(attempts.getById(db, claimToken)).toMatchObject({ outcome: null, finishedAt: null });
    expect(entries.getById(db, WORKSPACE_ID, entry.id)?.lifecycleState).toBe("RECREATING");

    const retry = entries.claim(db, {
      id: entry.id,
      workspaceId: WORKSPACE_ID,
      claimToken: "forbidden-retry",
      now: new Date("2026-08-08T09:02:01Z"),
    });
    expect(retry).toBeUndefined();
    expect(attempts.getById(db, claimToken)?.outcome).toBe("AMBIGUOUS");
    expect(entries.getById(db, WORKSPACE_ID, entry.id)?.lifecycleState).toBe("AMBIGUOUS");
    db.close();
  });
});
