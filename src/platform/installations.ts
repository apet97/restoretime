// ClockifyInstallationStore over SQLite (docs/08 "installations" table). This is the *raw*,
// unencrypted store: server.ts wraps it with wrapClockifyInstallationStoreWithEncryption before
// use. Generation-guard semantics mirror the SDK's InMemoryClockifyInstallationStore exactly
// (clockify-installation-store.ts): save skips when the existing row is strictly newer; delete
// with a mismatched installedAt returns "stale"; delete with no installedAt is unconditional.

import type Database from "better-sqlite3";
import type { webcrypto } from "node:crypto";
import type {
  ClockifyInstallationContext,
  ClockifyInstallationDeleteInput,
  ClockifyInstallationDeleteResult,
  ClockifyInstallationStore,
  ClockifyLifecycleWebhookToken,
} from "@apet97/clockify-addon-sdk/clockify";

type InstallationStatus = "ACTIVE" | "INACTIVE";

interface InstallationRow {
  workspace_id: string;
  addon_id: string;
  addon_user_id: string;
  as_user: string;
  api_url: string;
  auth_token: string;
  webhooks_json: string | null;
  status: InstallationStatus;
  installed_at: number;
}

/**
 * Live INSTALLED payloads can carry a webhook path like "//webhooks/time-entry-deleted" (Clockify
 * joins baseUrl + "/" + path — evidence/install-capture-2026-08-08.md, W17). This reduces an
 * absolute http(s) URL to its pathname, collapses repeated slashes, and drops a trailing slash,
 * so that storage and lookup agree on one key.
 *
 * The function is idempotent, and both sides normalize: writes normalize before storing, and the
 * lookup in `server.ts` normalizes again before comparing. That is deliberate, not redundant — a
 * row written by an older build stays findable.
 *
 * The absolute-URL branch is gated on an explicit `http(s)://` prefix. `new URL("webhooks:x")`
 * parses "webhooks" as a scheme and would otherwise reduce that path to "/x".
 */
export function normalizeWebhookPath(path: string): string {
  let pathname = path;
  if (/^https?:\/\//i.test(path)) {
    try {
      pathname = new URL(path).pathname;
    } catch {
      // Not a parseable URL after all — keep the raw string.
    }
  }
  const collapsed = `/${pathname.replace(/^\/+/, "")}`.replace(/\/{2,}/g, "/");
  return collapsed.length > 1 ? collapsed.replace(/\/+$/, "") : collapsed;
}

function rowToContext(row: InstallationRow): ClockifyInstallationContext {
  return {
    workspaceId: row.workspace_id,
    addonId: row.addon_id,
    addonUserId: row.addon_user_id,
    asUser: row.as_user,
    apiUrl: row.api_url,
    authToken: row.auth_token,
    installedAt: row.installed_at,
    ...(row.webhooks_json === null
      ? {}
      : { webhooks: JSON.parse(row.webhooks_json) as ClockifyLifecycleWebhookToken[] }),
  };
}

/**
 * Raw (unencrypted) ClockifyInstallationStore implementation over `better-sqlite3`.
 *
 * Unlike the SDK's `InMemoryClockifyInstallationStore`, this store does not validate the context
 * it is handed. It is never used directly: `server.ts` always composes it under
 * `wrapClockifyInstallationStoreWithEncryption`, and the SDK's own AES-GCM codec rejects an empty
 * token before a row is written. Use the composed store, not this one.
 */
