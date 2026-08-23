// Shared installation-generation fixture. `ingestDeletedEntry` is fenced on an installation row
// existing (src/store/entries.ts `IngestOutcome`), so any test that ingests must seed one first —
// which is the point: an entry that belongs to no installation is exactly what the fence rejects.

import type Database from "better-sqlite3";
import type { InstallationScope, RecoverableEntry } from "../../src/domain/entry.js";
import { ingestDeletedEntry, type IngestInput } from "../../src/store/entries.js";

export const TEST_WORKSPACE_ID = "ws-1";
export const TEST_ADDON_ID = "addon-install-1";

/** The scope every fixture below installs into, unless a test names its own. */
export const TEST_SCOPE: InstallationScope = {
  workspaceId: TEST_WORKSPACE_ID,
  addonId: TEST_ADDON_ID,
};

/**
 * Inserts a raw `installations` row. Deliberately not routed through the encrypted store: these
 * tests never read the token back, and a synchronous insert keeps their setup free of `await`.
 */
export function seedInstallation(
  db: Database.Database,
  scope: InstallationScope = TEST_SCOPE,
  installedAt = 1_000,
): InstallationScope {
  db.prepare(
    `INSERT OR REPLACE INTO installations
       (workspace_id, addon_id, addon_user_id, as_user, api_url, auth_token, installed_at)
     VALUES (?, ?, 'addon-user-1', 'user-1', 'https://developer.clockify.me/api', 'tok', ?)`,
  ).run(scope.workspaceId, scope.addonId, installedAt);
  return scope;
}

/**
 * Ingests one deleted entry and fails loudly if the generation fence rejected it. Returns the
 * pre-fence shape so a test that only cares about the row reads unchanged; a test that is *about*
 * the fence calls `ingestDeletedEntry` directly and inspects the outcome.
 */
export function ingestEntry(
  db: Database.Database,
  input: IngestInput,
): { inserted: boolean; entry: RecoverableEntry } {
  const result = ingestDeletedEntry(db, input);
  if (result.kind === "installation-gone") {
    throw new Error(
      `no installation for ${input.scope.workspaceId}/${input.scope.addonId} — call seedInstallation() first`,
    );
  }
  return { inserted: result.kind === "inserted", entry: result.entry };
}
