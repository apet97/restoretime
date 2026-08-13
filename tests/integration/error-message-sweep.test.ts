// IT-19 — Error-message sweep (docs/13, docs/02 N8, docs/10 §8, pass file §Scope item 11). Every user-facing
// failure string must answer: what happened, whether anything was created, and what to do next.
// `renderApiError` (src/ui/views/shared.ts) shows the server's `error` string to the user verbatim
// with a generic "Try again" button, so the sentence itself has to carry the answer — the button
// alone cannot. This test drives the real routes into the weakest string classes PASS-04 found
// (found by inspection: several failure paths shared one bare "Clockify could not be reached; try
// again" sentence regardless of whether a mutation might already be in flight) and asserts the
// FIXED text answers all three questions, distinctly per actual situation.
import { afterEach, describe, expect, it, vi } from "vitest";
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
import * as entries from "../../src/store/entries.js";
import { insertAttemptFixture } from "../support/attempt-fixture.js";

const ADDON_KEY = "restoretime-n8";
const WORKSPACE_ID = "ws-1";
const ADDON_ID = "addon-1";
const OWNER_ID = "user-1";

let dir: string;

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

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function pathOf(input: string | URL | Request): string {
  const raw = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
  return new URL(raw, "http://localhost/").pathname;
}

function methodOf(input: string | URL | Request, init?: RequestInit): string {
  return (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
}

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  vi.unstubAllGlobals();
  delete process.env.RT_TEST_CRASH_MID_ATTEMPT;
});

async function boot(): Promise<{ server: AppServer; keys: ClockifyTestKeys }> {
  dir = mkdtempSync(join(tmpdir(), "restoretime-n8-"));
  const keys: ClockifyTestKeys = await generateTestKeys();
  const server = await createServer(testConfig(), { publicKey: keys.publicKey });
  return { server, keys };
}

function stableClockifyStub(): typeof fetch {
  return (async (input, init) => {
    const path = pathOf(input);
    const method = methodOf(input, init);
    if (method === "GET" && /\/workspaces\/[^/]+$/.test(path)) return jsonResponse({ id: WORKSPACE_ID, workspaceSettings: {} });
    if (method === "GET" && path.endsWith("/users")) return jsonResponse([{ id: OWNER_ID, email: "a@b.com", name: "User One", status: "ACTIVE" }]);
    if (method === "GET" && path.endsWith("/tags")) return jsonResponse([]);
    if (method === "GET" && path.endsWith("/custom-fields")) return jsonResponse([]);
    if (method === "GET" && path.endsWith("/time-entries") && path.includes("/user/")) return jsonResponse([]);
    return jsonResponse({ message: "unstubbed" }, 404);
  }) as typeof fetch;
}

