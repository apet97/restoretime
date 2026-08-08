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
  vi.useRealTimers();
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

/** Mirrors RECONCILE_THROTTLE_MS in src/api/routes.ts. */
const RECONCILE_THROTTLE_MS = 30_000;

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
    // ADR-007 / docs/07 §8: "Reconcile immediately once, then lazily." The create's response was
    // lost, so the first check runs inside the recreate call — before the user does anything. It
    // finds nothing yet (the committed entry is not visible to this stub), so the row stays
    // AMBIGUOUS, which is the truthful state.
    expect((recreateResponse.body as { entry: { lifecycleState: string } }).entry.lifecycleState).toBe("AMBIGUOUS");

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

    // Move past the 30 s reconcile throttle the immediate check just consumed. Without this the
    // detail view would correctly decline to re-check, and the test would be asserting the
    // throttle rather than the adoption.
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(new Date(Date.now() + RECONCILE_THROTTLE_MS + 1_000));

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

// --- Route-level guards on the confirm path -------------------------------------------------
//
// These exercise `POST /api/entries/recreate` through the router, not the store helpers, because
// the failure modes below are all in the route's own sequencing: claim, consume, baseline, create.
describe("POST /api/entries/recreate — guards", () => {
  async function seedAndPlan(server: Awaited<ReturnType<typeof boot>>, token: string) {
    const webhookToken = await signTestToken(keys.privateKey, ADDON_KEY, { workspaceId: WORKSPACE_ID, addonId: ADDON_ID });
    await install(server, webhookToken);
    await server.addon.handle(
      createTestWebhookRequest(webhookToken, "TIME_ENTRY_DELETED", deletedEntryBody(), { path: "/webhooks/time-entry-deleted" }),
    );
    const listResponse = await server.addon.handle({ method: "GET", path: "/api/entries", headers: { authorization: `Bearer ${token}` } });
    const entryId = (listResponse.body as { entries: Array<{ id: string }> }).entries[0]!.id;
    const preflightResponse = await server.addon.handle({
      method: "POST",
      path: "/api/entries/preflight",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: { entryId },
    });
    const planId = (preflightResponse.body as { plan: { id: string } }).plan.id;
    return { entryId, planId };
  }

  // The baseline read runs after the claim is won and the plan consumed, but before the create.
  // Hitting the page bound there must surface the documented message and hand the row back — not
  // return a bare 500 and leave the entry stuck in RECREATING for the whole lease.
  it("a page-bound baseline read releases the claim and reports the documented reason", async () => {
    vi.stubGlobal("fetch", baseStub());
    const server = await boot();
    const token = await componentToken();
    const { entryId, planId } = await seedAndPlan(server, token);

    // Every page of the owner's entry list comes back full, so the walk can only stop at the bound.
    vi.stubGlobal(
      "fetch",
      (async (input: string | URL | Request, init?: RequestInit) => {
        const path = pathOf(input);
        const method = methodOf(input, init);
        if (method === "GET" && path.endsWith("/time-entries") && path.includes("/user/")) {
          return jsonResponse(
            Array.from({ length: 200 }, (_, i) => ({
              id: `filler-${i}`,
              description: "hello",
              billable: true,
              timeInterval: { start: "2026-01-01T00:00:00Z", end: "2026-01-01T01:00:00Z" },
              userId: OWNER_ID,
              workspaceId: WORKSPACE_ID,
            })),
          );
        }
        return baseStub()(input, init);
      }) as typeof fetch,
    );

    const response = await server.addon.handle({
      method: "POST",
      path: "/api/entries/recreate",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: { entryId, planId },
    });

    expect(response.status).toBe(503);
    expect((response.body as { error: string }).error).toBe("workspace too large to verify; try again");

    const row = server.db
      .prepare("SELECT lifecycle_state, claim_token FROM recoverable_entries WHERE id = ?")
      .get(entryId) as { lifecycle_state: string; claim_token: string | null };
    expect(row.lifecycle_state).toBe("IDLE");
    expect(row.claim_token).toBeNull();
    // docs/08 invariant 4: no attempt row, because nothing was attempted.
    const attemptCount = server.db
      .prepare("SELECT COUNT(*) AS n FROM recreation_attempts WHERE recoverable_entry_id = ?")
      .get(entryId) as { n: number };
    expect(attemptCount.n).toBe(0);
  });

  // IT-03 at the route level (the store-level race lives in claim.test.ts): two confirms of the
  // same plan must not both reach Clockify.
  it("two concurrent confirms produce exactly one create", async () => {
    let creates = 0;
    vi.stubGlobal(
      "fetch",
      (async (input: string | URL | Request, init?: RequestInit) => {
        const path = pathOf(input);
        const method = methodOf(input, init);
        if (method === "GET" && path.endsWith("/time-entries") && path.includes("/user/")) return jsonResponse([]);
        if (method === "POST" && path.endsWith("/time-entries")) {
          creates += 1;
          return jsonResponse({
            id: "new-entry-1",
            description: "hello",
            billable: true,
            timeInterval: { start: "2026-08-08T10:00:00Z", end: "2026-08-08T11:00:00Z" },
            userId: OWNER_ID,
            workspaceId: WORKSPACE_ID,
          }, 201);
        }
        if (method === "GET" && path.includes("/time-entries/")) {
          return jsonResponse({
            id: "new-entry-1",
            description: "hello",
            billable: true,
            timeInterval: { start: "2026-08-08T10:00:00Z", end: "2026-08-08T11:00:00Z" },
            userId: OWNER_ID,
            workspaceId: WORKSPACE_ID,
          });
        }
        return baseStub()(input, init);
      }) as typeof fetch,
    );
    const server = await boot();
    const token = await componentToken();
    const { entryId, planId } = await seedAndPlan(server, token);

    const confirm = () =>
      server.addon.handle({
        method: "POST",
        path: "/api/entries/recreate",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: { entryId, planId },
      });
    const [a, b] = await Promise.all([confirm(), confirm()]);

    expect(creates).toBe(1);
    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual([200, 409]);
  });
});

