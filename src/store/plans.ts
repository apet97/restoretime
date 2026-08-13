// recreation_plans query module (docs/08, ADR-006). At most one ACTIVE plan per entry, enforced
// by the partial unique index in migration 0002 — createActive() also does it explicitly inside
// one transaction so the STALE-marking and the insert never interleave with a concurrent request.

import type Database from "better-sqlite3";
import type {
  ActionRequiredItem,
  Fidelity,
  PlanBlocker,
  PlanPresentation,
  PlannedRequest,
  PlanResolution,
  PlanStatus,
  PlanWarning,
  PreflightChoices,
  RecreationPlan,
} from "../domain/entry.js";

interface PlanRow {
  id: string;
  recoverable_entry_id: string;
  created_by: string;
  created_at: string;
  source_hash: string;
  choices_json: string;
  resolution_json: string;
  planned_request_json: string;
  presentation_json: string | null;
  warnings_json: string;
  blockers_json: string;
  action_required_json: string;
  fidelity: Fidelity;
  status: PlanStatus;
}

function rowToPlan(row: PlanRow): RecreationPlan {
  return {
    id: row.id,
    recoverableEntryId: row.recoverable_entry_id,
    createdBy: row.created_by,
    createdAt: row.created_at,
    sourceHash: row.source_hash,
    choices: JSON.parse(row.choices_json) as PreflightChoices,
    resolution: JSON.parse(row.resolution_json) as PlanResolution[],
    plannedRequest: JSON.parse(row.planned_request_json) as PlannedRequest,
    presentation: row.presentation_json === null
      ? null
      : (JSON.parse(row.presentation_json) as PlanPresentation),
    warnings: JSON.parse(row.warnings_json) as PlanWarning[],
    blockers: JSON.parse(row.blockers_json) as PlanBlocker[],
    actionRequired: JSON.parse(row.action_required_json) as ActionRequiredItem[],
    fidelity: row.fidelity,
    status: row.status,
  };
}

export interface NewPlan {
  readonly id: string;
  readonly recoverableEntryId: string;
  readonly createdBy: string;
  readonly createdAt: string;
  readonly sourceHash: string;
  readonly choices: PreflightChoices;
  readonly resolution: readonly PlanResolution[];
  readonly plannedRequest: PlannedRequest;
  readonly presentation: PlanPresentation;
  readonly warnings: readonly PlanWarning[];
  readonly blockers: readonly PlanBlocker[];
  readonly actionRequired: readonly ActionRequiredItem[];
  readonly fidelity: Fidelity;
}

export class PlanEntryNotActionableError extends Error {
  constructor() {
    super("cannot create an active plan for an entry in its current state");
  }
}

/** Checks that the entry is still actionable, prunes obsolete plans with no attempt, marks any
 * existing ACTIVE plan STALE, and inserts the new ACTIVE plan in one immediate transaction. A
 * preflight can spend time on Clockify reads; this final check prevents it from attaching a fresh
 * plan after a concurrent recreation has already moved the entry to a non-actionable state. */
export function createActive(db: Database.Database, plan: NewPlan): RecreationPlan {
  const run = db.transaction((p: NewPlan): RecreationPlan => {
    const actionable = db.prepare<[string], { id: string }>(
      `SELECT id FROM recoverable_entries
       WHERE id=? AND lifecycle_state IN ('IDLE','FAILED')`,
    ).get(p.recoverableEntryId);
    if (!actionable) throw new PlanEntryNotActionableError();

    db.prepare(
      `DELETE FROM recreation_plans
       WHERE recoverable_entry_id=? AND status IN ('STALE','CONSUMED')
         AND NOT EXISTS (
           SELECT 1 FROM recreation_attempts
           WHERE plan_id=recreation_plans.id
         )`,
    ).run(p.recoverableEntryId);
    db.prepare(
      "UPDATE recreation_plans SET status='STALE' WHERE recoverable_entry_id=? AND status='ACTIVE'",
    ).run(p.recoverableEntryId);
    db.prepare(
      `INSERT INTO recreation_plans
         (id, recoverable_entry_id, created_by, created_at, source_hash, choices_json, resolution_json,
          planned_request_json, presentation_json, warnings_json, blockers_json,
          action_required_json, fidelity, status)
       VALUES (@id, @recoverableEntryId, @createdBy, @createdAt, @sourceHash, @choicesJson, @resolutionJson,
               @plannedRequestJson, @presentationJson, @warningsJson, @blockersJson,
               @actionRequiredJson, @fidelity, 'ACTIVE')`,
    ).run({
      id: p.id,
      recoverableEntryId: p.recoverableEntryId,
      createdBy: p.createdBy,
      createdAt: p.createdAt,
      sourceHash: p.sourceHash,
      choicesJson: JSON.stringify(p.choices),
      resolutionJson: JSON.stringify(p.resolution),
      plannedRequestJson: JSON.stringify(p.plannedRequest),
      presentationJson: JSON.stringify(p.presentation),
      warningsJson: JSON.stringify(p.warnings),
      blockersJson: JSON.stringify(p.blockers),
      actionRequiredJson: JSON.stringify(p.actionRequired),
      fidelity: p.fidelity,
    });
    const row = db.prepare<[string], PlanRow>(
      "SELECT * FROM recreation_plans WHERE id = ?",
    ).get(p.id);
    if (!row) throw new Error("plan insert did not persist");
    return rowToPlan(row);
  });
  return run.immediate(plan);
}

export function getById(db: Database.Database, id: string): RecreationPlan | undefined {
  const row = db.prepare<[string], PlanRow>("SELECT * FROM recreation_plans WHERE id = ?").get(id);
  return row ? rowToPlan(row) : undefined;
}

export function getActiveForEntry(
  db: Database.Database,
  recoverableEntryId: string,
): RecreationPlan | undefined {
  const row = db
    .prepare<[string], PlanRow>(
      "SELECT * FROM recreation_plans WHERE recoverable_entry_id = ? AND status = 'ACTIVE'",
    )
    .get(recoverableEntryId);
  return row ? rowToPlan(row) : undefined;
}

export function getLatestForEntryWithChoices(
  db: Database.Database,
  recoverableEntryId: string,
  choices: PreflightChoices,
): RecreationPlan | undefined {
  const row = db.prepare<[string, string], PlanRow>(
    `SELECT * FROM recreation_plans
     WHERE recoverable_entry_id=? AND choices_json=?
     ORDER BY rowid DESC LIMIT 1`,
  ).get(recoverableEntryId, JSON.stringify(choices));
  return row ? rowToPlan(row) : undefined;
}

export function listForEntry(db: Database.Database, recoverableEntryId: string): RecreationPlan[] {
  const rows = db
    .prepare<[string], PlanRow>(
      "SELECT * FROM recreation_plans WHERE recoverable_entry_id = ? ORDER BY rowid DESC",
    )
    .all(recoverableEntryId);
  return rows.map(rowToPlan);
}

/** Invalidates one legacy ACTIVE plan before returning a fresh-preflight response. */
export function markStale(db: Database.Database, id: string): boolean {
  const result = db.prepare(
    "UPDATE recreation_plans SET status='STALE' WHERE id=? AND status='ACTIVE'",
  ).run(id);
  return result.changes === 1;
}
