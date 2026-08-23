// A reinstall is a new installation generation, not a continuation of the old one. Clockify issues
// a fresh `addonId` per install, so the two share a workspace but nothing else: the new generation
// must not list, act on, or deduplicate against rows the old one captured, and installing must not
// leave the old generation's data behind when its DELETED never arrived (src/store/cascade.ts).
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildInstalledPayload,
  createTestLifecycleRequest,
  createTestWebhookRequest,
  generateTestKeys,
  signTestToken,
  type ClockifyTestKeys,
} from "@apet97/clockify-addon-sdk/testing";
import { createServer, type AppServer } from "../../src/server.js";
import type { AppConfig } from "../../src/config.js";

const ADDON_KEY = "restoretime-generation";
const WORKSPACE_ID = "ws-1";
const OWNER_ID = "user-1";
const SOURCE_ENTRY_ID = "entry-shared";

let dir: string;
let keys: ClockifyTestKeys;
let server: AppServer;

function testConfig(): AppConfig {
  return {
    port: 0,
    publicBaseUrl: "https://addon.example.invalid",
    clockifyParentOrigin: "https://app.clockify.me",
    databasePath: join(dir, "restoretime.sqlite"),
    addonKey: ADDON_KEY,
    tokenEncryptionKeyHex: "00".repeat(32),
    logLevel: "error",
  };
}

function deletedEntryBody(id: string) {
  return {
    id,
    workspaceId: WORKSPACE_ID,
    userId: OWNER_ID,
    description: "captured",
    billable: true,
    projectId: null,
    type: "REGULAR",
    currentlyRunning: false,
    timeInterval: { start: "2026-08-08T10:00:00Z", end: "2026-08-08T11:00:00Z", timeZone: "UTC" },
    project: null,
    task: null,
    tags: [],
    user: { name: "User One" },
    customFieldValues: [],
  };
}

/** Installs one generation and returns the webhook token bound to it. */
async function install(addonId: string): Promise<string> {
  const lifecycleToken = await signTestToken(keys.privateKey, ADDON_KEY, { workspaceId: WORKSPACE_ID, addonId });
  const webhookToken = await signTestToken(keys.privateKey, ADDON_KEY, { workspaceId: WORKSPACE_ID, addonId });
  await server.addon.handle(
    createTestLifecycleRequest(
      lifecycleToken,
      buildInstalledPayload({
        workspaceId: WORKSPACE_ID,
        addonId,
        apiUrl: "https://developer.clockify.me/api",
        webhooks: [{ path: "/webhooks/time-entry-deleted", webhookType: "ADDON", authToken: webhookToken }],
      }),
      { path: "/lifecycle/installed" },
    ),
  );
  return webhookToken;
}

async function deliver(webhookToken: string, sourceEntryId: string): Promise<number> {
  const response = await server.addon.handle(
    createTestWebhookRequest(webhookToken, "TIME_ENTRY_DELETED", deletedEntryBody(sourceEntryId), {
      path: "/webhooks/time-entry-deleted",
    }),
  );
  return response.status ?? 0;
}

async function listIds(addonId: string): Promise<string[]> {
  const token = await signTestToken(keys.privateKey, ADDON_KEY, {
    workspaceId: WORKSPACE_ID,
    addonId,
    user: OWNER_ID,
    workspaceRole: "admin",
  });
  const response = await server.addon.handle({
    method: "GET",
    path: "/api/entries",
    query: new URLSearchParams(),
    headers: { authorization: `Bearer ${token}` },
  });
  expect(response.status).toBe(200);
  return ((response.body as { entries: { sourceEntryId: string }[] }).entries).map((e) => e.sourceEntryId);
}

function rowsByGeneration(): { addon_id: string; n: number }[] {
  return server.db
    .prepare("SELECT addon_id, COUNT(*) AS n FROM recoverable_entries GROUP BY addon_id ORDER BY addon_id")
    .all() as { addon_id: string; n: number }[];
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "restoretime-generation-"));
  keys = await generateTestKeys();
  server = await createServer(testConfig(), { publicKey: keys.publicKey });
});

