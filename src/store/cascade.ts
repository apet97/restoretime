// Uninstall cascade (docs/08 "Retention and deletion", AGENTS.md rule 14). PASS-02 adds
// recoverable_entries, recreation_plans, and recreation_attempts; this function will delete every
// row for the workspace from those tables. No domain tables exist yet, so it is a no-op — wired
// now so the DELETED lifecycle path already calls it and the call site is tested from PASS-01 on.
//
// PASS-02 must also RESTRUCTURE the DELETED handler, not only fill this body: docs/08 requires
// the installation row and the domain rows to go in ONE transaction, and the handler currently
// awaits the async encrypted store's `delete` and then calls this synchronously, which
// better-sqlite3 cannot hold inside a single transaction.

import type Database from "better-sqlite3";

export function deleteWorkspaceDomainData(_db: Database.Database, _workspaceId: string): void {
  // Intentionally empty until PASS-02 adds domain tables.
}
