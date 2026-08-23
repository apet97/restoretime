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

/** DELETED lifecycle. Purges exactly the addressed generation, in one transaction. */
export function uninstallInstallation(
  db: Database.Database,
  scope: InstallationScope,
): UninstallResult {
  const run = db.transaction((ws: string, addon: string): UninstallResult => {
    const existing = db
      .prepare("SELECT 1 FROM installations WHERE workspace_id = ? AND addon_id = ?")
      .get(ws, addon);
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
 * Call this only with a verified INSTALLED identity, after the new installation row is saved.
 */
export function supersedeOtherInstallations(
  db: Database.Database,
  scope: InstallationScope,
): SupersedeResult {
  const run = db.transaction((ws: string, addon: string): SupersedeResult => {
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