export function createSqliteInstallationStore(db: Database.Database): ClockifyInstallationStore {
  const select = db.prepare<[string, string], InstallationRow>(
    "SELECT * FROM installations WHERE workspace_id = ? AND addon_id = ?",
  );
  const upsert = db.prepare<{
    workspaceId: string;
    addonId: string;
    addonUserId: string;
    asUser: string;
    apiUrl: string;
    authToken: string;
    webhooksJson: string | null;
    installedAt: number;
  }>(`
    INSERT INTO installations
      (workspace_id, addon_id, addon_user_id, as_user, api_url, auth_token, webhooks_json, installed_at)
    VALUES
      (@workspaceId, @addonId, @addonUserId, @asUser, @apiUrl, @authToken, @webhooksJson, @installedAt)
    ON CONFLICT (workspace_id, addon_id) DO UPDATE SET
      addon_user_id = excluded.addon_user_id,
      as_user       = excluded.as_user,
      api_url       = excluded.api_url,
      auth_token    = excluded.auth_token,
      webhooks_json = excluded.webhooks_json,
      installed_at  = excluded.installed_at,
      -- A reinstall carries a fresh token, so whatever made the old one broken is resolved.
      broken_at     = NULL
  `);
  // status is deliberately absent from the DO UPDATE SET list above: it never travels through
  // ClockifyInstallationContext (the SDK contract has no status field), so a redelivered
  // INSTALLED payload must not silently revert a status the STATUS_CHANGED lifecycle already set.
  const del = db.prepare<[string, string]>(
    "DELETE FROM installations WHERE workspace_id = ? AND addon_id = ?",
  );

  return {
    async load(workspaceId: string, addonId: string): Promise<ClockifyInstallationContext | null> {
      const row = select.get(workspaceId, addonId);
      return row ? rowToContext(row) : null;
    },

    async save(context: ClockifyInstallationContext): Promise<void> {
      const existing = select.get(context.workspaceId, context.addonId);
      // Generation guard: skip only when the existing row is strictly newer.
      if (existing && existing.installed_at > context.installedAt) return;

      const webhooksJson =
        context.webhooks === undefined
          ? null
          : JSON.stringify(
              context.webhooks.map((webhook) => ({
                path: normalizeWebhookPath(webhook.path),
                webhookType: webhook.webhookType,
                authToken: webhook.authToken,
              })),
            );
      upsert.run({
        workspaceId: context.workspaceId,
        addonId: context.addonId,
        addonUserId: context.addonUserId,
        asUser: context.asUser,
        apiUrl: context.apiUrl,
        authToken: context.authToken,
        webhooksJson,
        installedAt: context.installedAt,
      });
    },

    async delete(
      input: ClockifyInstallationDeleteInput,
    ): Promise<ClockifyInstallationDeleteResult> {
      const existing = select.get(input.workspaceId, input.addonId);
      if (!existing) return "missing";
      if (input.installedAt !== undefined && input.installedAt !== existing.installed_at) {
        return "stale";
      }
      del.run(input.workspaceId, input.addonId);
      return "deleted";
    },
  };
}

/**
 * Records that Clockify rejected this installation's token (401 body code "4017", R11). Kept
 * apart from `status`: a user disabling the addon and a token going bad are different conditions
 * with different remedies (docs/14 — "reinstall replaces the installation row"; docs/10 §8 shows
 * a different notice for each). Returns whether a row was updated.
 */
export function markInstallationBroken(
  db: Database.Database,
  workspaceId: string,
  addonId: string,
  at: string,
): boolean {
  const result = db
    .prepare(
      "UPDATE installations SET broken_at = ? WHERE workspace_id = ? AND addon_id = ? AND broken_at IS NULL",
    )
    .run(at, workspaceId, addonId);
  return result.changes > 0;
}

/** STATUS_CHANGED is a separate write path: `status` has no place in ClockifyInstallationContext,
 * so it never goes through `ClockifyInstallationStore.save`. Returns whether a row was updated —
 * zero rows means the installation is gone, which the caller reports instead of logging a
 * status change that did not happen. */
export function updateInstallationStatus(
  db: Database.Database,
  workspaceId: string,
  addonId: string,
  status: InstallationStatus,
): boolean {
  const result = db
    .prepare("UPDATE installations SET status = ? WHERE workspace_id = ? AND addon_id = ?")
    .run(status, workspaceId, addonId);
  return result.changes > 0;
}

/** Reads the installation's `status` column (docs/10 §8 "disabled addon" notice). Not part of
 * `ClockifyInstallationContext` — see the comment on `upsert` above — so the component route reads
 * it directly rather than through `ClockifyInstallationStore.load`. Returns `undefined` when there
 * is no row (never installed, or uninstalled — the notice does not apply to either). */
export function getInstallationStatus(
  db: Database.Database,
  workspaceId: string,
  addonId: string,
): InstallationStatus | undefined {
  const row = db
    .prepare<[string, string], { status: InstallationStatus }>(
      "SELECT status FROM installations WHERE workspace_id = ? AND addon_id = ?",
    )
    .get(workspaceId, addonId);
  return row?.status;
}

/** Imports the 32-byte AES-256-GCM token-encryption key from its hex env-var encoding. */
export async function importTokenEncryptionKey(hex: string): Promise<webcrypto.CryptoKey> {
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
    throw new Error("TOKEN_ENCRYPTION_KEY must be 64 hex characters (32 bytes).");
  }
  const bytes = Buffer.from(hex, "hex");
  return globalThis.crypto.subtle.importKey("raw", bytes, "AES-GCM", false, [
    "encrypt",
    "decrypt",
  ]);
}
