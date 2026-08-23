// IT-03 extension: N worker connections race the initial IDLE-row compare-and-set. Expired claims
// need more than that SQL statement, so a separate worker-backed test below calls the complete
// production recovery decision while another SQLite connection observes the same row.
import { describe, expect, it } from "vitest";
import { Worker } from "node:worker_threads";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { openDatabase } from "../../src/store/db.js";
import * as entries from "../../src/store/entries.js";
import * as attempts from "../../src/store/attempts.js";
import * as plans from "../../src/store/plans.js";
import type { DeletedTimeEntry } from "../../src/domain/entry.js";
import { ingestEntry, seedInstallation } from "../support/installation-fixture.js";

const WORKER_PATH = fileURLToPath(new URL("./workers/claim-worker.mjs", import.meta.url));
const WORKSPACE_ID = "ws-1";
const ADDON_ID = "addon-install-1";
const SCOPE = { workspaceId: WORKSPACE_ID, addonId: ADDON_ID };
const N_WORKERS = 8;

const SOURCE: DeletedTimeEntry = {
  workspaceId: WORKSPACE_ID,
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

interface WorkerResult {
  readonly ok: boolean;
  readonly claimed?: boolean;
  readonly claimToken: string;
  readonly wonToken?: string | null;
  readonly error?: string;
  readonly phase?: "before" | "after";
  readonly lifecycleState?: string;
  readonly attemptOutcome?: string | null;
}

function runWorker(dbPath: string, entryId: string, claimToken: string, nowIso: string): Promise<WorkerResult> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(WORKER_PATH, {
      workerData: { mode: "claim-idle", dbPath, entryId, scope: SCOPE, claimToken, nowIso },
    });
    worker.once("message", (msg: WorkerResult) => {
      resolve(msg);
      void worker.terminate();
    });
    worker.once("error", reject);
  });
}

function nextWorkerMessage(worker: Worker): Promise<WorkerResult> {
  return new Promise((resolve, reject) => {
    worker.once("message", resolve);
    worker.once("error", reject);
  });
}

describe("IT-03 concurrent recreate claims under real process-level parallelism", () => {
  it(`${N_WORKERS} worker threads race for one row on one shared DB file; exactly one wins`, async () => {
    const dir = mkdtempSync(join(tmpdir(), "restoretime-concurrency-"));
    const dbPath = join(dir, "restoretime.sqlite");
    try {
      // Main thread creates and migrates the file first (worker connections never race the schema
      // creation itself — only the row claim, which is the invariant under test).
      const db = openDatabase(dbPath);
      seedInstallation(db, SCOPE);
      const { entry } = ingestEntry(db, {
        id: "re-1",
        scope: SCOPE,
        sourceEntryId: "entry-a",
        ownerId: "user-1",
        detectedAt: "2026-08-08T09:00:00Z",
        source: SOURCE,
      });
      db.close(); // no lingering main-thread connection while the workers race

      const now = new Date("2026-08-08T09:01:00Z").toISOString();
      const tokens = Array.from({ length: N_WORKERS }, () => randomUUID());

      const results = await Promise.all(tokens.map((token) => runWorker(dbPath, entry.id, token, now)));

      // Every worker completed cleanly — a losing attempt is a well-formed "did not claim" result,
      // never a thrown error (the busy-timeout in the worker is what makes this true; see the
      // worker file's comment).
      for (const r of results) {
        expect(r.ok).toBe(true);
        expect(r.error).toBeUndefined();
      }

      const winners = results.filter((r) => r.claimed === true);
      const losers = results.filter((r) => r.claimed === false);
      expect(winners).toHaveLength(1);
      expect(losers).toHaveLength(N_WORKERS - 1);

      // The row's final claim_token matches the single winner's own token (not a loser's, and not
      // some interleaved partial write) — the CAS actually serialized the race, it did not just
      // report "not claimed" while secretly corrupting the row.
      const verifyDb = openDatabase(dbPath);
      seedInstallation(verifyDb, SCOPE);
      const row = entries.getById(verifyDb, SCOPE, entry.id);
      expect(row?.lifecycleState).toBe("RECREATING");
      expect(row?.claimToken).toBe(winners[0]?.claimToken);
      verifyDb.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("the complete production decision recovers an expired started attempt with a second connection open", async () => {
    const dir = mkdtempSync(join(tmpdir(), "restoretime-concurrency-started-"));
    const dbPath = join(dir, "restoretime.sqlite");
    try {
      const db = openDatabase(dbPath);
      seedInstallation(db, SCOPE);
      const { entry } = ingestEntry(db, {
        id: "re-started",
        scope: SCOPE,
        sourceEntryId: "entry-started",
        ownerId: "user-1",
        detectedAt: "2026-08-08T09:00:00Z",
        source: { ...SOURCE, entryId: "entry-started" },
      });
      plans.createActive(db, {
        id: "plan-started",
        recoverableEntryId: entry.id,
        createdBy: "user-1",
        createdAt: "2026-08-08T09:00:00Z",
        sourceHash: "hash",
        choices: {},
        resolution: [],
        presentation: { project: null, task: null, tags: [], customFields: [], editable: [] },
        plannedRequest: {
          workspaceId: WORKSPACE_ID,
          userId: "user-1",
          start: "2026-08-08T10:00:00Z",
          end: "2026-08-08T11:00:00Z",
        },
        warnings: [],
        blockers: [],
        actionRequired: [],
        fidelity: "FULL",
      });
      entries.claim(db, {
        id: entry.id,
        scope: SCOPE,
        claimToken: "started-attempt",
        now: new Date("2026-08-08T09:00:00Z"),
      });
      expect(attempts.startForClaim(db, {
        id: "started-attempt",
        planId: "plan-started",
        recoverableEntryId: entry.id,
        startedAt: "2026-08-08T09:00:01Z",
        leaseExpiresAt: "2026-08-08T09:01:01Z",
        baseline: [],
      })).toBe(true);
      db.close();

      const observer = new Worker(WORKER_PATH, {
        workerData: {
          mode: "observe-started-attempt",
          dbPath,
          entryId: entry.id,
          scope: SCOPE,
          attemptId: "started-attempt",
        },
      });
      try {
        const before = await nextWorkerMessage(observer);
        expect(before).toMatchObject({
          ok: true,
          phase: "before",
          lifecycleState: "RECREATING",
          wonToken: "started-attempt",
          attemptOutcome: null,
        });

        const recoveryDb = openDatabase(dbPath);

        seedInstallation(recoveryDb, SCOPE);
        const retry = entries.claim(recoveryDb, {
          id: entry.id,
          scope: SCOPE,
          claimToken: "forbidden-reclaim",
          now: new Date("2026-08-08T09:01:01Z"),
        });
        expect(retry).toBeUndefined();
        expect(entries.getById(recoveryDb, SCOPE, entry.id)).toMatchObject({
          lifecycleState: "AMBIGUOUS",
          claimToken: null,
        });
        expect(attempts.getById(recoveryDb, "started-attempt")?.outcome).toBe("AMBIGUOUS");
        recoveryDb.close();

        const afterMessage = nextWorkerMessage(observer);
        observer.postMessage("read-after");
        const after = await afterMessage;
        expect(after).toMatchObject({
          ok: true,
          phase: "after",
          lifecycleState: "AMBIGUOUS",
          wonToken: null,
          attemptOutcome: "AMBIGUOUS",
        });
      } finally {
        await observer.terminate();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
