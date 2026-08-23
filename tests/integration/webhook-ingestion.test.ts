// IT-01, IT-02, IT-10 (docs/13). Real SQLite temp file, driven through the full addon HTTP
// surface (server.ts) with SDK test-signing helpers.
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
import { createServer } from "../../src/server.js";
import * as entries from "../../src/store/entries.js";
import type { AppConfig } from "../../src/config.js";

const ADDON_KEY = "restoretime-test";
const WORKSPACE_ID = "ws-1";
const ADDON_ID = "addon-install-1";
const SCOPE = { workspaceId: WORKSPACE_ID, addonId: ADDON_ID };

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

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "restoretime-webhook-it-"));
  keys = await generateTestKeys();
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

async function boot() {
  return createServer(testConfig(), { publicKey: keys.publicKey });
}

function validBody(overrides: Record<string, unknown> = {}) {
  return {
    id: "entry-a",
    workspaceId: WORKSPACE_ID,
    userId: "user-1",
    description: "hello",
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
    ...overrides,
  };
}

async function install(server: Awaited<ReturnType<typeof boot>>, webhookToken: string) {
  const installToken = await signTestToken(keys.privateKey, ADDON_KEY, {
    workspaceId: WORKSPACE_ID,
    addonId: ADDON_ID,
  });
  await server.addon.handle(
    createTestLifecycleRequest(
      installToken,
      buildInstalledPayload({
        workspaceId: WORKSPACE_ID,
        addonId: ADDON_ID,
        webhooks: [{ path: "/webhooks/time-entry-deleted", webhookType: "ADDON", authToken: webhookToken }],
      }),
      { path: "/lifecycle/installed" },
    ),
  );
}

describe("IT-01 duplicate webhook delivery", () => {
  it("produces exactly one row; both deliveries ack 204", async () => {
    const server = await boot();
    const webhookToken = await signTestToken(keys.privateKey, ADDON_KEY, {
      workspaceId: WORKSPACE_ID,
      addonId: ADDON_ID,
    });
    await install(server, webhookToken);

    const first = await server.addon.handle(
      createTestWebhookRequest(webhookToken, "TIME_ENTRY_DELETED", validBody(), {
        path: "/webhooks/time-entry-deleted",
      }),
    );
    // A retry after non-2xx carries a byte-identical body with a NEW idempotency-key (W10); the
    // dedup key is payload id + event type, never the delivery header.
    const second = await server.addon.handle(
      createTestWebhookRequest(webhookToken, "TIME_ENTRY_DELETED", validBody(), {
        path: "/webhooks/time-entry-deleted",
      }),
    );

    expect(first.status).toBe(204);
    expect(second.status).toBe(204);
    const count = server.db
      .prepare("SELECT COUNT(*) AS n FROM recoverable_entries WHERE workspace_id = ? AND source_entry_id = ?")
      .get(WORKSPACE_ID, "entry-a") as { n: number };
    expect(count.n).toBe(1);
  });
});

describe("IT-06 recreated entry deleted -> new row with parent link", () => {
  it("a webhook for the recreated entry's own id links back to the original row", async () => {
    const server = await boot();
    const webhookToken = await signTestToken(keys.privateKey, ADDON_KEY, {
      workspaceId: WORKSPACE_ID,
      addonId: ADDON_ID,
    });
    await install(server, webhookToken);

    const first = await server.addon.handle(
      createTestWebhookRequest(webhookToken, "TIME_ENTRY_DELETED", validBody(), {
        path: "/webhooks/time-entry-deleted",
      }),
    );
    expect(first.status).toBe(204);
    const original = server.db
      .prepare("SELECT id FROM recoverable_entries WHERE workspace_id = ? AND source_entry_id = ?")
      .get(WORKSPACE_ID, "entry-a") as { id: string };

    // Simulate a completed recreation (the mutation pipeline is exercised end-to-end in
    // tests/integration/mutation.test.ts and api-walkthrough.test.ts; this test isolates the
    // lineage-link behavior of the webhook handler itself).
    server.db
      .prepare("UPDATE recoverable_entries SET lifecycle_state='RECREATED', new_entry_id='new-entry-x' WHERE id=?")
      .run(original.id);

    // The new Clockify entry is later deleted too — its own TIME_ENTRY_DELETED webhook arrives.
    const second = await server.addon.handle(
      createTestWebhookRequest(
        webhookToken,
        "TIME_ENTRY_DELETED",
        validBody({ id: "new-entry-x", description: "recreated entry, now deleted itself" }),
        { path: "/webhooks/time-entry-deleted" },
      ),
    );
    expect(second.status).toBe(204);

    const childRow = server.db
      .prepare("SELECT id, parent_recoverable_id FROM recoverable_entries WHERE workspace_id = ? AND source_entry_id = ?")
      .get(WORKSPACE_ID, "new-entry-x") as { id: string; parent_recoverable_id: string | null };
    expect(childRow.parent_recoverable_id).toBe(original.id);
  });
});

