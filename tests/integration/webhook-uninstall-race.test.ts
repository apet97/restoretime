// The uninstall/webhook race (src/store/entries.ts `IngestOutcome`). Webhook verification is
// asynchronous — the SDK loads the installation and decrypts its add-on token — while the uninstall
// purge is one synchronous transaction. A delivery that passed verification before the uninstall
// therefore reaches its write *after* the rows it belongs to are gone.
//
// Driven by a barrier inside `ClockifyInstallationStore.load`, never by timing: the webhook is held
// at the exact point production holds it, the uninstall runs to completion, then the webhook is
// released. `createServer` composes the store internally, so the barrier is installed through the
// `wrapInstallationStore` seam — racing a bare store would bypass the wiring under test.
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
import type { ClockifyInstallationStore } from "@apet97/clockify-addon-sdk/clockify";
import { createServer, type AppServer } from "../../src/server.js";
import type { AppConfig } from "../../src/config.js";

const ADDON_KEY = "restoretime-race";
const WORKSPACE_ID = "ws-1";
const ADDON_ID = "addon-1";
const OWNER_ID = "user-1";

let dir: string;
let keys: ClockifyTestKeys;

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
    description: "raced",
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

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "restoretime-race-"));
  keys = await generateTestKeys();
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("a webhook already in flight cannot write after uninstall", () => {
  it("holds the delivery at the token load, uninstalls, releases it, and persists nothing", async () => {
    let holdNext = false;
    let reached!: () => void;
    let release!: () => void;
    const reachedLoad = new Promise<void>((resolve) => { reached = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });

    const server: AppServer = await createServer(testConfig(), {
      publicKey: keys.publicKey,
      wrapInstallationStore: (store: ClockifyInstallationStore): ClockifyInstallationStore => ({
        ...store,
        async load(workspaceId, addonId) {
          // Read (and decrypt) exactly as production does, *then* pause. The context this
          // delivery holds from here on is the one an uninstall is about to invalidate.
          const loaded = await store.load(workspaceId, addonId);
          if (holdNext) {
            holdNext = false;
            reached();
            await gate;
          }
          return loaded;
        },
      }),
    });

    const lifecycleToken = await signTestToken(keys.privateKey, ADDON_KEY, {
      workspaceId: WORKSPACE_ID,
      addonId: ADDON_ID,
    });
    const webhookToken = await signTestToken(keys.privateKey, ADDON_KEY, {
      workspaceId: WORKSPACE_ID,
      addonId: ADDON_ID,
    });
    await server.addon.handle(
      createTestLifecycleRequest(
        lifecycleToken,
        buildInstalledPayload({
          workspaceId: WORKSPACE_ID,
          addonId: ADDON_ID,
          apiUrl: "https://developer.clockify.me/api",
          webhooks: [{ path: "/webhooks/time-entry-deleted", webhookType: "ADDON", authToken: webhookToken }],
        }),
        { path: "/lifecycle/installed" },
      ),
    );

    // 1. The webhook starts and blocks after loading its token.
    holdNext = true;
    const delivery = server.addon.handle(
      createTestWebhookRequest(webhookToken, "TIME_ENTRY_DELETED", deletedEntryBody("entry-raced"), {
        path: "/webhooks/time-entry-deleted",
      }),
    );
    await reachedLoad;

    // 2. The uninstall completes while the delivery is still in flight.
    await server.addon.handle(
      createTestLifecycleRequest(
        lifecycleToken,
        { workspaceId: WORKSPACE_ID, addonId: ADDON_ID, asUser: OWNER_ID },
        { path: "/lifecycle/deleted" },
      ),
    );
    expect(await server.installations.load(WORKSPACE_ID, ADDON_ID)).toBeNull();

    // 3. The delivery resumes and reaches its write.
    release();
    const response = await delivery;

    // Acknowledged rather than failed: the delivery was valid, and no retry could make it
    // succeed. But the database must end with no row — uninstall means deleted.
    expect(response.status).toBe(204);
    expect(
      server.db.prepare("SELECT COUNT(*) AS n FROM recoverable_entries").get() as { n: number },
    ).toEqual({ n: 0 });
    expect(
      server.db.prepare("SELECT COUNT(*) AS n FROM installations").get() as { n: number },
    ).toEqual({ n: 0 });
    server.db.close();
  });
});
