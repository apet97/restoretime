// recoverable_entries query module (docs/08). Prepared statements only, no ORM. The claim SQL is
// docs/07 §6 verbatim, including the lease clause — a crashed RECREATING attempt must stay
// reclaimable after its 60 s lease expires (IT-12).

import type Database from "better-sqlite3";
import type { DeletedTimeEntry, LifecycleState, RecoverableEntry } from "../domain/entry.js";

interface EntryRow {
  id: string;
  workspace_id: string;
  source_entry_id: string;
  owner_id: string;
  detected_at: string;
  source_json: string;
  lifecycle_state: LifecycleState;
  claim_token: string | null;
  claim_expires_at: string | null;
  new_entry_id: string | null;
  recreated_at: string | null;
  recreated_by: string | null;
  parent_recoverable_id: string | null;
}

function rowToEntry(row: EntryRow): RecoverableEntry {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    sourceEntryId: row.source_entry_id,
    ownerId: row.owner_id,
    detectedAt: row.detected_at,
    source: JSON.parse(row.source_json) as DeletedTimeEntry,
    lifecycleState: row.lifecycle_state,
    claimToken: row.claim_token,
    claimExpiresAt: row.claim_expires_at,
    newEntryId: row.new_entry_id,
    recreatedAt: row.recreated_at,
    recreatedBy: row.recreated_by,
    parentRecoverableId: row.parent_recoverable_id,
  };
}

const CLAIM_LEASE_MS = 60_000;

export interface IngestInput {
  readonly id: string;
  readonly workspaceId: string;
  readonly sourceEntryId: string;
  readonly ownerId: string;
  readonly detectedAt: string;
  readonly source: DeletedTimeEntry;
}

/** Finds the row whose `new_entry_id` equals `sourceEntryId`, for lineage linking on ingestion
 * (docs/03 §1, docs/06 "Lineage", UT-L01). */
export function findByNewEntryId(
  db: Database.Database,
  workspaceId: string,
  newEntryId: string,
): RecoverableEntry | undefined {
  const row = db
    .prepare<[string, string], EntryRow>(
      "SELECT * FROM recoverable_entries WHERE workspace_id = ? AND new_entry_id = ?",
    )
    .get(workspaceId, newEntryId);
  return row ? rowToEntry(row) : undefined;
}

/** ADR-003 / docs/05 invariant 1: one atomic transaction covering the `INSERT OR IGNORE` into
 * `recoverable_entries` plus, only when a row was inserted, the lineage-link
 * `UPDATE parent_recoverable_id`. Dedup and the lineage link commit or roll back together, so a
 * crash between them can never leave a webhook acked but unlinked (UT-L01, IT-01). */
export function ingestDeletedEntry(
  db: Database.Database,
  input: IngestInput,
): { inserted: boolean; entry: RecoverableEntry } {
  const run = db.transaction((i: IngestInput) => {
    const result = db
      .prepare(
        `INSERT OR IGNORE INTO recoverable_entries
           (id, workspace_id, source_entry_id, owner_id, detected_at, source_json, lifecycle_state)
         VALUES (@id, @workspaceId, @sourceEntryId, @ownerId, @detectedAt, @sourceJson, 'IDLE')`,
      )
      .run({
        id: i.id,
        workspaceId: i.workspaceId,
        sourceEntryId: i.sourceEntryId,
        ownerId: i.ownerId,
        detectedAt: i.detectedAt,
        sourceJson: JSON.stringify(i.source),
      });
    const inserted = result.changes > 0;
    if (inserted) {
      const parent = findByNewEntryId(db, i.workspaceId, i.sourceEntryId);
      if (parent) {
        db.prepare("UPDATE recoverable_entries SET parent_recoverable_id = ? WHERE id = ?").run(
          parent.id,
          i.id,
        );
      }
    }
    return inserted;
  });
  const inserted = run(input);
  const row = db
    .prepare<[string, string], EntryRow>(
      "SELECT * FROM recoverable_entries WHERE workspace_id = ? AND source_entry_id = ?",
    )
    .get(input.workspaceId, input.sourceEntryId);
  if (!row) throw new Error("ingest did not persist a row");
  return { inserted, entry: rowToEntry(row) };
}