describe("IT-02 wrong webhook token / unknown installation", () => {
  it("a wrong token is rejected 401 with no row", async () => {
    const server = await boot();
    const storedToken = await signTestToken(keys.privateKey, ADDON_KEY, {
      workspaceId: WORKSPACE_ID,
      addonId: ADDON_ID,
    });
    await install(server, storedToken);

    const wrongToken = await signTestToken(keys.privateKey, ADDON_KEY, {
      workspaceId: WORKSPACE_ID,
      addonId: ADDON_ID,
      nonce: "different",
    });
    const response = await server.addon.handle(
      createTestWebhookRequest(wrongToken, "TIME_ENTRY_DELETED", validBody(), {
        path: "/webhooks/time-entry-deleted",
      }),
    );
    expect(response.status).toBe(401);
    const count = server.db.prepare("SELECT COUNT(*) AS n FROM recoverable_entries").get() as {
      n: number;
    };
    expect(count.n).toBe(0);
  });

  it("an unknown installation is rejected 401 with no row", async () => {
    const server = await boot();
    const token = await signTestToken(keys.privateKey, ADDON_KEY, {
      workspaceId: WORKSPACE_ID,
      addonId: ADDON_ID,
    });
    const response = await server.addon.handle(
      createTestWebhookRequest(token, "TIME_ENTRY_DELETED", validBody(), {
        path: "/webhooks/time-entry-deleted",
      }),
    );
    expect(response.status).toBe(401);
    const count = server.db.prepare("SELECT COUNT(*) AS n FROM recoverable_entries").get() as {
      n: number;
    };
    expect(count.n).toBe(0);
  });
});

describe("IT-09 forged workspace identity in the webhook body", () => {
  it("a body workspaceId that does not match the verified claims is rejected 400, no row", async () => {
    const server = await boot();
    const webhookToken = await signTestToken(keys.privateKey, ADDON_KEY, {
      workspaceId: WORKSPACE_ID,
      addonId: ADDON_ID,
    });
    await install(server, webhookToken);

    const response = await server.addon.handle(
      createTestWebhookRequest(
        webhookToken,
        "TIME_ENTRY_DELETED",
        validBody({ workspaceId: "forged-workspace" }),
        { path: "/webhooks/time-entry-deleted" },
      ),
    );
    expect(response.status).toBe(400);
    const count = server.db.prepare("SELECT COUNT(*) AS n FROM recoverable_entries").get() as {
      n: number;
    };
    expect(count.n).toBe(0);
  });

  it("when the body workspaceId matches, the persisted row carries the verified claims workspaceId", async () => {
    const server = await boot();
    const webhookToken = await signTestToken(keys.privateKey, ADDON_KEY, {
      workspaceId: WORKSPACE_ID,
      addonId: ADDON_ID,
    });
    await install(server, webhookToken);

    await server.addon.handle(
      createTestWebhookRequest(webhookToken, "TIME_ENTRY_DELETED", validBody(), {
        path: "/webhooks/time-entry-deleted",
      }),
    );
    const row = server.db
      .prepare("SELECT workspace_id FROM recoverable_entries WHERE source_entry_id = ?")
      .get("entry-a") as { workspace_id: string };
    expect(row.workspace_id).toBe(WORKSPACE_ID);
  });
});

describe("IT-10 dismissed entry absorbs redelivery", () => {
  it("a duplicate delivery after dismissal does not resurrect the row", async () => {
    const server = await boot();
    const webhookToken = await signTestToken(keys.privateKey, ADDON_KEY, {
      workspaceId: WORKSPACE_ID,
      addonId: ADDON_ID,
    });
    await install(server, webhookToken);

    await server.addon.handle(
      createTestWebhookRequest(webhookToken, "TIME_ENTRY_DELETED", validBody(), {
        path: "/webhooks/time-entry-deleted",
      }),
    );
    const row = server.db
      .prepare("SELECT id FROM recoverable_entries WHERE workspace_id = ? AND source_entry_id = ?")
      .get(WORKSPACE_ID, "entry-a") as { id: string };
    const dismissed = entries.dismiss(server.db, SCOPE, row.id);
    expect(dismissed?.lifecycleState).toBe("DISMISSED");

    // Redelivery (W10) — must be an insert-ignore no-op, never resurrecting the row.
    const redelivery = await server.addon.handle(
      createTestWebhookRequest(webhookToken, "TIME_ENTRY_DELETED", validBody(), {
        path: "/webhooks/time-entry-deleted",
      }),
    );
    expect(redelivery.status).toBe(204);

    const current = entries.getById(server.db, SCOPE, row.id);
    expect(current?.lifecycleState).toBe("DISMISSED");
  });
});
