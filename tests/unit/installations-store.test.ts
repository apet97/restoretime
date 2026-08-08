import { beforeEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import type { ClockifyInstallationContext } from "@apet97/clockify-addon-sdk/clockify";
import { openDatabase } from "../../src/store/db.js";
import {
  createSqliteInstallationStore,
  updateInstallationStatus,
} from "../../src/platform/installations.js";

function context(overrides: Partial<ClockifyInstallationContext> = {}): ClockifyInstallationContext {
  return {
    workspaceId: "ws-1",
    addonId: "addon-1",
    addonUserId: "addon-user-1",
    asUser: "user-1",
    apiUrl: "https://developer.clockify.me/api",
    authToken: "secret-token",
    installedAt: 1000,
    ...overrides,
  };
}

// Store-level generation-guard tests (docs/08, pass file "Tests"): these exercise the raw
// ClockifyInstallationStore directly, never through a lifecycle payload.
describe("createSqliteInstallationStore — generation guard", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = openDatabase(":memory:");
  });

  it("save persists a new row and load round-trips it", async () => {
    const store = createSqliteInstallationStore(db);
    await store.save(context());
    const loaded = await store.load("ws-1", "addon-1");
    expect(loaded).toEqual(context());
  });

  it("save skips when the existing row is strictly newer", async () => {
    const store = createSqliteInstallationStore(db);
    await store.save(context({ installedAt: 2000, authToken: "newer" }));
    await store.save(context({ installedAt: 1000, authToken: "older" }));
    const loaded = await store.load("ws-1", "addon-1");
    expect(loaded?.authToken).toBe("newer");
    expect(loaded?.installedAt).toBe(2000);
  });

  it("save overwrites when installedAt is equal (not strictly newer)", async () => {
    const store = createSqliteInstallationStore(db);
    await store.save(context({ installedAt: 1000, authToken: "first" }));
    await store.save(context({ installedAt: 1000, authToken: "second" }));
    const loaded = await store.load("ws-1", "addon-1");
    expect(loaded?.authToken).toBe("second");
  });

  it("save overwrites when the incoming context is newer", async () => {
    const store = createSqliteInstallationStore(db);
    await store.save(context({ installedAt: 1000, authToken: "first" }));
    await store.save(context({ installedAt: 2000, authToken: "second" }));
    const loaded = await store.load("ws-1", "addon-1");
    expect(loaded?.authToken).toBe("second");
  });

  it("load returns null for an unknown installation", async () => {
    const store = createSqliteInstallationStore(db);
    expect(await store.load("nope", "nope")).toBeNull();
  });

  it("delete with a mismatched installedAt returns stale and keeps the row", async () => {
    const store = createSqliteInstallationStore(db);
    await store.save(context({ installedAt: 1000 }));
    const result = await store.delete({ workspaceId: "ws-1", addonId: "addon-1", installedAt: 999 });
    expect(result).toBe("stale");
    expect(await store.load("ws-1", "addon-1")).not.toBeNull();
  });

  it("delete with no installedAt is unconditional", async () => {
    const store = createSqliteInstallationStore(db);
    await store.save(context({ installedAt: 1000 }));
    const result = await store.delete({ workspaceId: "ws-1", addonId: "addon-1" });
    expect(result).toBe("deleted");
    expect(await store.load("ws-1", "addon-1")).toBeNull();
  });

  it("delete on a missing installation returns missing", async () => {
    const store = createSqliteInstallationStore(db);
    const result = await store.delete({ workspaceId: "ws-1", addonId: "addon-1" });
    expect(result).toBe("missing");
  });

  it("round-trips webhook tokens with the path normalized on write", async () => {
    const store = createSqliteInstallationStore(db);
    await store.save(
      context({
        webhooks: [
          { path: "//webhooks/time-entry-deleted", webhookType: "ADDON", authToken: "wh-token" },
        ],
      }),
    );
    const loaded = await store.load("ws-1", "addon-1");
    expect(loaded?.webhooks).toEqual([
      { path: "/webhooks/time-entry-deleted", webhookType: "ADDON", authToken: "wh-token" },
    ]);
  });

  it("distinguishes an absent webhooks key from an empty webhooks list", async () => {
    // ClockifyInstallationContext.webhooks is optional, so "no webhooks key" and "an empty list"
    // are different contexts. The SDK's in-memory store preserves the difference (docs/08 says
    // this store mirrors it), and collapsing them would silently rewrite a caller's context.
    const store = createSqliteInstallationStore(db);

    await store.save(context({ workspaceId: "ws-absent" }));
    expect(await store.load("ws-absent", "addon-1")).not.toHaveProperty("webhooks");

    await store.save(context({ workspaceId: "ws-empty", webhooks: [] }));
    expect((await store.load("ws-empty", "addon-1"))?.webhooks).toEqual([]);
  });

  it("updateInstallationStatus reports false when no installation matches", () => {
    expect(updateInstallationStatus(db, "ws-missing", "addon-1", "INACTIVE")).toBe(false);
  });

  it("a redelivered INSTALLED save does not revert a status set by STATUS_CHANGED", async () => {
    const store = createSqliteInstallationStore(db);
    await store.save(context({ installedAt: 1000 }));
    updateInstallationStatus(db, "ws-1", "addon-1", "INACTIVE");
    await store.save(context({ installedAt: 2000 }));
    const row = db
      .prepare("SELECT status FROM installations WHERE workspace_id = ? AND addon_id = ?")
      .get("ws-1", "addon-1") as { status: string };
    expect(row.status).toBe("INACTIVE");
  });
});