export function getById(
  db: Database.Database,
  workspaceId: string,
  id: string,
): RecoverableEntry | undefined {
  const row = db
    .prepare<[string, string], EntryRow>(
      "SELECT * FROM recoverable_entries WHERE id = ? AND workspace_id = ?",
    )
    .get(id, workspaceId);
  return row ? rowToEntry(row) : undefined;
}

export interface ListFilters {
  readonly ownerId?: string; // set for non-admin viewers (docs/09)
  readonly userId?: string; // admin filter
  readonly projectId?: string;
  /** Substring match on the owner/project name **as captured at deletion time** (docs/10 §2).
   * Deliberately not a Clockify lookup: a deleted project and a deactivated user are exactly the
   * rows this product exists for, and neither appears in any current options list — so resolving
   * a name to an id would silently fail to find them. The trade-off is that a later rename in
   * Clockify does not reach rows already stored. */
  readonly ownerName?: string;
  readonly projectName?: string;
  readonly from?: string;
  readonly to?: string;
  readonly status?: LifecycleState;
  readonly search?: string;
  readonly dismissed?: boolean;
  /** Caps how many rows come back. The list route always sets this: every returned row costs a
   * preflight with its own Clockify lookups, so an unbounded read is an unbounded fan-out. */
  readonly limit?: number;
}

/** A `LIKE` pattern matching `value` anywhere in a column. SQLite's own wildcards (`%`, `_`) and
 * the escape character are neutralized, so a user searching for `50%` finds the literal text
 * rather than every row. Case-insensitive for ASCII only — that is SQLite's built-in `LIKE`, and
 * it applies equally to the description search and the two name filters (docs/10 §2). */
function likeContains(value: string): string {
  return `%${value.replace(/[%_\\]/g, "\\$&")}%`;
}

/** `list` fetched one row beyond `limit`, meaning older rows exist that were not returned. */
export interface ListPage {
  readonly rows: RecoverableEntry[];
  readonly truncated: boolean;
}

export function list(
  db: Database.Database,
  workspaceId: string,
  filters: ListFilters,
): ListPage {
  const clauses = ["workspace_id = @workspaceId"];
  const params: Record<string, unknown> = { workspaceId };

  if (filters.ownerId !== undefined) {
    clauses.push("owner_id = @ownerId");
    params.ownerId = filters.ownerId;
  }
  if (filters.userId !== undefined) {
    clauses.push("owner_id = @userId");
    params.userId = filters.userId;
  }
  // DISMISSED is a lifecycle state, not a second axis: `dismissed: true` selects it and `status`
  // selects any other one, so the two are alternatives rather than filters that narrow together.
  // Resolving them to a single state here is what keeps `status` and `dismissed` from ever being
  // ANDed into `lifecycle_state = 'FAILED' AND lifecycle_state = 'DISMISSED'`, which matches
  // nothing and reads to the admin as "no such entries exist" — the same lie the route already
  // refuses to tell for an unknown `status` (docs/09, docs/10 §2). `dismissed` wins, because
  // reaching a category the default hides is its only purpose.
  const state = filters.dismissed === true ? "DISMISSED" : filters.status;
  if (state !== undefined) {
    clauses.push("lifecycle_state = @state");
    params.state = state;
  } else {
    clauses.push("lifecycle_state != 'DISMISSED'");
  }
  if (filters.from !== undefined) {
    clauses.push("detected_at >= @from");
    params.from = filters.from;
  }
  if (filters.to !== undefined) {
    clauses.push("detected_at <= @to");
    params.to = filters.to;
  }
  if (filters.projectId !== undefined) {
    clauses.push("json_extract(source_json, '$.projectId') = @projectId");
    params.projectId = filters.projectId;
  }
  if (filters.search !== undefined && filters.search.length > 0) {
    clauses.push("json_extract(source_json, '$.description') LIKE @search ESCAPE '\\'");
    params.search = likeContains(filters.search);
  }
  if (filters.ownerName !== undefined && filters.ownerName.length > 0) {
    clauses.push("json_extract(source_json, '$.ownerName') LIKE @ownerName ESCAPE '\\'");
    params.ownerName = likeContains(filters.ownerName);
  }
  if (filters.projectName !== undefined && filters.projectName.length > 0) {
    // A project-less entry stores `null` here, and `NULL LIKE …` is NULL, so it never matches —
    // which is what filtering by a project name should do.
    clauses.push("json_extract(source_json, '$.projectName') LIKE @projectName ESCAPE '\\'");
    params.projectName = likeContains(filters.projectName);
  }

  // Fetch one past the cap so "there are more" is observed, never guessed from a full page.
  let limitSql = "";
  if (filters.limit !== undefined) {
    limitSql = " LIMIT @limitPlusOne";
    params.limitPlusOne = filters.limit + 1;
  }

  const rows = db
    .prepare<Record<string, unknown>, EntryRow>(
      `SELECT * FROM recoverable_entries WHERE ${clauses.join(" AND ")} ORDER BY detected_at DESC${limitSql}`,
    )
    .all(params);

  const truncated = filters.limit !== undefined && rows.length > filters.limit;
  return { rows: (truncated ? rows.slice(0, filters.limit) : rows).map(rowToEntry), truncated };
}

