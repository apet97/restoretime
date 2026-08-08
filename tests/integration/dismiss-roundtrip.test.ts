// The dismiss lifecycle, end to end over `/api/*`.
//
// docs/06 §lifecycle: IDLE/FAILED --dismiss--> DISMISSED --undismiss--> IDLE, and a dismissed row is
// "hidden from default lists". Until now `/api/entries/dismiss` was only touched by
// permission-negatives (a 403 path) and one auth loop in api-walkthrough — nothing proved a
// *successful* dismiss changes what the list returns. That mattered: the UI had no dismiss action
// at all, so no E2E or browser pass could reach this either (docs/10 §2's "Show dismissed" toggle
// had nothing to show). This test pins the contract the new detail-view action depends on.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
import type { AppConfig } from "../../src/config.js";

const ADDON_KEY = "restoretime-test";
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

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "restoretime-dismiss-"));
  keys = await generateTestKeys();
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  vi.unstubAllGlobals();
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

/** Preflight reads only; this test never recreates. */
function baseStub(): typeof fetch {
  return async (input) => {
    const path = new URL(typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url).pathname;
    if (/\/workspaces\/[^/]+$/.test(path)) return jsonResponse({ id: WORKSPACE_ID, workspaceSettings: {} });
    if (path.endsWith("/users")) return jsonResponse([{ id: OWNER_ID, email: "a@b.com", name: "User One", status: "ACTIVE" }]);
    return jsonResponse([]);
  };
}

async function seedOneEntry() {
  const server = await createServer(testConfig(), { publicKey: keys.publicKey });
  const lifecycleToken = await signTestToken(keys.privateKey, ADDON_KEY, { workspaceId: WORKSPACE_ID, addonId: ADDON_ID });
  await server.addon.handle(
    createTestLifecycleRequest(
      lifecycleToken,
      buildInstalledPayload({
        workspaceId: WORKSPACE_ID,
        addonId: ADDON_ID,
        apiUrl: "https://developer.clockify.me/api",
        webhooks: [{ path: "/webhooks/time-entry-deleted", webhookType: "ADDON", authToken: lifecycleToken }],
      }),
      { path: "/lifecycle/installed" },
    ),
  );
  await server.addon.handle(
    createTestWebhookRequest(
      lifecycleToken,
      "TIME_ENTRY_DELETED",
      {
        id: "entry-a",
        workspaceId: WORKSPACE_ID,
        userId: OWNER_ID,
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
      },
      { path: "/webhooks/time-entry-deleted" },
    ),
  );
  vi.stubGlobal("fetch", baseStub());
  const token = await signTestToken(keys.privateKey, ADDON_KEY, {
    workspaceId: WORKSPACE_ID,
    addonId: ADDON_ID,
    user: OWNER_ID,
    workspaceRole: "admin",
  });
  return { server, token };
}

type Server = Awaited<ReturnType<typeof seedOneEntry>>["server"];

async function listIds(server: Server, token: string, query?: Record<string, string>): Promise<string[]> {
  const response = await server.addon.handle({
    method: "GET",
    path: "/api/entries",
    headers: { authorization: `Bearer ${token}` },
    ...(query ? { query: new URLSearchParams(query) } : {}),
  });
  expect(response.status).toBe(200);
  return (response.body as { entries: { id: string }[] }).entries.map((e) => e.id);
}

function post(server: Server, token: string, path: string, entryId: string) {
  return server.addon.handle({
    method: "POST",
    path,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: { entryId },
  });
}

describe("dismiss and undismiss change what the list returns (docs/06 lifecycle)", () => {
  it("hides a dismissed entry from the default list and reveals it under dismissed=true", async () => {
    const { server, token } = await seedOneEntry();
    const [entryId] = await listIds(server, token);
    expect(entryId).toBeDefined();

    expect((await post(server, token, "/api/entries/dismiss", entryId!)).status).toBe(204);

    // The whole point of the state: gone from the default list...
    expect(await listIds(server, token)).toEqual([]);
    // ...but still there, and findable, behind the "Show dismissed" toggle (docs/10 §2).
    expect(await listIds(server, token, { dismissed: "true" })).toEqual([entryId]);

    expect((await post(server, token, "/api/entries/undismiss", entryId!)).status).toBe(204);
    expect(await listIds(server, token)).toEqual([entryId]);
    expect(await listIds(server, token, { dismissed: "true" })).toEqual([]);
  });

  it("refuses to dismiss twice — the second call is a 409, not a silent no-op", async () => {
    const { server, token } = await seedOneEntry();
    const [entryId] = await listIds(server, token);
    expect((await post(server, token, "/api/entries/dismiss", entryId!)).status).toBe(204);
    expect((await post(server, token, "/api/entries/dismiss", entryId!)).status).toBe(409);
  });

  it("refuses to undismiss an entry that is not dismissed", async () => {
    const { server, token } = await seedOneEntry();
    const [entryId] = await listIds(server, token);
    expect((await post(server, token, "/api/entries/undismiss", entryId!)).status).toBe(409);
  });
});