// A truncated reconcile saw a partial list, so it is not evidence about anything. Counting it
// toward the mark-not-created gate would let three bound-hitting checks license the user to
// declare "not created" about an entry that exists — and then recreate it a second time.
describe("POST /api/entries/reconcile — a truncated check is not a check", () => {
  it("does not increment the reconcile check count", async () => {
    vi.stubGlobal("fetch", baseStub());
    const server = await boot();
    const token = await componentToken();
    const webhookToken = await signTestToken(keys.privateKey, ADDON_KEY, { workspaceId: WORKSPACE_ID, addonId: ADDON_ID });
    await install(server, webhookToken);
    await server.addon.handle(
      createTestWebhookRequest(webhookToken, "TIME_ENTRY_DELETED", deletedEntryBody(), { path: "/webhooks/time-entry-deleted" }),
    );

    const listResponse = await server.addon.handle({ method: "GET", path: "/api/entries", headers: { authorization: `Bearer ${token}` } });
    const entryId = (listResponse.body as { entries: Array<{ id: string }> }).entries[0]!.id;
    const preflightResponse = await server.addon.handle({
      method: "POST",
      path: "/api/entries/preflight",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: { entryId },
    });
    const plan = (preflightResponse.body as { plan: { id: string } }).plan;

    // Put the row in AMBIGUOUS with an attempt, the state reconcile operates on.
    server.db.prepare("UPDATE recoverable_entries SET lifecycle_state='AMBIGUOUS' WHERE id=?").run(entryId);
    server.db
      .prepare(
        `INSERT INTO recreation_attempts (id, plan_id, recoverable_entry_id, started_at, outcome, baseline_json)
         VALUES ('att-1', ?, ?, '2026-08-08T10:00:00Z', 'AMBIGUOUS', '[]')`,
      )
      .run(plan.id, entryId);

    vi.stubGlobal(
      "fetch",
      (async (input: string | URL | Request, init?: RequestInit) => {
        const path = pathOf(input);
        const method = methodOf(input, init);
        if (method === "GET" && path.endsWith("/time-entries") && path.includes("/user/")) {
          return jsonResponse(
            Array.from({ length: 200 }, (_, i) => ({
              id: `filler-${i}`,
              description: "hello",
              billable: true,
              timeInterval: { start: "2026-01-01T00:00:00Z", end: "2026-01-01T01:00:00Z" },
              userId: OWNER_ID,
              workspaceId: WORKSPACE_ID,
            })),
          );
        }
        return baseStub()(input, init);
      }) as typeof fetch,
    );

    const response = await server.addon.handle({
      method: "POST",
      path: "/api/entries/reconcile",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: { entryId },
    });
    expect(response.status).toBe(200);
    expect((response.body as { result: { kind: string } }).result.kind).toBe("truncated");

    const row = server.db.prepare("SELECT reconcile_json FROM recreation_attempts WHERE id='att-1'").get() as {
      reconcile_json: string;
    };
    const summary = JSON.parse(row.reconcile_json) as { checks: number; truncated: boolean };
    expect(summary.truncated).toBe(true);
    expect(summary.checks).toBe(0);

    // And the row is still AMBIGUOUS — a bound-hitting read never concludes anything.
    const entryRow = server.db.prepare("SELECT lifecycle_state FROM recoverable_entries WHERE id=?").get(entryId) as {
      lifecycle_state: string;
    };
    expect(entryRow.lifecycle_state).toBe("AMBIGUOUS");
  });
});

