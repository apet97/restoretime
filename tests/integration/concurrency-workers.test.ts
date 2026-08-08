// IT-03 extension (docs/13): the same atomic-claim invariant `tests/integration/claim.test.ts`
// proves with concurrent promises in one process, proved again under REAL process-level
// parallelism — N `node:worker_threads` workers, each with its own SQLite connection, racing to
// claim the same row on one shared database file. Exactly one SUCCESS path.
import { describe, expect, it } from "vitest";
import { Worker } from "node:worker_threads";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { openDatabase } from "../../src/store/db.js";
import * as entries from "../../src/store/entries.js";
import type { DeletedTimeEntry } from "../../src/domain/entry.js";

const WORKER_PATH = fileURLToPath(new URL("./workers/claim-worker.mjs", import.meta.url));
const WORKSPACE_ID = "ws-1";
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
}

function runWorker(dbPath: string, entryId: string, claimToken: string, nowIso: string): Promise<WorkerResult> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(WORKER_PATH, {
      workerData: { dbPath, entryId, workspaceId: WORKSPACE_ID, claimToken, nowIso },
    });
    worker.once("message", (msg: WorkerResult) => {
      resolve(msg);
      void worker.terminate();
    });
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
      const { entry } = entries.ingestDeletedEntry(db, {
        id: "re-1",
        workspaceId: WORKSPACE_ID,
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
      const row = entries.getById(verifyDb, WORKSPACE_ID, entry.id);
      expect(row?.lifecycleState).toBe("RECREATING");
      expect(row?.claimToken).toBe(winners[0]?.claimToken);
      verifyDb.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// The worker must run the SAME predicate the app runs, or this drill re-proves a copy and would
// stay green after `claim()` lost its lease clause — which an adversarial review demonstrated by
// deleting the predicate and watching this file pass. The worker cannot import the TypeScript
// module (a `node:worker_threads` entry skips vitest's transform, and the `.js` specifier does not
// exist before a build), so the next best guarantee is to fail the moment the two drift.
describe("the worker's claim SQL is the app's claim SQL", () => {
  function normalizedSql(source: string, marker: string): string {
    const start = source.indexOf(marker);
    expect(start).toBeGreaterThan(-1);
    const open = source.indexOf("`UPDATE recoverable_entries", start);
    expect(open).toBeGreaterThan(-1);
    const close = source.indexOf("`", open + 1);
    expect(close).toBeGreaterThan(-1);
    return source
      .slice(open + 1, close)
      .replace(/\s+/g, " ")
      .trim();
  }

  it("is byte-identical after whitespace normalization", () => {
    const appSource = readFileSync(fileURLToPath(new URL("../../src/store/entries.ts", import.meta.url)), "utf8");
    const workerSource = readFileSync(fileURLToPath(new URL("./workers/claim-worker.mjs", import.meta.url)), "utf8");

    const appSql = normalizedSql(appSource, "export function claim(");
    const workerSql = normalizedSql(workerSource, "function run(");

    expect(workerSql).toBe(appSql);
    // And it is still the predicate docs/07 §6 specifies, not two copies of the same mistake.
    expect(appSql).toContain("lifecycle_state IN ('IDLE','FAILED')");
    expect(appSql).toContain("lifecycle_state='RECREATING' AND claim_expires_at < :now");
  });
});
