import type Database from "better-sqlite3";
import type { InstallationScope, ReconcileSummary } from "../../src/domain/entry.js";
import * as attempts from "../../src/store/attempts.js";

/** Records the first AMBIGUOUS outcome, then starts the durable read fence production uses. */
export function beginReconcileFixture(
  db: Database.Database,
  input: {
    recoverableEntryId: string;
    scope: InstallationScope;
    expectedAttemptId: string;
    checkedAt?: string;
    runId?: string;
  },
): string {
  const runId = input.runId ?? `${input.expectedAttemptId}-fixture-run`;
  const checkedAt = input.checkedAt ?? "2026-08-08T09:02:00.000Z";
  const attempt = attempts.getById(db, input.expectedAttemptId);
  if (attempt?.outcome === null) {
    const finished = attempts.finishUnfinished(db, {
      id: input.expectedAttemptId,
      finishedAt: checkedAt,
      outcome: "AMBIGUOUS",
      newEntryId: null,
      errorStatus: null,
      errorCode: null,
      errorMessage: null,
      diffs: null,
    });
    if (!finished) throw new Error("could not record ambiguous attempt fixture");
  }
  const result = attempts.beginReconcile(db, {
    recoverableEntryId: input.recoverableEntryId,
    scope: input.scope,
    expectedAttemptId: input.expectedAttemptId,
    checkedAt,
    runId,
    throttleMs: 0,
    ignorePreviousCheck: true,
  });
  if (result.kind !== "started") {
    throw new Error(`could not start reconcile fixture: ${result.kind}`);
  }
  return runId;
}

/**
 * Overwrites an attempt's reconcile summary outright.
 *
 * Production never does this: it goes through `beginReconcile` + `completeReconcile`, which fence
 * each write to the run that owns it. A test that needs to *arrive* at a given reconcile state —
 * three checks spanning the mark-not-created window, say — would otherwise have to simulate every
 * intervening read. So this stays a fixture rather than a store export.
 */
export function setReconcileFixture(
  db: Database.Database,
  attemptId: string,
  reconcile: ReconcileSummary,
): void {
  db.prepare("UPDATE recreation_attempts SET reconcile_json = ? WHERE id = ?").run(
    JSON.stringify(reconcile),
    attemptId,
  );
}
