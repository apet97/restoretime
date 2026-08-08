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

export type InstallationStatus = "ACTIVE" | "INACTIVE";

interface InstallationRow {
  workspace_id: string;
  addon_id: string;
  addon_user_id: string;
  as_user: string;
  api_url: string;
  auth_token: string;
  webhooks_json: string;
  status: InstallationStatus;
  installed_at: number;
}

/**
 * Live INSTALLED payloads can carry a webhook path like "//webhooks/time-entry-deleted" (Clockify
 * joins baseUrl + "/" + path — evidence/install-capture-2026-08-08.md). Collapse repeated slashes
 * and reduce an absolute URL to its pathname so storage and lookup agree. Normalization happens
 * once, here, on write; `server.ts` compares the already-normalized stored path against the
 * webhook route constant on lookup — never normalize twice, never skip it.
 */
export function normalizeWebhookPath(path: string): string {
  let pathname = path;
  try {
    pathname = new URL(path).pathname;
  } catch {
    // Not an absolute URL — already a relative path.
  }
  return `/${pathname.replace(/^\/+/, "")}`.replace(/\/{2,}/g, "/");
}

function rowToContext(row: InstallationRow): ClockifyInstallationContext {
  const webhooks = JSON.parse(row.webhooks_json) as ClockifyLifecycleWebhookToken[];
  return {
    workspaceId: row.workspace_id,
    addonId: row.addon_id,
    addonUserId: row.addon_user_id,
    asUser: row.as_user,
    apiUrl: row.api_url,
    authToken: row.auth_token,
    installedAt: row.installed_at,
    ...(webhooks.length > 0 ? { webhooks } : {}),
  };
}

/** Raw (unencrypted) ClockifyInstallationStore implementation over `better-sqlite3`. */
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
    webhooksJson: string;
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
      installed_at  = excluded.installed_at
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

      const webhooksJson = JSON.stringify(
        (context.webhooks ?? []).map((webhook) => ({
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

/** STATUS_CHANGED is a separate write path: `status` has no place in ClockifyInstallationContext,
 * so it never goes through `ClockifyInstallationStore.save`. */
export function updateInstallationStatus(
  db: Database.Database,
  workspaceId: string,
  addonId: string,
  status: InstallationStatus,
): void {
  db.prepare(
    "UPDATE installations SET status = ? WHERE workspace_id = ? AND addon_id = ?",
  ).run(status, workspaceId, addonId);
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
