// recreation_attempts query module (docs/08). One row per mutation attempt; `id` doubles as the
// claim token (docs/08 "recreation_attempts").

import type Database from "better-sqlite3";
import type {
  AttemptOutcome,
  ReconcileSummary,
  RecreationAttempt,
  VerificationDiff,
} from "../domain/entry.js";

interface AttemptRow {
  id: string;
  plan_id: string;
  recoverable_entry_id: string;
  started_at: string;
  finished_at: string | null;
  outcome: AttemptOutcome | null;
  new_entry_id: string | null;
  error_status: number | null;
  error_code: string | null;
  error_message: string | null;
  baseline_json: string | null;
  reconcile_json: string | null;
  diff_json: string | null;
}

function rowToAttempt(row: AttemptRow): RecreationAttempt {
  return {
    id: row.id,
    planId: row.plan_id,
    recoverableEntryId: row.recoverable_entry_id,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    outcome: row.outcome,
    newEntryId: row.new_entry_id,
    errorStatus: row.error_status,
    errorCode: row.error_code,
    errorMessage: row.error_message,
    baseline: row.baseline_json === null ? null : (JSON.parse(row.baseline_json) as string[]),
    reconcile: row.reconcile_json === null ? null : (JSON.parse(row.reconcile_json) as ReconcileSummary),
    diffs: row.diff_json === null ? null : (JSON.parse(row.diff_json) as VerificationDiff[]),
  };
}

/** Starts an attempt only while its claim token still owns the RECREATING row. This is the
 * pre-write fence: if a lease was recovered while the baseline read was in flight, the stale
 * process cannot persist an attempt and must not send a create request. */
export function startForClaim(
  db: Database.Database,
  input: { id: string; planId: string; recoverableEntryId: string; startedAt: string; baseline: readonly string[] },
): boolean {
  const result = db.prepare(
    `INSERT INTO recreation_attempts (id, plan_id, recoverable_entry_id, started_at, baseline_json)
     SELECT @id, @planId, @recoverableEntryId, @startedAt, @baselineJson
     FROM recoverable_entries
     WHERE id=@recoverableEntryId AND lifecycle_state='RECREATING' AND claim_token=@id`,
  ).run({
    id: input.id,
    planId: input.planId,
    recoverableEntryId: input.recoverableEntryId,
    startedAt: input.startedAt,
    baselineJson: JSON.stringify(input.baseline),
  });
  return result.changes === 1;
}

export function finish(
  db: Database.Database,
  input: {
    id: string;
    finishedAt: string;
    outcome: AttemptOutcome;
    newEntryId: string | null;
    errorStatus: number | null;
    errorCode: string | null;
    errorMessage: string | null;
    diffs: readonly VerificationDiff[] | null;
  },
): boolean {
  const result = db.prepare(
    `UPDATE recreation_attempts
     SET finished_at=@finishedAt, outcome=@outcome, new_entry_id=@newEntryId,
         error_status=@errorStatus, error_code=@errorCode, error_message=@errorMessage,
         diff_json=@diffJson
     WHERE id=@id`,
  ).run({
    id: input.id,
    finishedAt: input.finishedAt,
    outcome: input.outcome,
    newEntryId: input.newEntryId,
    errorStatus: input.errorStatus,
    errorCode: input.errorCode,
    errorMessage: input.errorMessage,
    diffJson: input.diffs === null ? null : JSON.stringify(input.diffs),
  });
  return result.changes === 1;
}

/** Records the first outcome only. The caller uses this inside the same transaction as the
 * fenced entry-state change, so neither half can commit alone. */
export function finishUnfinished(
  db: Database.Database,
  input: Parameters<typeof finish>[1],
): boolean {
  const result = db.prepare(
    `UPDATE recreation_attempts
     SET finished_at=@finishedAt, outcome=@outcome, new_entry_id=@newEntryId,
         error_status=@errorStatus, error_code=@errorCode, error_message=@errorMessage,
         diff_json=@diffJson
     WHERE id=@id AND outcome IS NULL`,
  ).run({
    id: input.id,
    finishedAt: input.finishedAt,
    outcome: input.outcome,
    newEntryId: input.newEntryId,
    errorStatus: input.errorStatus,
    errorCode: input.errorCode,
    errorMessage: input.errorMessage,
    diffJson: input.diffs === null ? null : JSON.stringify(input.diffs),
  });
  return result.changes === 1;
}

/** Marks the exact current AMBIGUOUS attempt as being checked before its Clockify read starts.
 * The immediate transaction makes this mutually exclusive with the mark-not-created transition:
 * either that transition wins first and this returns false, or the fresh timestamp closes its
 * age gate until the read completes. Existing check evidence is preserved. */
export function beginReconcile(
  db: Database.Database,
  input: {
    recoverableEntryId: string;
    workspaceId: string;
    expectedAttemptId: string;
    checkedAt: string;
  },
): boolean {
  const begin = db.transaction(() => {
    const row = db.prepare<[string, string, string], Pick<AttemptRow, "reconcile_json">>(
      `SELECT a.reconcile_json
       FROM recreation_attempts a
       JOIN recoverable_entries e ON e.id=a.recoverable_entry_id
       WHERE a.id=? AND a.recoverable_entry_id=? AND e.workspace_id=?
         AND e.lifecycle_state='AMBIGUOUS'
         AND a.id = (
           SELECT id FROM recreation_attempts
           WHERE recoverable_entry_id=a.recoverable_entry_id
           ORDER BY started_at DESC, rowid DESC LIMIT 1
         )`,
    ).get(input.expectedAttemptId, input.recoverableEntryId, input.workspaceId);
    if (!row) return false;

    const prior = row.reconcile_json === null
      ? { checks: 0, matchCount: 0, candidateIds: [], truncated: false }
      : (JSON.parse(row.reconcile_json) as Omit<ReconcileSummary, "checkedAt"> & { checkedAt: string });
    const result = db.prepare(
      "UPDATE recreation_attempts SET reconcile_json=? WHERE id=?",
    ).run(JSON.stringify({ ...prior, checkedAt: input.checkedAt }), input.expectedAttemptId);
    return result.changes === 1;
  });
  return begin.immediate();
}

export function updateReconcile(db: Database.Database, id: string, reconcile: ReconcileSummary): void {
  db.prepare("UPDATE recreation_attempts SET reconcile_json = ? WHERE id = ?").run(
    JSON.stringify(reconcile),
    id,
  );
}

export function getById(db: Database.Database, id: string): RecreationAttempt | undefined {
  const row = db
    .prepare<[string], AttemptRow>("SELECT * FROM recreation_attempts WHERE id = ?")
    .get(id);
  return row ? rowToAttempt(row) : undefined;
}

export function listForEntry(db: Database.Database, recoverableEntryId: string): RecreationAttempt[] {
  const rows = db
    .prepare<[string], AttemptRow>(
      "SELECT * FROM recreation_attempts WHERE recoverable_entry_id = ? ORDER BY started_at DESC",
    )
    .all(recoverableEntryId);
  return rows.map(rowToAttempt);
}

/** The latest attempt for an entry, regardless of outcome (used to find the current AMBIGUOUS
 * attempt for reconcile throttling and the bounded-window check). */
export function latestForEntry(
  db: Database.Database,
  recoverableEntryId: string,
): RecreationAttempt | undefined {
  const row = db
    .prepare<[string], AttemptRow>(
      `SELECT * FROM recreation_attempts
       WHERE recoverable_entry_id = ?
       ORDER BY started_at DESC, rowid DESC LIMIT 1`,
    )
    .get(recoverableEntryId);
  return row ? rowToAttempt(row) : undefined;
}
