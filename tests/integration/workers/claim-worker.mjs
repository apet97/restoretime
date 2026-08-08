// IT-03 process-level concurrency drill (docs/13, docs/07 §6). A real `node:worker_threads` worker
// that opens its OWN connection to the shared SQLite file and runs the atomic claim exactly as
// documented (docs/07 §6, mirrored verbatim from `src/store/entries.ts` `claim()`).
//
// This file is plain JS, not TypeScript: `new Worker(url)` in `node:worker_threads` does not go
// through vitest's transform pipeline, so a `.ts` entry here would fail to load. The SQL is
// duplicated from `src/store/entries.ts` rather than imported — the worker needs to be loadable by
// bare Node with no build step and no test-runner transform, and importing the TS source by its
// `.js`-suffixed specifier (NodeNext resolution) would resolve to a file that does not exist before
// `npm run build`. Keep this string in sync with `entries.ts`'s `claim()` SQL; `tests/integration/
// claim.test.ts` (IT-12) already pins that same SQL's behavior against the real module, so a drift
// between the two would surface as this test and that one disagreeing about who wins.
import { parentPort, workerData } from "node:worker_threads";
import Database from "better-sqlite3";

const { dbPath, entryId, workspaceId, claimToken, nowIso } = workerData;

const CLAIM_LEASE_MS = 60_000;

function run() {
  const db = new Database(dbPath);
  // Real OS-thread-level concurrent writers (unlike the app's single Node process, where
  // better-sqlite3's synchronous calls never truly interleave): without a busy timeout a losing
  // writer can throw SQLITE_BUSY instead of cleanly observing "0 rows updated", which would be
  // mistaken for a concurrency bug rather than what it is — an un-retried lock wait.
  db.pragma("journal_mode = WAL");
  db.pragma("busy_timeout = 5000");

  const now = nowIso;
  const nowPlus60s = new Date(new Date(nowIso).getTime() + CLAIM_LEASE_MS).toISOString();

  const row = db
    .prepare(
      `UPDATE recoverable_entries
       SET lifecycle_state='RECREATING', claim_token=:token, claim_expires_at=:now_plus_60s
       WHERE id=:id AND workspace_id=:ws
         AND (lifecycle_state IN ('IDLE','FAILED')
              OR (lifecycle_state='RECREATING' AND claim_expires_at < :now))
       RETURNING *`,
    )
    .get({ id: entryId, ws: workspaceId, token: claimToken, now, now_plus_60s: nowPlus60s });

  db.close();
  return row;
}

try {
  const row = run();
  parentPort.postMessage({ ok: true, claimed: row !== undefined, claimToken, wonToken: row ? row.claim_token : null });
} catch (err) {
  parentPort.postMessage({ ok: false, claimToken, error: String(err) });
}
