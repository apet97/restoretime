import type Database from "better-sqlite3";
import * as attempts from "../../src/store/attempts.js";

/** Starts the same durable read fence production uses before a focused store/orchestrator test. */
export function beginReconcileFixture(
  db: Database.Database,
  input: {
    recoverableEntryId: string;
    workspaceId: string;
    expectedAttemptId: string;
    checkedAt?: string;
    runId?: string;
  },
): string {
  const runId = input.runId ?? `${input.expectedAttemptId}-fixture-run`;
  const result = attempts.beginReconcile(db, {
    recoverableEntryId: input.recoverableEntryId,
    workspaceId: input.workspaceId,
    expectedAttemptId: input.expectedAttemptId,
    checkedAt: input.checkedAt ?? "2026-08-08T09:02:00.000Z",
    runId,
    throttleMs: 0,
    ignorePreviousCheck: true,
  });
  if (result.kind !== "started") {
    throw new Error(`could not start reconcile fixture: ${result.kind}`);
  }
  return runId;
}
