// IT-18 — Metrics emission (docs/13, docs/14, pass file §Scope item 10): "emit exactly the counter lines that
// document lists, at the points it lists, and nothing more." Drives one scripted flow that touches
// every documented emission point, captures stdout, and asserts the SET of distinct `metric:*`
// names emitted equals `METRIC_NAMES` exactly — the only version of this assertion that would catch
// an extra, undocumented counter as well as a missing one.
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
import { METRIC_NAMES } from "../../src/metrics.js";
import * as attempts from "../../src/store/attempts.js";

const ADDON_KEY = "restoretime-metrics";
const WORKSPACE_ID = "ws-1";
const ADDON_ID = "addon-1";
const OWNER_ID = "user-1";
const OTHER_USER_ID = "user-2";

let dir: string;
let lines: string[];
let stdoutSpy: ReturnType<typeof spyOnWrite>;

function spyOnWrite(stream: NodeJS.WriteStream, sink: string[]) {
  return vi.spyOn(stream, "write").mockImplementation((chunk: unknown) => {
    sink.push(typeof chunk === "string" ? chunk : String(chunk));
    return true;
  });
}

function testConfig(): AppConfig {
  return {
    port: 0,
    publicBaseUrl: "https://addon.example.invalid",
    clockifyParentOrigin: "https://app.clockify.me",
    databasePath: join(dir, "restoretime.sqlite"),
    addonKey: ADDON_KEY,
    tokenEncryptionKeyHex: "00".repeat(32),
    logLevel: "debug",
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

function deletedEntryBody(overrides: Record<string, unknown> = {}) {
  return {
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
    ...overrides,
  };
}

function extractMetricNames(captured: string[]): Set<string> {
  const names = new Set<string>();
  for (const chunk of captured) {
    for (const raw of chunk.split("\n")) {
      if (!raw.trim()) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        continue;
      }
      if (typeof parsed === "object" && parsed !== null && "msg" in parsed) {
        const msg = String((parsed as { msg: unknown }).msg);
        if (msg.startsWith("metric:")) names.add(msg.slice("metric:".length));
      }
    }
  }
  return names;
}

/** Maps a webhook's `id` (the Clockify source entry id) to this app's internal row id. Every
 * request in this test carries the app id, never the source id (docs/09) — this is test plumbing
 * only, mirroring what a real UI would already have from the list response. */
function rowIdFor(server: AppServer, sourceEntryId: string): string {
  const row = server.db.prepare("SELECT id FROM recoverable_entries WHERE workspace_id = ? AND source_entry_id = ?").get(WORKSPACE_ID, sourceEntryId) as { id: string } | undefined;
  if (!row) throw new Error(`no row ingested for source entry id ${sourceEntryId}`);
  return row.id;
}

afterEach(() => {
  stdoutSpy.mockRestore();
  rmSync(dir, { recursive: true, force: true });
  vi.unstubAllGlobals();
});

describe("Metrics: the emitted name set equals docs/14's list exactly", () => {
  it("one scripted flow touches every documented counter, and nothing else", async () => {
    dir = mkdtempSync(join(tmpdir(), "restoretime-metrics-"));
    const keys: ClockifyTestKeys = await generateTestKeys();
    const server: AppServer = await createServer(testConfig(), { publicKey: keys.publicKey });

    const installToken = await signTestToken(keys.privateKey, ADDON_KEY, { workspaceId: WORKSPACE_ID, addonId: ADDON_ID });
    const webhookToken = await signTestToken(keys.privateKey, ADDON_KEY, { workspaceId: WORKSPACE_ID, addonId: ADDON_ID });
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

    // Capture starts AFTER install/setup noise, right before the metric-relevant flow.
    lines = [];
    stdoutSpy = spyOnWrite(process.stdout, lines);

    // --- webhook_received, recoverable_created --------------------------------------------------
    const wh1 = await server.addon.handle(
      createTestWebhookRequest(webhookToken, "TIME_ENTRY_DELETED", deletedEntryBody({ id: "entry-ok", description: "metrics-ok" }), { path: "/webhooks/time-entry-deleted" }),
    );
    expect(wh1.status).toBe(204);

    // --- webhook_received (again), webhook_duplicate --------------------------------------------
    const wh1Again = await server.addon.handle(
      createTestWebhookRequest(webhookToken, "TIME_ENTRY_DELETED", deletedEntryBody({ id: "entry-ok", description: "metrics-ok" }), { path: "/webhooks/time-entry-deleted" }),
    );
    expect(wh1Again.status).toBe(204);

    await server.addon.handle(
      createTestWebhookRequest(webhookToken, "TIME_ENTRY_DELETED", deletedEntryBody({ id: "entry-block", description: "metrics-block", type: "BREAK" }), { path: "/webhooks/time-entry-deleted" }),
    );
    await server.addon.handle(
      createTestWebhookRequest(
        webhookToken,
        "TIME_ENTRY_DELETED",
        deletedEntryBody({ id: "entry-need", description: "metrics-need", projectId: "gone-project", project: { id: "gone-project", name: "Gone" } }),
        { path: "/webhooks/time-entry-deleted" },
      ),
    );
    await server.addon.handle(
      createTestWebhookRequest(webhookToken, "TIME_ENTRY_DELETED", deletedEntryBody({ id: "entry-fail", description: "metrics-fail" }), { path: "/webhooks/time-entry-deleted" }),
    );
    await server.addon.handle(
      createTestWebhookRequest(webhookToken, "TIME_ENTRY_DELETED", deletedEntryBody({ id: "entry-amb", description: "metrics-amb" }), { path: "/webhooks/time-entry-deleted" }),
    );

    // --- webhook_rejected: a malformed delivery (still SDK-verified, so still "received"). -------
    const rejected = await server.addon.handle(
      createTestWebhookRequest(webhookToken, "TIME_ENTRY_DELETED", { id: "entry-bad", workspaceId: WORKSPACE_ID }, { path: "/webhooks/time-entry-deleted" }),
    );
    expect(rejected.status).toBe(400);

    const baseClockify: typeof fetch = (async (input, init) => {
      const path = pathOf(input);
      const method = methodOf(input, init);
      if (method === "GET" && /\/workspaces\/[^/]+$/.test(path)) return jsonResponse({ id: WORKSPACE_ID, workspaceSettings: {} });
      if (method === "GET" && path.endsWith("/users")) return jsonResponse([{ id: OWNER_ID, email: "a@b.com", name: "User One", status: "ACTIVE" }]);
      if (method === "GET" && path.endsWith("/tags")) return jsonResponse([]);
      if (method === "GET" && path.endsWith("/custom-fields")) return jsonResponse([]);
      if (method === "GET" && path.endsWith("/projects/gone-project")) return jsonResponse({ message: "Project doesn't belong to Workspace", code: 501 }, 400);
      if (method === "GET" && path.endsWith("/time-entries") && path.includes("/user/")) return jsonResponse([]);
      return jsonResponse({ message: "unstubbed" }, 404);
    }) as typeof fetch;

    const token = await signTestToken(keys.privateKey, ADDON_KEY, { workspaceId: WORKSPACE_ID, addonId: ADDON_ID, user: OWNER_ID, workspaceRole: "member" });

    async function preflight(sourceEntryId: string) {
      return server.addon.handle({
        method: "POST",
        path: "/api/entries/preflight",
        query: new URLSearchParams(),
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: { entryId: rowIdFor(server, sourceEntryId), choices: {} },
      });
    }
    async function recreate(sourceEntryId: string, planId: string) {
      return server.addon.handle({
        method: "POST",
        path: "/api/entries/recreate",
        query: new URLSearchParams(),
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: { entryId: rowIdFor(server, sourceEntryId), planId },
      });
    }

    // --- preflight_blockers: the BREAK entry (P-TYPE). -------------------------------------------
    vi.stubGlobal("fetch", baseClockify);
    const preflightBlock = await preflight("entry-block");
    expect(preflightBlock.status).toBe(200);
    expect((preflightBlock.body as { plan: { blockers: unknown[] } }).plan.blockers.length).toBeGreaterThan(0);

    // --- preflight_action_required: the gone-project entry (P-PROJ-GONE). ------------------------
    const preflightNeed = await preflight("entry-need");
    expect(preflightNeed.status).toBe(200);
    expect((preflightNeed.body as { plan: { actionRequired: unknown[] } }).plan.actionRequired.length).toBeGreaterThan(0);

    // --- recreate_attempt, recreate_success. -------------------------------------------------------
    vi.stubGlobal(
      "fetch",
      (async (input, init) => {
        const path = pathOf(input);
        const method = methodOf(input, init);
        if (method === "POST" && path.endsWith("/time-entries")) {
          return jsonResponse({ id: "new-entry-ok", workspaceId: WORKSPACE_ID, userId: OWNER_ID, description: "metrics-ok", billable: true, tagIds: [], type: "REGULAR", timeInterval: { start: "2026-08-08T10:00:00Z", end: "2026-08-08T11:00:00Z" } }, 201);
        }
        if (method === "GET" && path.includes("/time-entries/new-entry-ok")) {
          return jsonResponse({ id: "new-entry-ok", workspaceId: WORKSPACE_ID, userId: OWNER_ID, description: "metrics-ok", billable: true, tagIds: [], type: "REGULAR", timeInterval: { start: "2026-08-08T10:00:00Z", end: "2026-08-08T11:00:00Z" } });
        }
        return baseClockify(input, init);
      }) as typeof fetch,
    );
    const preflightOk = await preflight("entry-ok");
    const planOk = (preflightOk.body as { plan: { id: string } }).plan;
    const recreateOk = await recreate("entry-ok", planOk.id);
    expect((recreateOk.body as { result: { outcome: string } }).result.outcome).toBe("RECREATED");

    // --- recreate_attempt, recreate_failed (a 4xx create rejection). -------------------------------
    vi.stubGlobal(
      "fetch",
      (async (input, init) => {
        const path = pathOf(input);
        const method = methodOf(input, init);
        if (method === "POST" && path.endsWith("/time-entries")) return jsonResponse({ message: "Validation failed", code: 501 }, 400);
        return baseClockify(input, init);
      }) as typeof fetch,
    );
    const preflightFail = await preflight("entry-fail");
    const planFail = (preflightFail.body as { plan: { id: string } }).plan;
    const recreateFail = await recreate("entry-fail", planFail.id);
    expect((recreateFail.body as { result: { outcome: string } }).result.outcome).toBe("FAILED");

    // --- recreate_attempt, recreate_ambiguous, ambiguous_adopted. ----------------------------------
    // A genuine transport failure (the fetch call itself throws, no HTTP response at all) is one of
    // the two documented AMBIGUOUS triggers (docs/03 §3: "statusCode === undefined (transport
    // failure) -> AMBIGUOUS") — deterministic and instant, unlike racing the real 30 s client
    // timeout, which this test cannot shorten (routes.ts always builds the production client).
    //
    // ADR-007 / docs/07 §8 reconciles inline once, immediately, inside the SAME confirm call — so
    // the baseline read (before the create) must return empty, and the ONE read that follows the
    // AMBIGUOUS outcome must return the committed entry, through the same endpoint. A call counter
    // distinguishes the two: there is exactly one baseline read before the create.
    let listForUserCalls = 0;
    vi.stubGlobal(
      "fetch",
      (async (input, init) => {
        const path = pathOf(input);
        const method = methodOf(input, init);
        if (method === "POST" && path.endsWith("/time-entries")) throw new TypeError("simulated network failure");
        if (method === "GET" && path.endsWith("/time-entries") && path.includes("/user/")) {
          listForUserCalls++;
          if (listForUserCalls === 1) return jsonResponse([]); // baseline: nothing existed yet
          return jsonResponse([{ id: "new-entry-amb", workspaceId: WORKSPACE_ID, userId: OWNER_ID, description: "metrics-amb", billable: true, tagIds: [], type: "REGULAR", timeInterval: { start: "2026-08-08T10:00:00Z", end: "2026-08-08T11:00:00Z" } }]);
        }
        if (method === "GET" && path.includes("/time-entries/new-entry-amb")) {
          return jsonResponse({ id: "new-entry-amb", workspaceId: WORKSPACE_ID, userId: OWNER_ID, description: "metrics-amb", billable: true, tagIds: [], type: "REGULAR", timeInterval: { start: "2026-08-08T10:00:00Z", end: "2026-08-08T11:00:00Z" } });
        }
        return baseClockify(input, init);
      }) as typeof fetch,
    );
    const preflightAmb = await preflight("entry-amb");
    const planAmb = (preflightAmb.body as { plan: { id: string } }).plan;
    const recreateAmb = await recreate("entry-amb", planAmb.id);
    // The inline reconcile already adopted it by the time this response was built (routes.ts
    // `confirmPlan` re-reads the entry after the inline reconcile and includes it in the body).
    const recreateAmbBody = recreateAmb.body as { result: { outcome: string }; entry?: { lifecycleState: string } };
    expect(recreateAmbBody.result.outcome).toBe("AMBIGUOUS");
    expect(recreateAmbBody.entry?.lifecycleState).toBe("RECREATED");

    // --- ambiguous_not_created: seed a bounded-window-eligible AMBIGUOUS row directly. The real
    // gate compares against wall-clock `Date.now()` (not an injectable clock), so this test seeds
    // the precondition (an old-enough `reconcile.checkedAt`, >= 3 checks) and then exercises the
    // real `/api/entries/mark-not-created` route on it — the route logic under test is real; only
    // the setup that gets a row into the bounded-window state is synthetic. -----------------------
    server.db
      .prepare(
        `INSERT INTO recoverable_entries (id, workspace_id, source_entry_id, owner_id, detected_at, source_json, lifecycle_state)
         VALUES ('re-notcreated', ?, 'entry-notcreated', ?, '2026-08-08T09:00:00.000Z', ?, 'AMBIGUOUS')`,
      )
      .run(
        WORKSPACE_ID,
        OWNER_ID,
        JSON.stringify({
          workspaceId: WORKSPACE_ID,
          entryId: "entry-notcreated",
          ownerId: OWNER_ID,
          ownerName: "User One",
          description: "metrics-notcreated",
          billable: true,
          start: "2026-08-08T10:00:00Z",
          end: "2026-08-08T11:00:00Z",
          wasRunning: false,
          type: "REGULAR",
          timeZone: "UTC",
          projectId: null,
          projectName: null,
          clientName: null,
          taskId: null,
          taskName: null,
          tags: [],
          customFieldValues: [],
        }),
      );
    attempts.start(server.db, { id: "att-notcreated", planId: planOk.id, recoverableEntryId: "re-notcreated", startedAt: "2026-08-08T09:01:00.000Z", baseline: [] });
    attempts.updateReconcile(server.db, "att-notcreated", {
      checkedAt: new Date(Date.now() - 11 * 60 * 1000).toISOString(),
      checks: 3,
      matchCount: 0,
      candidateIds: [],
      truncated: false,
    });
    const markNotCreated = await server.addon.handle({
      method: "POST",
      path: "/api/entries/mark-not-created",
      query: new URLSearchParams(),
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: { entryId: "re-notcreated" },
    });
    expect(markNotCreated.status).toBe(200);

    // --- authz_denied: a different, unrelated user reads entry-ok. --------------------------------
    const otherToken = await signTestToken(keys.privateKey, ADDON_KEY, { workspaceId: WORKSPACE_ID, addonId: ADDON_ID, user: OTHER_USER_ID, workspaceRole: "member" });
    const denied = await server.addon.handle({ method: "GET", path: "/api/entries/detail", query: new URLSearchParams({ id: rowIdFor(server, "entry-ok") }), headers: { authorization: `Bearer ${otherToken}` } });
    expect(denied.status).toBe(404);

    // --- The assertion. ------------------------------------------------------------------------
    const emitted = extractMetricNames(lines);
    expect([...emitted].sort()).toEqual([...METRIC_NAMES].sort());
  });
});