// docs/10 §8 says a disabled addon replaces actions with a notice, and docs/00 says the UI never
// decides what a user may do — so the server must refuse the actions too. A viewer already on the
// confirm screen when the addon is disabled must not be able to complete a recreation.
describe("a disabled installation refuses actions but stays readable", () => {
  it("blocks recreate and dismiss with 409 while list and detail still work", async () => {
    vi.stubGlobal("fetch", baseStub());
    const server = await boot();
    const token = await componentToken();
    const webhookToken = await signTestToken(keys.privateKey, ADDON_KEY, { workspaceId: WORKSPACE_ID, addonId: ADDON_ID });
    await install(server, webhookToken);
    await server.addon.handle(
      createTestWebhookRequest(webhookToken, "TIME_ENTRY_DELETED", deletedEntryBody(), { path: "/webhooks/time-entry-deleted" }),
    );

    const listBefore = await server.addon.handle({ method: "GET", path: "/api/entries", headers: { authorization: `Bearer ${token}` } });
    const entryId = (listBefore.body as { entries: Array<{ id: string }> }).entries[0]!.id;
    const preflightResponse = await server.addon.handle({
      method: "POST",
      path: "/api/entries/preflight",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: { entryId },
    });
    const planId = (preflightResponse.body as { plan: { id: string } }).plan.id;

    // The workspace disables the addon while the viewer sits on the confirm screen.
    const statusToken = await signTestToken(keys.privateKey, ADDON_KEY, { workspaceId: WORKSPACE_ID, addonId: ADDON_ID });
    const statusResponse = await server.addon.handle(
      createTestLifecycleRequest(
        statusToken,
        { workspaceId: WORKSPACE_ID, addonId: ADDON_ID, status: "INACTIVE" },
        { path: "/lifecycle/status-changed" },
      ),
    );
    expect(statusResponse.status).toBe(204);

    for (const path of ["/api/entries/recreate", "/api/entries/dismiss"]) {
      const blocked = await server.addon.handle({
        method: "POST",
        path,
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: { entryId, planId },
      });
      expect(blocked.status).toBe(409);
      expect((blocked.body as { error: string }).error).toBe("RestoreTime is disabled for this workspace.");
    }

    // Lists stay readable, and say so.
    const listAfter = await server.addon.handle({ method: "GET", path: "/api/entries", headers: { authorization: `Bearer ${token}` } });
    expect(listAfter.status).toBe(200);
    expect((listAfter.body as { disabled: boolean }).disabled).toBe(true);
    const detail = await server.addon.handle({
      method: "GET",
      path: "/api/entries/detail",
      query: new URLSearchParams({ id: entryId }),
      headers: { authorization: `Bearer ${token}` },
    });
    expect(detail.status).toBe(200);

    // Nothing was recreated.
    const row = server.db.prepare("SELECT lifecycle_state FROM recoverable_entries WHERE id=?").get(entryId) as { lifecycle_state: string };
    expect(row.lifecycle_state).toBe("IDLE");
  });
});