export interface ClaimInput {
  readonly id: string;
  readonly workspaceId: string;
  readonly claimToken: string;
  readonly now: Date;
}

/** The atomic claim (docs/07 §6, verbatim SQL). Zero rows returned means another attempt owns
 * the row or its state forbids claiming — callers respond with the current state. */
export function claim(db: Database.Database, input: ClaimInput): RecoverableEntry | undefined {
  const now = input.now.toISOString();
  const nowPlus60s = new Date(input.now.getTime() + CLAIM_LEASE_MS).toISOString();
  const row = db
    .prepare<Record<string, unknown>, EntryRow>(
      `UPDATE recoverable_entries
       SET lifecycle_state='RECREATING', claim_token=:token, claim_expires_at=:now_plus_60s
       WHERE id=:id AND workspace_id=:ws
         AND (lifecycle_state IN ('IDLE','FAILED')
              OR (lifecycle_state='RECREATING' AND claim_expires_at < :now))
       RETURNING *`,
    )
    .get({ id: input.id, ws: input.workspaceId, token: input.claimToken, now, now_plus_60s: nowPlus60s });
  return row ? rowToEntry(row) : undefined;
}

interface FencedInput {
  readonly id: string;
  readonly workspaceId: string;
  readonly claimToken: string;
}

/** RECREATING -> RECREATED, fenced by the claim token that won the claim (§8). */
export function setRecreated(
  db: Database.Database,
  input: FencedInput & { newEntryId: string; recreatedAt: string; recreatedBy: string },
): RecoverableEntry | undefined {
  const row = db
    .prepare<FencedInput & { newEntryId: string; recreatedAt: string; recreatedBy: string }, EntryRow>(
      `UPDATE recoverable_entries
       SET lifecycle_state='RECREATED', new_entry_id=@newEntryId, recreated_at=@recreatedAt,
           recreated_by=@recreatedBy, claim_token=NULL, claim_expires_at=NULL
       WHERE id=@id AND workspace_id=@workspaceId AND claim_token=@claimToken
       RETURNING *`,
    )
    .get(input);
  return row ? rowToEntry(row) : undefined;
}

/**
 * Fenced release of a claim that never reached Clockify: puts the row back into the exact state
 * it held before the claim, and clears the lease.
 *
 * A confirm can win the claim and then abort before any Clockify write — a racing confirm consumed
 * the plan first, or the baseline read hit the page bound. Neither case is a failure of a
 * recreation, so the row must not become FAILED: docs/08 invariant 4 says every transition out of
 * RECREATING has an attempt row, and there is no attempt here. It must not stay RECREATING either,
 * or the entry looks busy for the whole 60 s lease.
 *
 * Only ever call this on a path where no create was issued. After a create, the outcome is
 * unknown and ADR-007 governs.
 */
export function releaseClaim(
  db: Database.Database,
  input: FencedInput & { previousState: "IDLE" | "FAILED" },
): RecoverableEntry | undefined {
  const row = db
    .prepare<FencedInput & { previousState: string }, EntryRow>(
      `UPDATE recoverable_entries
       SET lifecycle_state=@previousState, claim_token=NULL, claim_expires_at=NULL
       WHERE id=@id AND workspace_id=@workspaceId AND claim_token=@claimToken
       RETURNING *`,
    )
    .get(input);
  return row ? rowToEntry(row) : undefined;
}

