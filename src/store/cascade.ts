// Installation-generation cleanup (docs/08 "Retention and deletion", AGENTS.md rule 14).
//
// Both operations key on `(workspace_id, addon_id)` — one installation lifetime — never on
// `workspace_id` alone. Clockify issues a fresh `addonId` per install, so a workspace can hold
// rows from more than one generation, and a workspace-wide delete would let a delayed lifecycle
// event for an old generation erase the current one's recovery data.
//
// Deleting these rows never needs the SDK's AES-GCM codec: a DELETE touches no ciphertext. So
// this writes the raw `installations` table directly instead of going through the async
// `wrapClockifyInstallationStoreWithEncryption` store — that is what makes a single synchronous
// better-sqlite3 transaction possible (the wrapped store's `delete()` is async; better-sqlite3
// transactions are not). `recreation_plans` and `recreation_attempts` cascade automatically via
// `ON DELETE CASCADE` (migration 0002) when `recoverable_entries` rows are removed.

import type Database from "better-sqlite3";
import type { InstallationScope } from "../domain/entry.js";

/** `stale`: no installation row matched. The event belongs to a generation this app no longer
 * holds — already uninstalled, or already superseded by a later install. Its own rows are still
 * purged (they can only be leftovers from that same generation), but nothing else is touched. */
export type UninstallResult = "deleted" | "stale";

/** Records a generation as retired, in the caller's transaction. Idempotent: a second DELETED for
 * the same generation, or a supersede of one already recorded, changes nothing. */
function retire(db: Database.Database, workspaceId: string, addonId: string): void {
  db.prepare(
    "INSERT OR IGNORE INTO retired_installations (workspace_id, addon_id, retired_at) VALUES (?, ?, ?)",
  ).run(workspaceId, addonId, new Date().toISOString());
}

/**
 * Whether this generation has already been retired here.
 *
 * Lifecycle tokens carry no expiry, so a delayed or replayed INSTALLED for a long-gone generation
 * can arrive at any time and cannot be ordered against the current one. Treating such an event as
 * proof that the *current* generation is obsolete would destroy live data — the mirror of a stale
 * DELETED. The installation itself is still saved when this returns true; only the destructive
 * half is skipped, so a workspace can never be left unable to install.
 */
export function isRetiredInstallation(db: Database.Database, scope: InstallationScope): boolean {
  return db
    .prepare("SELECT 1 FROM retired_installations WHERE workspace_id = ? AND addon_id = ?")
    .get(scope.workspaceId, scope.addonId) !== undefined;
}

/** DELETED lifecycle. Purges exactly the addressed generation, in one transaction. */
export function uninstallInstallation(
  db: Database.Database,
  scope: InstallationScope,
): UninstallResult {
  const run = db.transaction((ws: string, addon: string): UninstallResult => {
    const existing = db
      .prepare("SELECT 1 FROM installations WHERE workspace_id = ? AND addon_id = ?")
      .get(ws, addon);
    retire(db, ws, addon);
    db.prepare("DELETE FROM recoverable_entries WHERE workspace_id = ? AND addon_id = ?").run(ws, addon);
    db.prepare("DELETE FROM installations WHERE workspace_id = ? AND addon_id = ?").run(ws, addon);
    return existing ? "deleted" : "stale";
  });
  return run.immediate(scope.workspaceId, scope.addonId);
}

export interface SupersedeResult {
  readonly installations: number;
  readonly entries: number;
}

/**
 * INSTALLED lifecycle. Removes every *other* generation of this add-on in the workspace.
 *
 * Clockify allows one installation of an add-on per workspace at a time, so a payload carrying a
 * new `addonId` proves the previous generation was removed there — whether or not its DELETED
 * event ever reached this app. Without this, a missed DELETED leaves the old generation's deleted
 * entries in storage forever, unreachable through every route yet still retaining user data.
 *
 * Call this only with a verified INSTALLED identity that {@link isRetiredInstallation} rejects,
 * after the new installation row is saved. A replayed INSTALLED for an already-retired generation
 * is not evidence that anything else is obsolete.
 */
export function supersedeOtherInstallations(
  db: Database.Database,
  scope: InstallationScope,
): SupersedeResult {
  const run = db.transaction((ws: string, addon: string): SupersedeResult => {
    const superseded = db
      .prepare<[string, string], { addon_id: string }>(
        "SELECT addon_id FROM installations WHERE workspace_id = ? AND addon_id <> ?",
      )
      .all(ws, addon);
    for (const row of superseded) retire(db, ws, row.addon_id);
    const entries = db
      .prepare("DELETE FROM recoverable_entries WHERE workspace_id = ? AND addon_id <> ?")
      .run(ws, addon).changes;
    const installations = db
      .prepare("DELETE FROM installations WHERE workspace_id = ? AND addon_id <> ?")
      .run(ws, addon).changes;
    return { installations, entries };
  });
  return run.immediate(scope.workspaceId, scope.addonId);
}
