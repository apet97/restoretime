// TIME_ENTRY_DELETED body handling (docs/03 §1). The SDK verification wiring (RS256 JWT,
// per-installation webhook token lookup) stays in server.ts, the proven wiring reference
// (tools/install-capture/server.mjs); this module is the pure guard -> normalize -> workspace
// match -> persist step that PASS-01 left as a 500 stub.

import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { guardDeletedEntryPayload, normalizeDeletedEntry } from "./deleted-entry.js";
import { ingestDeletedEntry } from "../store/entries.js";

export interface WebhookHandlingResult {
  readonly status: number;
  readonly body?: string;
}

/** Ack only after the row is persisted (2xx-after-persist, W10). Ingestion is
 * installation-status-independent: called for INACTIVE installations too (docs/03 §1). */
export function handleDeletedEntryWebhook(
  db: Database.Database,
  body: unknown,
  claims: { readonly workspaceId: string },
): WebhookHandlingResult {
  const guarded = guardDeletedEntryPayload(body);
  if (!guarded.ok) return { status: 400, body: `invalid webhook body: ${guarded.reason}` };

  // The SDK verifies signature and the stored per-installation token but never compares the body
  // to the claims (docs/03 §1). A mismatch is rejected here; the row always stores
  // claims.workspaceId, never the body's.
  if (guarded.payload.workspaceId !== claims.workspaceId) {
    return { status: 400, body: "workspaceId does not match the verified installation" };
  }

  const normalized = normalizeDeletedEntry(guarded.payload);
  const source = { ...normalized, workspaceId: claims.workspaceId };

  ingestDeletedEntry(db, {
    id: randomUUID(),
    workspaceId: claims.workspaceId,
    sourceEntryId: source.entryId,
    ownerId: source.ownerId,
    detectedAt: new Date().toISOString(),
    source,
  });

  return { status: 204 };
}
