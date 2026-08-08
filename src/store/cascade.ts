// Uninstall cascade (docs/08 "Retention and deletion", AGENTS.md rule 14). Hard-deletes the
// installation row and every workspace row across the three domain tables in ONE transaction.
//
// Deleting an installation row never needs the SDK's AES-GCM codec: a DELETE keyed by
// (workspace_id, addon_id) touches no ciphertext, it only removes a row. So this writes the raw
// `installations` table directly instead of going through the async
// `wrapClockifyInstallationStoreWithEncryption` store — that is what makes a single synchronous
// better-sqlite3 transaction possible (the wrapped store's `delete()` is async; better-sqlite3
// transactions are not). `recreation_plans` and `recreation_attempts` cascade automatically via
// `ON DELETE CASCADE` (migration 0002) when `recoverable_entries` rows are removed.

import type Database from "better-sqlite3";

export type UninstallResult = "deleted" | "missing";

export function uninstallWorkspace(
  db: Database.Database,
  workspaceId: string,
  addonId: string,
): UninstallResult {
  const run = db.transaction((ws: string, aid: string): UninstallResult => {
    const existing = db
      .prepare("SELECT 1 FROM installations WHERE workspace_id = ? AND addon_id = ?")
      .get(ws, aid);
    db.prepare("DELETE FROM recoverable_entries WHERE workspace_id = ?").run(ws);
    db.prepare("DELETE FROM installations WHERE workspace_id = ? AND addon_id = ?").run(ws, aid);
    return existing ? "deleted" : "missing";
  });
  return run(workspaceId, addonId);
}
