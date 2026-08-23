// TIME_ENTRY_DELETED body handling (docs/03 §1). The SDK verification wiring (RS256 JWT,
// per-installation webhook token lookup) stays in server.ts, the proven wiring reference
// (tools/install-capture/server.mjs); this module is the pure guard -> normalize -> scope
// match -> persist step.

import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { guardDeletedEntryPayload, normalizeDeletedEntry } from "./deleted-entry.js";
import { ingestDeletedEntry } from "../store/entries.js";
import type { InstallationScope } from "../domain/entry.js";

export interface WebhookHandlingResult {
  readonly status: number;
  readonly body?: string;
  /** Set only on a 204. `inserted` is a new row (`recoverable_created`); `duplicate` found an
   * existing one and was a no-op (W10); `installation-gone` means the fenced insert refused the
   * write because the installation was uninstalled while this delivery was being verified. Each
   * is a different metric — docs/14. */
  readonly outcome?: "inserted" | "duplicate" | "installation-gone";
}

/** Ack only after the row is persisted, or after the fence has proved that no row may be persisted
 * (2xx-after-persist, W10). Ingestion is installation-status-independent: called for INACTIVE
 * installations too (docs/03 §1). */
export function handleDeletedEntryWebhook(
  db: Database.Database,
  body: unknown,
  scope: InstallationScope,
): WebhookHandlingResult {
  const guarded = guardDeletedEntryPayload(body);
  if (!guarded.ok) return { status: 400, body: `invalid webhook body: ${guarded.reason}` };

  // The SDK verifies signature and the stored per-installation token but never compares the body
  // to the claims (docs/03 §1). A mismatch is rejected here; the row always stores the verified
  // workspace, never the body's.
  if (guarded.payload.workspaceId !== scope.workspaceId) {
    return { status: 400, body: "workspaceId does not match the verified installation" };
  }

  const normalized = normalizeDeletedEntry(guarded.payload);
  const source = { ...normalized, workspaceId: scope.workspaceId };

  const result = ingestDeletedEntry(db, {
    id: randomUUID(),
    scope,
    sourceEntryId: source.entryId,
    ownerId: source.ownerId,
    detectedAt: new Date().toISOString(),
    source,
  });

  // 204 for `installation-gone` too: the delivery was valid and a retry cannot make it succeed,
  // because the installation it belongs to no longer exists. Reporting an error would only spend
  // Clockify's retry budget on a write this app must never perform.
  return { status: 204, outcome: result.kind };
}
