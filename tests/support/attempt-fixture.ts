import type Database from "better-sqlite3";

/** Inserts synthetic attempt history without executing a recreation.
 * Production code must use the claim-fenced `attempts.startForClaim`. */
export function insertAttemptFixture(
  db: Database.Database,
  input: {
    id: string;
    planId: string;
    recoverableEntryId: string;
    startedAt: string;
    baseline: readonly string[];
  },
): void {
  db.prepare(
    `INSERT INTO recreation_attempts (id, plan_id, recoverable_entry_id, started_at, baseline_json)
     VALUES (@id, @planId, @recoverableEntryId, @startedAt, @baselineJson)`,
  ).run({ ...input, baselineJson: JSON.stringify(input.baseline) });
}
