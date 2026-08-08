// Completion criteria (PASS-02-recovery-engine.md): a scripted walkthrough driving
// webhook -> list -> preflight -> confirm -> RECREATED, and the AMBIGUOUS flow, against the full
// `/api/*` HTTP surface with a mocked Clockify transport. `globalThis.fetch` is stubbed for the
// duration of each test (routes.ts builds its Clockify client via `buildClockifyClient`, which
// defaults to `globalThis.fetch` — the same "stub fetch, real SDK" contract as tests/integration/
// mutation.test.ts, just injected at the global boundary because the route layer, not the test,
// owns client construction).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildInstalledPayload,
  createTestComponentRequest,
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
  dir = mkdtempSync(join(tmpdir(), "restoretime-walkthrough-"));
  keys = await generateTestKeys();
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  vi.unstubAllGlobals();
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function pathOf(input: string | URL | Request): string {
  const raw = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
  return new URL(raw).pathname;
}

function methodOf(input: string | URL | Request, init?: RequestInit): string {
  return (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
}

async function boot() {
  return createServer(testConfig(), { publicKey: keys.publicKey });
}

async function componentToken(role = "admin", user = OWNER_ID) {
  return signTestToken(keys.privateKey, ADDON_KEY, {
    workspaceId: WORKSPACE_ID,
    addonId: ADDON_ID,
    user,
    workspaceRole: role,
  });
}

async function install(server: Awaited<ReturnType<typeof boot>>, webhookToken: string) {
  const installToken = await signTestToken(keys.privateKey, ADDON_KEY, { workspaceId: WORKSPACE_ID, addonId: ADDON_ID });
  await server.addon.handle(
    createTestLifecycleRequest(
      installToken,
      buildInstalledPayload({
        workspaceId: WORKSPACE_ID,
        addonId: ADDON_ID,
        apiUrl: "https://developer.clockify.me/api",
        webhooks: [{ path: "/webhooks/time-entry-deleted", webhookType: "ADDON", authToken: webhookToken }],
      }),
      { path: "/lifecycle/installed" },
    ),
  );
}

function deletedEntryBody(overrides: Record<string, unknown> = {}) {
  return {
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
    ...overrides,
  };
}

function baseStub(): typeof fetch {
  return async (input, init) => {
    const path = pathOf(input);
    const method = methodOf(input, init);
    if (method === "GET" && /\/workspaces\/[^/]+$/.test(path)) return jsonResponse({ id: WORKSPACE_ID, workspaceSettings: {} });
    if (method === "GET" && path.endsWith("/users")) return jsonResponse([{ id: OWNER_ID, email: "a@b.com", name: "User One", status: "ACTIVE" }]);
    if (method === "GET" && path.endsWith("/tags")) return jsonResponse([]);
    if (method === "GET" && path.endsWith("/custom-fields")) return jsonResponse([]);
    return jsonResponse({ message: "unstubbed", code: 0 }, 404);
  };
}

describe("scripted walkthrough: webhook -> list -> preflight -> confirm -> RECREATED", () => {
  it("drives the full success path", async () => {
    const server = await boot();
    const webhookToken = await signTestToken(keys.privateKey, ADDON_KEY, { workspaceId: WORKSPACE_ID, addonId: ADDON_ID });
    await install(server, webhookToken);

    const webhookResponse = await server.addon.handle(
      createTestWebhookRequest(webhookToken, "TIME_ENTRY_DELETED", deletedEntryBody(), { path: "/webhooks/time-entry-deleted" }),
    );
    expect(webhookResponse.status).toBe(204);

    vi.stubGlobal(
      "fetch",
      (async (input: string | URL | Request, init?: RequestInit) => {
        const path = pathOf(input);
        const method = methodOf(input, init);
        if (method === "GET" && path.endsWith("/time-entries") && path.includes("/user/")) return jsonResponse([]); // baseline: empty
        if (method === "POST" && path.endsWith("/time-entries")) {
          return jsonResponse(
            {
              id: "new-entry-1",
              workspaceId: WORKSPACE_ID,
              userId: OWNER_ID,
              description: "hello",
              billable: true,
              isLocked: false,
              tagIds: [],
              type: "REGULAR",
              timeInterval: { start: "2026-08-08T10:00:00Z", end: "2026-08-08T11:00:00Z" },
            },
            201,
          );
        }
        if (method === "GET" && path.includes("/time-entries/new-entry-1")) {
          return jsonResponse({
            id: "new-entry-1",
            workspaceId: WORKSPACE_ID,
            userId: OWNER_ID,
            description: "hello",
            billable: true,
            isLocked: false,
            tagIds: [],
            type: "REGULAR",
            timeInterval: { start: "2026-08-08T10:00:00Z", end: "2026-08-08T11:00:00Z" },
          });
        }
        return baseStub()(input, init);
      }) as typeof fetch,
    );

    const token = await componentToken();

    const listResponse = await server.addon.handle({
      method: "GET",
      path: "/api/entries",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(listResponse.status).toBe(200);
    const listBody = listResponse.body as { entries: Array<{ id: string; sourceEntryId: string; preflightSummary: unknown }> };
    expect(listBody.entries).toHaveLength(1);
    const entryId = listBody.entries[0]!.id;
    expect(listBody.entries[0]!.sourceEntryId).toBe("entry-a");
    expect(listBody.entries[0]!.preflightSummary).toEqual({ fidelity: "FULL", blockerCount: 0, actionRequiredCount: 0 });

    const preflightResponse = await server.addon.handle({
      method: "POST",
      path: "/api/entries/preflight",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: { entryId },
    });
    expect(preflightResponse.status).toBe(200);
    const preflightBody = preflightResponse.body as { plan: { id: string; fidelity: string; blockers: unknown[] } };
    expect(preflightBody.plan.fidelity).toBe("FULL");
    expect(preflightBody.plan.blockers).toHaveLength(0);
    const planId = preflightBody.plan.id;

    const recreateResponse = await server.addon.handle({
      method: "POST",
      path: "/api/entries/recreate",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: { entryId, planId },
    });
    expect(recreateResponse.status).toBe(200);
    const recreateBody = recreateResponse.body as { result: { outcome: string; newEntryId: string } };
    expect(recreateBody.result.outcome).toBe("RECREATED");
    expect(recreateBody.result.newEntryId).toBe("new-entry-1");

    const detailResponse = await server.addon.handle({
      method: "GET",
      path: "/api/entries/detail",
      query: new URLSearchParams({ id: entryId }),
      headers: { authorization: `Bearer ${token}` },
    });
    expect(detailResponse.status).toBe(200);
    const detailBody = detailResponse.body as { entry: { lifecycleState: string; newEntryId: string } };
    expect(detailBody.entry.lifecycleState).toBe("RECREATED");
    expect(detailBody.entry.newEntryId).toBe("new-entry-1");
  });
});

describe("scripted walkthrough: AMBIGUOUS -> reconcile adopts -> RECREATED", () => {
  it("drives the ambiguity protocol through the API surface", async () => {
    const server = await boot();
    const webhookToken = await signTestToken(keys.privateKey, ADDON_KEY, { workspaceId: WORKSPACE_ID, addonId: ADDON_ID });
    await install(server, webhookToken);
    await server.addon.handle(
      createTestWebhookRequest(webhookToken, "TIME_ENTRY_DELETED", deletedEntryBody(), { path: "/webhooks/time-entry-deleted" }),
    );

    const committedEntry = {
      id: "new-entry-2",
      workspaceId: WORKSPACE_ID,
      userId: OWNER_ID,
      description: "hello",
      billable: true,
      isLocked: false,
      tagIds: [],
      type: "REGULAR",
      timeInterval: { start: "2026-08-08T10:00:00Z", end: "2026-08-08T11:00:00Z" },
    };

    vi.stubGlobal(
      "fetch",
      (async (input: string | URL | Request, init?: RequestInit) => {
        const path = pathOf(input);
        const method = methodOf(input, init);
        if (method === "GET" && path.endsWith("/time-entries") && path.includes("/user/")) return jsonResponse([]); // baseline: empty
        if (method === "POST" && path.endsWith("/time-entries")) {
          // Simulates a lost response: the create genuinely fails at the transport layer, with
          // no HTTP response — ClockifyApiError.statusCode === undefined -> AMBIGUOUS (docs/03 §3).
          throw new TypeError("simulated connection reset");
        }
        return baseStub()(input, init);
      }) as typeof fetch,
    );

    const token = await componentToken();
    const listResponse = await server.addon.handle({ method: "GET", path: "/api/entries", headers: { authorization: `Bearer ${token}` } });
    const entryId = (listResponse.body as { entries: Array<{ id: string }> }).entries[0]!.id;

    const preflightResponse = await server.addon.handle({
      method: "POST",
      path: "/api/entries/preflight",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: { entryId },
    });
    const planId = (preflightResponse.body as { plan: { id: string } }).plan.id;

    const recreateResponse = await server.addon.handle({
      method: "POST",
      path: "/api/entries/recreate",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: { entryId, planId },
    });
    expect(recreateResponse.status).toBe(200);
    expect((recreateResponse.body as { result: { outcome: string } }).result.outcome).toBe("AMBIGUOUS");

    // The Clockify entry actually committed — now findable. Re-stub, then prove the lazy
    // reconcile (ADR-010: a detail view on an AMBIGUOUS row triggers one reconcile pass) adopts
    // it — no explicit "Check now" needed.
    vi.stubGlobal(
      "fetch",
      (async (input: string | URL | Request, init?: RequestInit) => {
        const path = pathOf(input);
        const method = methodOf(input, init);
        if (method === "GET" && path.endsWith("/time-entries") && path.includes("/user/")) return jsonResponse([committedEntry]);
        return baseStub()(input, init);
      }) as typeof fetch,
    );

    const detailRecreated = await server.addon.handle({
      method: "GET",
      path: "/api/entries/detail",
      query: new URLSearchParams({ id: entryId }),
      headers: { authorization: `Bearer ${token}` },
    });
    expect(detailRecreated.status).toBe(200);
    const finalEntry = (detailRecreated.body as { entry: { lifecycleState: string; newEntryId: string } }).entry;
    expect(finalEntry.lifecycleState).toBe("RECREATED");
    expect(finalEntry.newEntryId).toBe("new-entry-2");

    // The explicit "Check now" route is throttled once a reconcile just ran (30 s window).
    const reconcileResponse = await server.addon.handle({
      method: "POST",
      path: "/api/entries/reconcile",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: { entryId },
    });
    expect(reconcileResponse.status).toBe(409); // no longer AMBIGUOUS — already adopted
  });
});

describe("policy negatives through the API surface", () => {
  it("a regular viewer never sees another user's entry in the list", async () => {
    const server = await boot();
    const webhookToken = await signTestToken(keys.privateKey, ADDON_KEY, { workspaceId: WORKSPACE_ID, addonId: ADDON_ID });
    await install(server, webhookToken);
    await server.addon.handle(
      createTestWebhookRequest(webhookToken, "TIME_ENTRY_DELETED", deletedEntryBody(), { path: "/webhooks/time-entry-deleted" }),
    );
    vi.stubGlobal("fetch", baseStub());

    const otherUserToken = await componentToken("member", "user-2");
    const response = await server.addon.handle({
      method: "GET",
      path: "/api/entries",
      headers: { authorization: `Bearer ${otherUserToken}` },
    });
    expect(response.status).toBe(200);
    expect((response.body as { entries: unknown[] }).entries).toHaveLength(0);
  });

  it("GET /component still serves the verified shell (component boundary unaffected by PASS-02)", async () => {
    const server = await boot();
    const token = await componentToken();
    const response = await server.addon.handle(createTestComponentRequest(token, { path: "/component" }));
    expect(response.status).toBe(200);
  });
});
