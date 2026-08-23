// IT-03, IT-12 (docs/13). Real SQLite temp file, exercising the atomic claim (docs/07 §6) and
// fenced result writes directly against src/store/entries.ts.
import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { openDatabase } from "../../src/store/db.js";
import * as entries from "../../src/store/entries.js";
import type { DeletedTimeEntry } from "../../src/domain/entry.js";
import { TEST_SCOPE, ingestEntry, seedInstallation } from "../support/installation-fixture.js";

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

let dir: string;

function freshDb() {
  dir = mkdtempSync(join(tmpdir(), "restoretime-claim-"));
  const db = openDatabase(join(dir, "restoretime.sqlite"));
  seedInstallation(db);
  return db;
}

afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

describe("IT-03 concurrent recreate claims", () => {
  it("exactly one of two parallel claim attempts wins; the loser sees the current state", async () => {
    const db = freshDb();
    const { entry } = ingestEntry(db, {
      id: "re-1",
      scope: TEST_SCOPE,
      sourceEntryId: "entry-a",
      ownerId: "user-1",
      detectedAt: "2026-08-08T09:00:00Z",
      source: SOURCE,
    });

    const now = new Date("2026-08-08T09:01:00Z");
    const tokenA = randomUUID();
    const tokenB = randomUUID();

    // Both "requests" race for the same row. better-sqlite3 serializes writes on one connection,
    // but the assertion that matters is the CAS invariant: at most one succeeds.
    const [resultA, resultB] = await Promise.all([
      Promise.resolve().then(() => entries.claim(db, { id: entry.id, scope: TEST_SCOPE, claimToken: tokenA, now })),
      Promise.resolve().then(() => entries.claim(db, { id: entry.id, scope: TEST_SCOPE, claimToken: tokenB, now })),
    ]);

    const winners = [resultA, resultB].filter((r) => r !== undefined);
    expect(winners).toHaveLength(1);

    const loser = resultA === undefined ? resultB : resultA;
    void loser; // the winner already proves the CAS; the loser's undefined result IS "current state" (0 rows)

    const current = entries.getById(db, TEST_SCOPE, entry.id);
    expect(current?.lifecycleState).toBe("RECREATING");
    expect(current?.claimToken).toBe(winners[0]?.claimToken);
  });
});

describe("IT-12 lease expiry and fenced writes", () => {
  it("an expired claim with no attempt row is reclaimable by a new claim", () => {
    const db = freshDb();
    const { entry } = ingestEntry(db, {
      id: "re-1",
      scope: TEST_SCOPE,
      sourceEntryId: "entry-a",
      ownerId: "user-1",
      detectedAt: "2026-08-08T09:00:00Z",
      source: SOURCE,
    });

    const staleToken = randomUUID();
    const firstClaim = entries.claim(db, {
      id: entry.id,
      scope: TEST_SCOPE,
      claimToken: staleToken,
      now: new Date("2026-08-08T09:00:00Z"),
    });
    expect(firstClaim).toBeDefined();

    // The process stops before it records an attempt. 61 seconds later (past the 60 s lease), a
    // fresh claim can win because no Clockify write could have started.
    const laterNow = new Date("2026-08-08T09:01:01Z");
    const freshToken = randomUUID();
    const reclaimed = entries.claim(db, {
      id: entry.id,
      scope: TEST_SCOPE,
      claimToken: freshToken,
      now: laterNow,
    });
    expect(reclaimed).toBeDefined();
    expect(reclaimed?.claimToken).toBe(freshToken);
    expect(reclaimed?.lifecycleState).toBe("RECREATING");
  });

  it("a claim attempt before the lease expires is rejected (still RECREATING under the winning token)", () => {
    const db = freshDb();
    const { entry } = ingestEntry(db, {
      id: "re-1",
      scope: TEST_SCOPE,
      sourceEntryId: "entry-a",
      ownerId: "user-1",
      detectedAt: "2026-08-08T09:00:00Z",
      source: SOURCE,
    });
    const winningToken = randomUUID();
    entries.claim(db, {
      id: entry.id,
      scope: TEST_SCOPE,
      claimToken: winningToken,
      now: new Date("2026-08-08T09:00:00Z"),
    });

    // 30 s later — still well inside the 60 s lease.
    const tooSoon = entries.claim(db, {
      id: entry.id,
      scope: TEST_SCOPE,
      claimToken: randomUUID(),
      now: new Date("2026-08-08T09:00:30Z"),
    });
    expect(tooSoon).toBeUndefined();
  });

  it("fenced writes reject a stale claim_token (a superseded attempt cannot report its result)", () => {
    const db = freshDb();
    const { entry } = ingestEntry(db, {
      id: "re-1",
      scope: TEST_SCOPE,
      sourceEntryId: "entry-a",
      ownerId: "user-1",
      detectedAt: "2026-08-08T09:00:00Z",
      source: SOURCE,
    });

    const staleToken = randomUUID();
    entries.claim(db, { id: entry.id, scope: TEST_SCOPE, claimToken: staleToken, now: new Date("2026-08-08T09:00:00Z") });
    // Lease expires; a new attempt reclaims with a fresh token.
    const freshToken = randomUUID();
    entries.claim(db, { id: entry.id, scope: TEST_SCOPE, claimToken: freshToken, now: new Date("2026-08-08T09:01:01Z") });

    // The original (stale) attempt finally wakes up and tries to report success — it must be
    // rejected: it no longer owns the row.
    const staleWrite = entries.setRecreated(db, {
      id: entry.id,
      scope: TEST_SCOPE,
      claimToken: staleToken,
      newEntryId: "new-entry-x",
      recreatedAt: "2026-08-08T09:02:00Z",
      recreatedBy: "user-1",
    });
    expect(staleWrite).toBeUndefined();

    // The fresh attempt's own write succeeds.
    const freshWrite = entries.setRecreated(db, {
      id: entry.id,
      scope: TEST_SCOPE,
      claimToken: freshToken,
      newEntryId: "new-entry-y",
      recreatedAt: "2026-08-08T09:02:01Z",
      recreatedBy: "user-1",
    });
    expect(freshWrite?.newEntryId).toBe("new-entry-y");
  });
});
