// IT-16 — Revalidation drill (docs/13, docs/07 §7, ADR-006). A dependency (the source project) is removed
// between plan creation and confirm. Proves the full chain: the plan is marked STALE, a fresh
// preflight is returned in the response, AND — the part a response-shape assertion alone would
// miss — no Clockify mutation (`POST /time-entries`) was ever issued. A call-counting fetch stub is
// the only way to prove a negative like this; asserting `stale: true` in the body proves the
// *response* was honest, not that the *server* never tried to write.
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
import * as attempts from "../../src/store/attempts.js";

const ADDON_KEY = "restoretime-revalidation";
const WORKSPACE_ID = "ws-1";
const ADDON_ID = "addon-1";
const SCOPE = { workspaceId: WORKSPACE_ID, addonId: ADDON_ID };
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
});

async function boot(): Promise<{ server: AppServer; keys: ClockifyTestKeys }> {
  dir = mkdtempSync(join(tmpdir(), "restoretime-revalidation-"));
  keys = await generateTestKeys();
  const server = await createServer(testConfig(), { publicKey: keys.publicKey });
  return { server, keys };
}

describe("Revalidation drill: a dependency removed between plan and confirm", () => {
  it("STALE plan, fresh preflight in the response, and the create call is never issued", async () => {
    const { server, keys: testKeys } = await boot();

    const installToken = await signTestToken(testKeys.privateKey, ADDON_KEY, { workspaceId: WORKSPACE_ID, addonId: ADDON_ID });
    const webhookToken = await signTestToken(testKeys.privateKey, ADDON_KEY, { workspaceId: WORKSPACE_ID, addonId: ADDON_ID });
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
          projectId: "proj-1",
          type: "REGULAR",
          currentlyRunning: false,
          timeInterval: { start: "2026-08-08T10:00:00Z", end: "2026-08-08T11:00:00Z", timeZone: "UTC" },
          project: { id: "proj-1", name: "Project One", clientName: null },
          task: null,
          tags: [],
          user: { name: "User One" },
          customFieldValues: [],
        },
        { path: "/webhooks/time-entry-deleted" },
      ),
    );

    const token = await signTestToken(testKeys.privateKey, ADDON_KEY, { workspaceId: WORKSPACE_ID, addonId: ADDON_ID, user: OWNER_ID, workspaceRole: "member" });
    const listResponse = await server.addon.handle({ method: "GET", path: "/api/entries", query: new URLSearchParams(), headers: { authorization: `Bearer ${token}` } });
    const entryId = (listResponse.body as { entries: { id: string }[] }).entries[0]!.id;

    // Mutable flag: the project exists at plan time, but is reported gone at revalidate time —
    // the dependency change the drill requires.
    let projectStillExists = true;
    const calls: { method: string; path: string }[] = [];
    vi.stubGlobal(
      "fetch",
      (async (input: string | URL | Request, init?: RequestInit) => {
        const path = pathOf(input);
        const method = methodOf(input, init);
        calls.push({ method, path });
        if (method === "GET" && /\/workspaces\/[^/]+$/.test(path)) return jsonResponse({ id: WORKSPACE_ID, workspaceSettings: {} });
        if (method === "GET" && path.endsWith("/users")) return jsonResponse([{ id: OWNER_ID, email: "a@b.com", name: "User One", status: "ACTIVE" }]);
        if (method === "GET" && path.endsWith("/tags")) return jsonResponse([]);
        if (method === "GET" && path.endsWith("/custom-fields")) return jsonResponse([]);
        if (method === "GET" && path.endsWith("/projects/proj-1")) {
          return projectStillExists
            ? jsonResponse({ id: "proj-1", name: "Project One", archived: false, public: true, memberships: [] })
            : jsonResponse({ message: "Project doesn't belong to Workspace", code: 501 }, 400);
        }
        return jsonResponse({ message: "unstubbed — a create call here would mean the mutation was issued despite STALE" }, 404);
      }) as typeof fetch,
    );

    const preflightResponse = await server.addon.handle({
      method: "POST",
      path: "/api/entries/preflight",
      query: new URLSearchParams(),
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: { entryId, choices: {} },
    });
    expect(preflightResponse.status).toBe(200);
    const originalPlan = (preflightResponse.body as { plan: { id: string; fidelity: string; blockers: unknown[] } }).plan;
    expect(originalPlan.fidelity).toBe("FULL");
    expect(originalPlan.blockers).toHaveLength(0);

    // The dependency vanishes between plan and confirm.
    projectStillExists = false;
    calls.length = 0; // only count calls made from here on — the revalidation + (would-be) create

    const recreateResponse = await server.addon.handle({
      method: "POST",
      path: "/api/entries/recreate",
      query: new URLSearchParams(),
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: { entryId, planId: originalPlan.id },
    });

    // 1. The response says STALE and carries a fresh preflight.
    expect(recreateResponse.status).toBe(409);
    const body = recreateResponse.body as {
      stale: true;
      error: string;
      plan: { id: string; actionRequired: { ruleId: string }[]; blockers: unknown[] };
    };
    expect(body.stale).toBe(true);
    // N8: the UI's fallback renderer reads `error` only. Without it this — the most important 409
    // in the product — degraded to "could not complete that request (status 409)", which answers
    // none of the three questions.
    expect(body.error).toContain("Nothing was sent to Clockify");
    expect(body.plan.id).not.toBe(originalPlan.id); // a genuinely new plan, not the stale one relabeled
    expect(body.plan.actionRequired.some((a) => a.ruleId === "P-PROJ-GONE")).toBe(true);

    // 2. The mutation was never issued — not merely "the response says STALE". No call in this
    // window was a POST to the time-entries create endpoint.
    const createCalls = calls.filter((c) => c.method === "POST" && c.path.endsWith("/time-entries"));
    expect(createCalls).toHaveLength(0);

    // 3. No side effect landed anywhere a create would have left one: the row was never claimed
    // (still IDLE), and no attempt row exists for it at all.
    const row = entries.getById(server.db, SCOPE, entryId);
    expect(row?.lifecycleState).toBe("IDLE");
    expect(row?.claimToken).toBeNull();
    expect(attempts.listForEntry(server.db, entryId)).toHaveLength(0);

    // 4. The original (now-stale) plan really was superseded: it is no longer usable to execute.
    const staleRecreateAgain = await server.addon.handle({
      method: "POST",
      path: "/api/entries/recreate",
      query: new URLSearchParams(),
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: { entryId, planId: originalPlan.id },
    });
    // Still 409 (stale-again or plan-consumed depending on internal bookkeeping) — never a 200.
    expect(staleRecreateAgain.status).toBe(409);
  });
});