afterEach(() => {
  server.db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("installing a new generation supersedes the previous one", () => {
  it("purges the old generation's data when its DELETED never arrived", async () => {
    const tokenA = await install("addon-a");
    expect(await deliver(tokenA, SOURCE_ENTRY_ID)).toBe(204);
    expect(rowsByGeneration()).toEqual([{ addon_id: "addon-a", n: 1 }]);

    // The uninstall event is never delivered — the case the workspace-scoped design could not
    // recover from, because nothing else would ever remove those rows.
    await install("addon-b");

    expect(rowsByGeneration()).toEqual([]);
    expect(
      server.db.prepare("SELECT addon_id FROM installations").all(),
    ).toEqual([{ addon_id: "addon-b" }]);
  });

  it("does not let the new generation see or inherit the old generation's entries", async () => {
    const tokenA = await install("addon-a");
    await deliver(tokenA, "entry-old");
    await install("addon-b");
    expect(await listIds("addon-b")).toEqual([]);
  });

  it("lets the new generation capture the same source entry id the old one held", async () => {
    // The row is gone with its generation, so the uniqueness rule cannot be satisfied by a
    // superseded row and block a legitimate capture.
    const tokenA = await install("addon-a");
    await deliver(tokenA, SOURCE_ENTRY_ID);
    const tokenB = await install("addon-b");
    expect(await deliver(tokenB, SOURCE_ENTRY_ID)).toBe(204);
    expect(rowsByGeneration()).toEqual([{ addon_id: "addon-b", n: 1 }]);
    expect(await listIds("addon-b")).toEqual([SOURCE_ENTRY_ID]);
  });
});

describe("a lifecycle event may only mutate the generation it names", () => {
  it("acknowledges a stale DELETED for a superseded generation without touching the current one", async () => {
    const tokenA = await install("addon-a");
    await deliver(tokenA, "entry-old");
    const tokenB = await install("addon-b");
    await deliver(tokenB, "entry-new");
    expect(rowsByGeneration()).toEqual([{ addon_id: "addon-b", n: 1 }]);

    // Delayed by the platform, correctly signed, and for an identity this app no longer holds.
    const staleToken = await signTestToken(keys.privateKey, ADDON_KEY, { workspaceId: WORKSPACE_ID, addonId: "addon-a" });
    const response = await server.addon.handle(
      createTestLifecycleRequest(
        staleToken,
        { workspaceId: WORKSPACE_ID, addonId: "addon-a", asUser: OWNER_ID },
        { path: "/lifecycle/deleted" },
      ),
    );
    // 204: Clockify has nothing to retry, and the event is not actionable.
    expect(response.status).toBe(204);

    expect(rowsByGeneration()).toEqual([{ addon_id: "addon-b", n: 1 }]);
    expect(await listIds("addon-b")).toEqual(["entry-new"]);
    expect(await server.installations.load(WORKSPACE_ID, "addon-b")).not.toBeNull();
  });

  it("does not let a viewer from one generation address another generation's row", async () => {
    const tokenA = await install("addon-a");
    await deliver(tokenA, "entry-old");
    const rowId = (server.db.prepare("SELECT id FROM recoverable_entries").get() as { id: string }).id;

    // A second generation exists alongside the first only in this artificial setup; the point is
    // that the route resolves rows by the viewer's own installation, not by workspace.
    await install("addon-b");
    const token = await signTestToken(keys.privateKey, ADDON_KEY, {
      workspaceId: WORKSPACE_ID,
      addonId: "addon-b",
      user: OWNER_ID,
      workspaceRole: "admin",
    });
    const response = await server.addon.handle({
      method: "GET",
      path: "/api/entries/detail",
      query: new URLSearchParams({ id: rowId }),
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.status).toBe(404);
  });
});