/** RECREATING -> FAILED, fenced (§8). */
export function setFailed(db: Database.Database, input: FencedInput): RecoverableEntry | undefined {
  const row = db
    .prepare<FencedInput, EntryRow>(
      `UPDATE recoverable_entries
       SET lifecycle_state='FAILED', claim_token=NULL, claim_expires_at=NULL
       WHERE id=@id AND workspace_id=@workspaceId AND claim_token=@claimToken
       RETURNING *`,
    )
    .get(input);
  return row ? rowToEntry(row) : undefined;
}

/** RECREATING -> AMBIGUOUS, fenced (§8). */
export function setAmbiguous(
  db: Database.Database,
  input: FencedInput,
): RecoverableEntry | undefined {
  const row = db
    .prepare<FencedInput, EntryRow>(
      `UPDATE recoverable_entries
       SET lifecycle_state='AMBIGUOUS', claim_token=NULL, claim_expires_at=NULL
       WHERE id=@id AND workspace_id=@workspaceId AND claim_token=@claimToken
       RETURNING *`,
    )
    .get(input);
  return row ? rowToEntry(row) : undefined;
}

/** AMBIGUOUS -> RECREATED on a reconcile adoption or explicit resolve-ambiguous (§8). Guarded by
 * the partial unique index on `(workspace_id, new_entry_id)`; a conflict throws SqliteError with
 * code SQLITE_CONSTRAINT_UNIQUE, which the caller maps to 409 (double-adoption guard). */
export function adopt(
  db: Database.Database,
  input: { id: string; workspaceId: string; newEntryId: string; recreatedAt: string; recreatedBy: string },
): RecoverableEntry | undefined {
  const row = db
    .prepare<Record<string, unknown>, EntryRow>(
      `UPDATE recoverable_entries
       SET lifecycle_state='RECREATED', new_entry_id=@newEntryId, recreated_at=@recreatedAt,
           recreated_by=@recreatedBy
       WHERE id=@id AND workspace_id=@workspaceId AND lifecycle_state='AMBIGUOUS'
       RETURNING *`,
    )
    .get(input);
  return row ? rowToEntry(row) : undefined;
}

/** AMBIGUOUS -> IDLE, user confirms "not created" (§8). */
export function markNotCreated(
  db: Database.Database,
  workspaceId: string,
  id: string,
): RecoverableEntry | undefined {
  const row = db
    .prepare<[string, string], EntryRow>(
      `UPDATE recoverable_entries SET lifecycle_state='IDLE'
       WHERE id = ? AND workspace_id = ? AND lifecycle_state='AMBIGUOUS'
       RETURNING *`,
    )
    .get(id, workspaceId);
  return row ? rowToEntry(row) : undefined;
}

/** IDLE/FAILED -> DISMISSED (docs/06 lifecycle table). */
export function dismiss(
  db: Database.Database,
  workspaceId: string,
  id: string,
): RecoverableEntry | undefined {
  const row = db
    .prepare<[string, string], EntryRow>(
      `UPDATE recoverable_entries SET lifecycle_state='DISMISSED'
       WHERE id = ? AND workspace_id = ? AND lifecycle_state IN ('IDLE','FAILED')
       RETURNING *`,
    )
    .get(id, workspaceId);
  return row ? rowToEntry(row) : undefined;
}

/** DISMISSED -> IDLE. A genuine duplicate delivery must not resurrect a dismissed row on its
 * own (W10) — only an explicit undismiss does. */
export function undismiss(
  db: Database.Database,
  workspaceId: string,
  id: string,
): RecoverableEntry | undefined {
  const row = db
    .prepare<[string, string], EntryRow>(
      `UPDATE recoverable_entries SET lifecycle_state='IDLE'
       WHERE id = ? AND workspace_id = ? AND lifecycle_state='DISMISSED'
       RETURNING *`,
    )
    .get(id, workspaceId);
  return row ? rowToEntry(row) : undefined;
}
