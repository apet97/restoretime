// Uninstall cascade (docs/08 "Retention and deletion", AGENTS.md rule 14). PASS-02 adds
// recoverable_entries, recreation_plans, and recreation_attempts; this function will delete every
// row for the workspace from those tables, in the same transaction as the installation row
// delete. No domain tables exist yet, so it is a no-op — wired now so the DELETED lifecycle path
// does not need rewiring later, and so its call site is tested from PASS-01 on.

import type Database from "better-sqlite3";

export function deleteWorkspaceDomainData(_db: Database.Database, _workspaceId: string): void {
  // Intentionally empty until PASS-02 adds domain tables.
}
