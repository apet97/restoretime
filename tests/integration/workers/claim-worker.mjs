// IT-03 process-level concurrency drill. The default mode runs only the initial IDLE-row
// compare-and-set from its own SQLite connection. It does not copy the production expired-claim
// recovery decision. The observer mode keeps a second connection open while the test calls the
// complete production `entries.claim` implementation on the first connection.
//
// This file is plain JS, not TypeScript: `new Worker(url)` in `node:worker_threads` does not go
// through vitest's transform pipeline, so a `.ts` entry here would fail to load before a build.
import { parentPort, workerData } from "node:worker_threads";
import Database from "better-sqlite3";

const {
  mode = "claim-idle",
  dbPath,
  entryId,
  scope,
  claimToken,
  attemptId,
  nowIso,
} = workerData;

const CLAIM_LEASE_MS = 60_000;

function openDb() {
  const db = new Database(dbPath);
  // Real OS-thread-level concurrent writers (unlike the app's single Node process, where
  // better-sqlite3's synchronous calls never truly interleave): without a busy timeout a losing
  // writer can throw SQLITE_BUSY instead of cleanly observing "0 rows updated", which would be
  // mistaken for a concurrency bug rather than what it is — an un-retried lock wait.
  db.pragma("journal_mode = WAL");
  db.pragma("busy_timeout = 5000");
  return db;
}

function claimIdle() {
  const db = openDb();

  const nowPlus60s = new Date(new Date(nowIso).getTime() + CLAIM_LEASE_MS).toISOString();

  const row = db
    .prepare(
      `UPDATE recoverable_entries
       SET lifecycle_state='RECREATING', claim_token=:token, claim_expires_at=:now_plus_60s
       WHERE id=:id AND workspace_id=:ws AND addon_id=:addon
         AND lifecycle_state='IDLE'
       RETURNING *`,
    )
    .get({ id: entryId, ws: scope.workspaceId, addon: scope.addonId, token: claimToken, now_plus_60s: nowPlus60s });

  db.close();
  return row;
}

function snapshot(db) {
  return db.prepare(
    `SELECT e.lifecycle_state AS lifecycleState, e.claim_token AS wonToken,
            a.outcome AS attemptOutcome
     FROM recoverable_entries e
     LEFT JOIN recreation_attempts a ON a.id=@attemptId
     WHERE e.id=@entryId AND e.workspace_id=@workspaceId AND e.addon_id=@addonId`,
  ).get({ attemptId, entryId, workspaceId: scope.workspaceId, addonId: scope.addonId });
}

if (mode === "observe-started-attempt") {
  const db = openDb();
  try {
    parentPort.postMessage({ ok: true, phase: "before", claimToken: attemptId, ...snapshot(db) });
    parentPort.once("message", () => {
      try {
        parentPort.postMessage({ ok: true, phase: "after", claimToken: attemptId, ...snapshot(db) });
      } catch (err) {
        parentPort.postMessage({ ok: false, phase: "after", claimToken: attemptId, error: String(err) });
      } finally {
        db.close();
      }
    });
  } catch (err) {
    db.close();
    parentPort.postMessage({ ok: false, phase: "before", claimToken: attemptId, error: String(err) });
  }
} else {
  try {
    const row = claimIdle();
    parentPort.postMessage({ ok: true, claimed: row !== undefined, claimToken, wonToken: row ? row.claim_token : null });
  } catch (err) {
    parentPort.postMessage({ ok: false, claimToken, error: String(err) });
  }
}