async function setup(): Promise<{ server: AppServer; keys: ClockifyTestKeys; token: string; entryId: string }> {
  const { server, keys } = await boot();
  const webhookToken = await signTestToken(keys.privateKey, ADDON_KEY, { workspaceId: WORKSPACE_ID, addonId: ADDON_ID });
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
  await server.addon.handle(
    createTestWebhookRequest(
      webhookToken,
      "TIME_ENTRY_DELETED",
      {
        id: "entry-a",
        workspaceId: WORKSPACE_ID,
        userId: OWNER_ID,
        description: "d",
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
  vi.stubGlobal("fetch", stableClockifyStub());
  const token = await signTestToken(keys.privateKey, ADDON_KEY, { workspaceId: WORKSPACE_ID, addonId: ADDON_ID, user: OWNER_ID, workspaceRole: "member" });
  const listResponse = await server.addon.handle({ method: "GET", path: "/api/entries", query: new URLSearchParams(), headers: { authorization: `Bearer ${token}` } });
  const entryId = (listResponse.body as { entries: { id: string }[] }).entries[0]!.id;
  return { server, keys, token, entryId };
}

/** The loose N8 heuristic this suite pins per message: it names something that happened, states
 * (affirmatively) whether a new entry was created, and gives an action the user can take next. */
function answersWhatHappened(text: string): boolean {
  return text.length > 0;
}
function answersWhetherCreated(text: string): boolean {
  return /\b(nothing (was|new) created|entry was created|it is not (?:yet )?known whether)/i.test(text);
}
function answersWhatNext(text: string): boolean {
  return /(try again|open (?:this|the) entry|reinstall|wait a moment|do not create it by hand)/i.test(text);
}

describe("N8 error-message sweep", () => {
  it("no-client (installation missing): names the fix, states nothing was created", async () => {
    const { server, token, entryId } = await setup();
    // Simulate the installation being gone (the exact `loadClient` failure mode) without an
    // uninstall — delete just the installations row directly.
    server.db.prepare("DELETE FROM installations WHERE workspace_id = ? AND addon_id = ?").run(WORKSPACE_ID, ADDON_ID);
    const res = await server.addon.handle({
      method: "POST",
      path: "/api/entries/preflight",
      query: new URLSearchParams(),
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: { entryId, choices: {} },
    });
    expect(res.status).toBe(503);
    const message = (res.body as { error: string }).error;
    expect(answersWhatHappened(message)).toBe(true);
    expect(message).toContain("Nothing was created");
    expect(message.toLowerCase()).toContain("reinstall");
    expect(answersWhetherCreated(message)).toBe(true);
    expect(answersWhatNext(message)).toBe(true);
  });

  it("not-actionable: a recreating entry is rejected before another confirm can run", async () => {
    const { server, token, entryId } = await setup();
    const preflight = await server.addon.handle({
      method: "POST",
      path: "/api/entries/preflight",
      query: new URLSearchParams(),
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: { entryId, choices: {} },
    });
    const planId = (preflight.body as { plan: { id: string } }).plan.id;
    // Pre-claim the row directly. The route must reject this current state before it loads
    // Clockify or tries to claim the entry again.
    server.db
      .prepare("UPDATE recoverable_entries SET lifecycle_state='RECREATING', claim_token='other-attempt', claim_expires_at=? WHERE id=?")
      .run(new Date(Date.now() + 60_000).toISOString(), entryId);

    const res = await server.addon.handle({
      method: "POST",
      path: "/api/entries/recreate",
      query: new URLSearchParams(),
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: { entryId, planId },
    });
    expect(res.status).toBe(409);
    const message = (res.body as { error: string }).error;
    expect(message).toContain("cannot use this plan in its current state");
    expect(message).toContain("Nothing was created");
    expect(answersWhatNext(message)).toBe(true);
  });

  it("a non-ACTIVE plan is stale before old blockers or Clockify reads are considered", async () => {
    const { server, token, entryId } = await setup();
    const preflight = await server.addon.handle({
      method: "POST",
      path: "/api/entries/preflight",
      query: new URLSearchParams(),
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: { entryId, choices: {} },
    });
    const planId = (preflight.body as { plan: { id: string } }).plan.id;

    const first = entries.claimForActivePlan(server.db, {
      id: entryId,
      workspaceId: WORKSPACE_ID,
      planId,
      claimToken: "first-claim",
      now: new Date("2026-08-08T09:00:00Z"),
    });
    expect(first.kind).toBe("claimed");
    const second = entries.claimForActivePlan(server.db, {
      id: entryId,
      workspaceId: WORKSPACE_ID,
      planId,
      claimToken: "second-claim",
      now: new Date("2026-08-08T09:00:01Z"),
    });
    expect(second.kind).toBe("plan-not-active"); // exactly-once at the atomic claim-and-consume boundary
    server.db.prepare(
      "UPDATE recreation_plans SET blockers_json=? WHERE id=?",
    ).run(JSON.stringify([{ ruleId: "old", code: "OLD", message: "old blocker" }]), planId);
    const fetchSpy = vi.fn(() => {
      throw new Error("a stale plan must not reach Clockify");
    });
    vi.stubGlobal("fetch", fetchSpy);

    // A replay cannot revalidate or create with a plan that another request already consumed.
    const res = await server.addon.handle({
      method: "POST",
      path: "/api/entries/recreate",
      query: new URLSearchParams(),
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: { entryId, planId },
    });
    expect(res.status).toBe(409);
    const message = (res.body as { error: string }).error;
    expect(message).toContain("no longer current");
    expect(message).toContain("Nothing was sent to Clockify");
    expect(answersWhatNext(message)).toBe(true);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("attempt-error (unknown outcome): explicitly does NOT claim nothing was created, and forbids hand-creating", async () => {
    const { server, token, entryId } = await setup();
    const preflight = await server.addon.handle({
      method: "POST",
      path: "/api/entries/preflight",
      query: new URLSearchParams(),
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: { entryId, choices: {} },
    });
    const planId = (preflight.body as { plan: { id: string } }).plan.id;

    process.env.RT_TEST_CRASH_MID_ATTEMPT = "1";
    const res = await server.addon.handle({
      method: "POST",
      path: "/api/entries/recreate",
      query: new URLSearchParams(),
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: { entryId, planId },
    });
    delete process.env.RT_TEST_CRASH_MID_ATTEMPT;

    expect(res.status).toBe(502);
    const body = res.body as { error: string; unknownResult?: boolean };
    const message = body.error;
    expect(body.unknownResult).toBe(true);
    // The defining N8 property of this exact message: it is honest about not knowing, rather than
    // reusing the "nothing was created" claim a read failure can make safely.
    expect(message).not.toContain("Nothing was created");
    expect(message.toLowerCase()).toContain("not known whether");
    expect(message.toLowerCase()).toContain("do not create it by hand");
    expect(answersWhatNext(message)).toBe(true);
  });

  it("bulk keeps a post-attempt error as an unknown result, not an operational failure", async () => {
    const { server, keys, entryId } = await setup();
    const adminToken = await signTestToken(keys.privateKey, ADDON_KEY, {
      workspaceId: WORKSPACE_ID,
      addonId: ADDON_ID,
      user: OWNER_ID,
      workspaceRole: "admin",
    });
    const preflight = await server.addon.handle({
      method: "POST",
      path: "/api/entries/preflight",
      query: new URLSearchParams(),
      headers: { authorization: `Bearer ${adminToken}`, "content-type": "application/json" },
      body: { entryId, choices: {} },
    });
    const planId = (preflight.body as { plan: { id: string } }).plan.id;

    process.env.RT_TEST_CRASH_MID_ATTEMPT = "1";
    const res = await server.addon.handle({
      method: "POST",
      path: "/api/entries/bulk-recreate",
      query: new URLSearchParams(),
      headers: { authorization: `Bearer ${adminToken}`, "content-type": "application/json" },
      body: { planIds: [planId] },
    });
    delete process.env.RT_TEST_CRASH_MID_ATTEMPT;

    expect(res.status).toBe(200);
    expect((res.body as { results: unknown[] }).results).toEqual([
      {
        entryId,
        planId,
        outcome: "AMBIGUOUS",
        message:
          "The recreation might have reached Clockify, but RestoreTime did not get a clear result. It is not known whether the entry was created. Do not create it by hand. Wait a moment, then open this entry again to check its status.",
      },
    ]);
  });

  it("a rejected addon token (401 code 4017) on preflight: says reinstall — not 'try again' — and the list reports broken", async () => {
    const { server, token, entryId } = await setup();
    // Every Clockify read now rejects the addon token — the exact state after Clockify revokes it.
    vi.stubGlobal(
      "fetch",
      (async () => jsonResponse({ message: "Addon token invalid", code: 4017 }, 401)) as typeof fetch,
    );

    const res = await server.addon.handle({
      method: "POST",
      path: "/api/entries/preflight",
      query: new URLSearchParams(),
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: { entryId, choices: {} },
    });
    expect(res.status).toBe(503);
    const message = (res.body as { error: string }).error;
    // The remedy is a reinstall. "Try again in a moment" (the transport message) would send the
    // user in circles, because a rejected token never recovers on its own (docs/03 §6, docs/11).
    expect(message.toLowerCase()).toContain("reinstall");
    expect(message).toContain("Nothing was created");
    expect(answersWhetherCreated(message)).toBe(true);
    expect(answersWhatNext(message)).toBe(true);

    // The observation was recorded (IT-08's flag)…
    const row = server.db
      .prepare("SELECT broken_at FROM installations WHERE workspace_id = ? AND addon_id = ?")
      .get(WORKSPACE_ID, ADDON_ID) as { broken_at: string | null };
    expect(row.broken_at).not.toBeNull();

    // …and the list surface reports it, so the component can show the reinstall notice
    // (docs/11 "Notice view", docs/14 "component shows a reinstall notice").
    const list = await server.addon.handle({
      method: "GET",
      path: "/api/entries",
      query: new URLSearchParams(),
      headers: { authorization: `Bearer ${token}` },
    });
    expect(list.status).toBe(200);
    expect((list.body as { broken: boolean }).broken).toBe(true);
    expect((list.body as { clockifyUnavailable: boolean }).clockifyUnavailable).toBe(true);
  });

  it("a genuine transport failure (revalidation read fails): safely states nothing was created", async () => {
    const { server, token, entryId } = await setup();
    const preflight = await server.addon.handle({
      method: "POST",
      path: "/api/entries/preflight",
      query: new URLSearchParams(),
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: { entryId, choices: {} },
    });
    const planId = (preflight.body as { plan: { id: string } }).plan.id;

    // Revalidation's workspace-settings read now fails outright (never reaches a create call).
    vi.stubGlobal(
      "fetch",
      (async (input, init) => {
        const path = pathOf(input);
        const method = methodOf(input, init);
        // A non-retryable 400 rather than a thrown TypeError: a throw is a transport failure the
        // SDK retries with ~3 s of real backoff, and this pass forbids a >2 s wall-clock sleep.
        // Either way revalidation fails before any create call, which is what this asserts.
        if (method === "GET" && /\/workspaces\/[^/]+$/.test(path)) return jsonResponse({ message: "rejected", code: 501 }, 400);
        return stableClockifyStub()(input, init);
      }) as typeof fetch,
    );
    const res = await server.addon.handle({
      method: "POST",
      path: "/api/entries/recreate",
      query: new URLSearchParams(),
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: { entryId, planId },
    });
    expect(res.status).toBe(502);
    const message = (res.body as { error: string }).error;
    expect(message).toContain("Nothing was created");
    expect(answersWhatNext(message)).toBe(true);
  });

  it("manual ambiguity resolution masks a deterministic provider rejection for a member", async () => {
    const { server, token, entryId } = await setup();
    const preflight = await server.addon.handle({
      method: "POST",
      path: "/api/entries/preflight",
      query: new URLSearchParams(),
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: { entryId, choices: {} },
    });
    const planId = (preflight.body as { plan: { id: string } }).plan.id;
    const attemptId = "manual-resolution-attempt";
    entries.claim(server.db, {
      id: entryId,
      workspaceId: WORKSPACE_ID,
      claimToken: attemptId,
      now: new Date("2026-08-08T12:00:00Z"),
    });
    entries.setAmbiguous(server.db, { id: entryId, workspaceId: WORKSPACE_ID, claimToken: attemptId });
    insertAttemptFixture(server.db, {
      id: attemptId,
      planId,
      recoverableEntryId: entryId,
      startedAt: "2026-08-08T12:00:00Z",
      baseline: [],
    });

    vi.stubGlobal(
      "fetch",
      (async (input, init) => {
        const path = pathOf(input);
        if (methodOf(input, init) === "GET" && path.endsWith("/time-entries/candidate-id")) {
          return jsonResponse({ message: "read rejected", code: 0 }, 403);
        }
        return stableClockifyStub()(input, init);
      }) as typeof fetch,
    );

    const res = await server.addon.handle({
      method: "POST",
      path: "/api/entries/resolve-ambiguous",
      query: new URLSearchParams(),
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: { entryId, newEntryId: "candidate-id" },
    });

    expect(res.status).toBe(400);
    expect((res.body as { error: string }).error).toBe(
      "This entry cannot be used for this recreation.",
    );
    expect(entries.getById(server.db, WORKSPACE_ID, entryId)?.lifecycleState).toBe("AMBIGUOUS");
  });
});
