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

interface StoredReconcile extends ReconcileSummary {
  readonly runId?: string;
  readonly runStartedAt?: string;
  readonly prior?: ReconcileSummary | null;
}

function parseStoredReconcile(value: string | null): StoredReconcile | null {
  return value === null ? null : (JSON.parse(value) as StoredReconcile);
}

function publicReconcile(value: string | null): ReconcileSummary | null {
  const stored = parseStoredReconcile(value);
  if (!stored) return null;
  if (stored.runId !== undefined) return stored.prior ?? null;
  const { runId: _runId, runStartedAt: _runStartedAt, prior: _prior, ...summary } = stored;
  return summary;
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
    reconcile: publicReconcile(row.reconcile_json),
    diffs: row.diff_json === null ? null : (JSON.parse(row.diff_json) as VerificationDiff[]),
  };
}

/** Starts an attempt only while its claim token still owns the RECREATING row. This is the
 * pre-write fence: if a lease was recovered while the baseline read was in flight, the stale
 * process cannot persist an attempt and must not send a create request. */
export function startForClaim(
  db: Database.Database,
  input: {
    id: string;
    planId: string;
    recoverableEntryId: string;
    startedAt: string;
    leaseExpiresAt: string;
    baseline: readonly string[];
  },
): boolean {
  const renewAndStart = db.transaction(() => {
    const renewed = db.prepare(
      `UPDATE recoverable_entries
       SET claim_expires_at=CASE
         WHEN claim_expires_at IS NULL
           OR julianday(claim_expires_at) < julianday(@leaseExpiresAt)
         THEN @leaseExpiresAt
         ELSE claim_expires_at
       END
       WHERE id=@recoverableEntryId AND lifecycle_state='RECREATING' AND claim_token=@id`,
    ).run(input);
    if (renewed.changes !== 1) return false;

    const result = db.prepare(
      `INSERT INTO recreation_attempts (id, plan_id, recoverable_entry_id, started_at, baseline_json)
       VALUES (@id, @planId, @recoverableEntryId, @startedAt, @baselineJson)`,
    ).run({
      ...input,
      baselineJson: JSON.stringify(input.baseline),
    });
    return result.changes === 1;
  });
  return renewAndStart.immediate();
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
         diff_json=@diffJson,
         baseline_json=CASE WHEN @outcome='AMBIGUOUS' THEN baseline_json ELSE NULL END,
         reconcile_json=CASE WHEN @outcome='AMBIGUOUS' THEN reconcile_json ELSE NULL END
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
         diff_json=@diffJson,
         baseline_json=CASE WHEN @outcome='AMBIGUOUS' THEN baseline_json ELSE NULL END,
         reconcile_json=CASE WHEN @outcome='AMBIGUOUS' THEN reconcile_json ELSE NULL END
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

/** Replaces the provisional 201-body diff after the optional verification read completes. */
export function updateSuccessDiffs(
  db: Database.Database,
  id: string,
  newEntryId: string,
  diffs: readonly VerificationDiff[],
): boolean {
  const result = db.prepare(
    `UPDATE recreation_attempts SET diff_json=?
     WHERE id=? AND outcome='SUCCESS' AND new_entry_id=?`,
  ).run(JSON.stringify(diffs), id, newEntryId);
  return result.changes === 1;
}

/** Marks the exact current AMBIGUOUS attempt as being checked before its Clockify read starts.
 * The immediate transaction makes this mutually exclusive with the mark-not-created transition:
 * either that transition wins first and this returns false, or the fresh timestamp closes its
 * age gate until the read completes. Existing check evidence is preserved. */
export type BeginReconcileResult =
  | { readonly kind: "started"; readonly prior: ReconcileSummary | null }
  | { readonly kind: "throttled" }
  | { readonly kind: "changed" };

export function beginReconcile(
  db: Database.Database,
  input: {
    recoverableEntryId: string;
    workspaceId: string;
    expectedAttemptId: string;
    checkedAt: string;
    runId: string;
    throttleMs: number;
    /** Manual candidate validation ignores the last completed check but still excludes a live run. */
    ignorePreviousCheck?: boolean;
  },
): BeginReconcileResult {
  const begin = db.transaction((): BeginReconcileResult => {
    const row = db.prepare<[string, string, string], Pick<AttemptRow, "reconcile_json">>(
      `SELECT a.reconcile_json
       FROM recreation_attempts a
       JOIN recoverable_entries e ON e.id=a.recoverable_entry_id
       WHERE a.id=? AND a.recoverable_entry_id=? AND e.workspace_id=?
         AND e.lifecycle_state='AMBIGUOUS'
         AND a.id = (
           SELECT id FROM recreation_attempts
           WHERE recoverable_entry_id=a.recoverable_entry_id
           ORDER BY rowid DESC LIMIT 1
         )`,
    ).get(input.expectedAttemptId, input.recoverableEntryId, input.workspaceId);
    if (!row) return { kind: "changed" };

    const stored = parseStoredReconcile(row.reconcile_json);
    const prior = stored?.runId !== undefined
      ? (stored.prior ?? null)
      : publicReconcile(row.reconcile_json);
    if (stored?.runId !== undefined) {
      const runStartedAt = stored.runStartedAt ?? stored.checkedAt;
      if (new Date(input.checkedAt).getTime() - new Date(runStartedAt).getTime() < input.throttleMs) {
        return { kind: "throttled" };
      }
    }
    if (
      stored?.runId === undefined &&
      prior !== null &&
      input.ignorePreviousCheck !== true &&
      new Date(input.checkedAt).getTime() - new Date(prior.checkedAt).getTime() < input.throttleMs
    ) {
      return { kind: "throttled" };
    }
    const base: ReconcileSummary = prior ?? {
      checkedAt: input.checkedAt,
      checks: 0,
      matchCount: 0,
      candidateIds: [],
      truncated: false,
    };
    const result = db.prepare(
      "UPDATE recreation_attempts SET reconcile_json=? WHERE id=?",
    ).run(
      JSON.stringify({
        ...base,
        runId: input.runId,
        runStartedAt: input.checkedAt,
        prior,
      } satisfies StoredReconcile),
      input.expectedAttemptId,
    );
    return result.changes === 1
      ? { kind: "started", prior }
      : { kind: "changed" };
  });
  return begin.immediate();
}

export function completeReconcile(
  db: Database.Database,
  input: {
    id: string;
    runId: string;
    checkedAt: string;
    countCheck: boolean;
    matchCount: number;
    candidateIds: readonly string[];
    truncated: boolean;
  },
): boolean {
  const complete = db.transaction(() => {
    const row = db.prepare<[string], Pick<AttemptRow, "reconcile_json">>(
      "SELECT reconcile_json FROM recreation_attempts WHERE id=?",
    ).get(input.id);
    const current = parseStoredReconcile(row?.reconcile_json ?? null);
    if (!current || current.runId !== input.runId) return false;
    const firstEligibleCheckAt = input.countCheck
      ? (current.firstEligibleCheckAt ?? input.checkedAt)
      : current.firstEligibleCheckAt;
    const checks = input.countCheck
      ? (current.firstEligibleCheckAt === undefined ? 1 : current.checks + 1)
      : current.checks;
    const candidateIds = [...new Set([...current.candidateIds, ...input.candidateIds])];
    const summary: ReconcileSummary = {
      checkedAt: input.checkedAt,
      ...(firstEligibleCheckAt === undefined ? {} : { firstEligibleCheckAt }),
      checks,
      matchCount: input.matchCount,
      candidateIds,
      truncated: input.truncated,
    };
    return db.prepare(
      "UPDATE recreation_attempts SET reconcile_json=? WHERE id=?",
    ).run(JSON.stringify(summary), input.id).changes === 1;
  });
  return complete.immediate();
}

/** Removes only this caller's in-flight token after a read fails. Prior evidence stays intact. */
export function cancelReconcile(
  db: Database.Database,
  id: string,
  runId: string,
): boolean {
  const cancel = db.transaction(() => {
    const row = db.prepare<[string], Pick<AttemptRow, "reconcile_json">>(
      "SELECT reconcile_json FROM recreation_attempts WHERE id=?",
    ).get(id);
    const current = parseStoredReconcile(row?.reconcile_json ?? null);
    if (!current || current.runId !== runId) return false;
    return db.prepare(
      "UPDATE recreation_attempts SET reconcile_json=? WHERE id=?",
    ).run(current.prior === null ? null : JSON.stringify(current.prior), id).changes === 1;
  });
  return cancel.immediate();
}

export function reconcileInFlight(db: Database.Database, id: string): boolean {
  const row = db.prepare<[string], Pick<AttemptRow, "reconcile_json">>(
    "SELECT reconcile_json FROM recreation_attempts WHERE id=?",
  ).get(id);
  return parseStoredReconcile(row?.reconcile_json ?? null)?.runId !== undefined;
}

/** Checked inside the same write transaction as adoption to fence a completed external read. */
export function reconcileRunOwnedBy(
  db: Database.Database,
  id: string,
  runId: string,
): boolean {
  const row = db.prepare<[string], Pick<AttemptRow, "reconcile_json">>(
    "SELECT reconcile_json FROM recreation_attempts WHERE id=?",
  ).get(id);
  return parseStoredReconcile(row?.reconcile_json ?? null)?.runId === runId;
}

export function clearTransientEvidenceForEntry(db: Database.Database, recoverableEntryId: string): void {
  db.prepare(
    "UPDATE recreation_attempts SET baseline_json=NULL, reconcile_json=NULL WHERE recoverable_entry_id=?",
  ).run(recoverableEntryId);
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
      "SELECT * FROM recreation_attempts WHERE recoverable_entry_id = ? ORDER BY rowid DESC",
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
       ORDER BY rowid DESC LIMIT 1`,
    )
    .get(recoverableEntryId);
  return row ? rowToAttempt(row) : undefined;
}
