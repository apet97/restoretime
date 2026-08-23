// IT-12 extension (docs/13, docs/07 §6-§8). Crashes the real recreate handler after its attempt
// row exists. At that point a create can be in flight, so lease expiry must recover the entry to
// AMBIGUOUS. It must not authorize a second create. The pre-write no-attempt recovery case stays
// independently reclaimable in `claim.test.ts`.
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
import { createClockifyClient } from "clockify-sdk-ts-115";
import { createServer, type AppServer } from "../../src/server.js";
import { openDatabase } from "../../src/store/db.js";
import type { AppConfig } from "../../src/config.js";
import * as entries from "../../src/store/entries.js";
import * as attempts from "../../src/store/attempts.js";
import * as plans from "../../src/store/plans.js";
import { attemptRecreation } from "../../src/clockify/recreate.js";
import type { DeletedTimeEntry, PlannedRequest } from "../../src/domain/entry.js";
import { ingestEntry, seedInstallation } from "../support/installation-fixture.js";

const ADDON_KEY = "restoretime-leasedrill";
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

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "restoretime-leasedrill-"));
  keys = await generateTestKeys();
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  vi.unstubAllGlobals();
  delete process.env.RT_TEST_CRASH_MID_ATTEMPT;
});

async function boot(): Promise<AppServer> {
  return createServer(testConfig(), { publicKey: keys.publicKey });
}

function stableClockifyStub(): typeof fetch {
  return (async (input, init) => {
    const path = pathOf(input);
    const method = methodOf(input, init);
    if (method === "GET" && /\/workspaces\/[^/]+$/.test(path)) return jsonResponse({ id: WORKSPACE_ID, workspaceSettings: {} });
    if (method === "GET" && path.endsWith("/users")) return jsonResponse([{ id: OWNER_ID, email: "a@b.com", name: "User One", status: "ACTIVE" }]);
    if (method === "GET" && path.endsWith("/tags")) return jsonResponse([]);
    if (method === "GET" && path.endsWith("/custom-fields")) return jsonResponse([]);
    // The baseline read: the crash fires right after this, before any create POST is ever sent.
    if (method === "GET" && path.endsWith("/time-entries") && path.includes("/user/")) return jsonResponse([]);
    return jsonResponse({ message: "unstubbed — the crash must fire before any create/verification call" }, 404);
  }) as typeof fetch;
}

describe("IT-12 lease/fencing drill: a crashed started attempt becomes AMBIGUOUS", () => {
  it("the detail route recovers the expired attempt and fences a late write from the dead process", async () => {
    const server = await boot();
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

    const preflightResponse = await server.addon.handle({
      method: "POST",
      path: "/api/entries/preflight",
      query: new URLSearchParams(),
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: { entryId, choices: {} },
    });
    expect(preflightResponse.status).toBe(200);
    const planId = (preflightResponse.body as { plan: { id: string } }).plan.id;

    // --- The crash: the flag makes the REAL `attemptRecreation` throw right after the baseline
    // snapshot, before any create call.
    process.env.RT_TEST_CRASH_MID_ATTEMPT = "1";
    const recreateResponse = await server.addon.handle({
      method: "POST",
      path: "/api/entries/recreate",
      query: new URLSearchParams(),
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: { entryId, planId },
    });
    // routes.ts confirmPlan: anything thrown after the claim is "the outcome is NOT known to be
    // 'nothing happened'" -> `attempt-error`, 502, and the claim is deliberately NOT released.
    expect(recreateResponse.status).toBe(502);
    delete process.env.RT_TEST_CRASH_MID_ATTEMPT;

    const afterCrash = entries.getById(server.db, SCOPE, entryId);
    expect(afterCrash?.lifecycleState).toBe("RECREATING");
    expect(afterCrash?.claimToken).toBeTruthy();
    const deadToken = afterCrash!.claimToken!;
    const deadClaimExpiresAt = new Date(afterCrash!.claimExpiresAt!);

    // A second confirm attempt, well inside the 60 s lease, must NOT be able to claim the row —
    // the crash must not have silently released it.
    const tooSoon = entries.claim(server.db, {
      id: entryId,
      scope: SCOPE,
      claimToken: "attempt-too-soon",
      now: new Date(deadClaimExpiresAt.getTime() - 30_000),
    });
    expect(tooSoon).toBeUndefined();
    expect(entries.getById(server.db, SCOPE, entryId)?.claimToken).toBe(deadToken);

    // Make the lease expired for the real wall clock, then use the route the UI refreshes. No
    // second recreate call is available for a RECREATING row, so detail must perform recovery.
    server.db.prepare(
      "UPDATE recoverable_entries SET claim_expires_at=? WHERE id=?",
    ).run(new Date(Date.now() - 1_000).toISOString(), entryId);
    const detailResponse = await server.addon.handle({
      method: "GET",
      path: "/api/entries/detail",
      query: new URLSearchParams({ id: entryId }),
      headers: { authorization: `Bearer ${token}` },
    });
    expect(detailResponse.status).toBe(200);
    expect((detailResponse.body as { entry: { lifecycleState: string } }).entry.lifecycleState)
      .toBe("AMBIGUOUS");
    const recovered = entries.getById(server.db, SCOPE, entryId);
    expect(recovered?.lifecycleState).toBe("AMBIGUOUS");
    expect(recovered?.claimToken).toBeNull();
    expect(attempts.getById(server.db, deadToken)?.outcome).toBe("AMBIGUOUS");

    // The dead attempt's own outcome, if its (already-abandoned) in-flight request ever resolves
    // and tries to report a result, must be refused: it no longer owns the row.
    const staleWrite = entries.setRecreated(server.db, {
      id: entryId,
      scope: SCOPE,
      claimToken: deadToken,
      newEntryId: "ghost-entry-from-dead-attempt",
      recreatedAt: new Date().toISOString(),
      recreatedBy: OWNER_ID,
    });
    expect(staleWrite).toBeUndefined();
    expect(entries.getById(server.db, SCOPE, entryId)?.newEntryId).toBeNull();
    expect(entries.getById(server.db, SCOPE, entryId)?.lifecycleState).toBe("AMBIGUOUS");
  });
});

describe("the crash flag itself is inert outside NODE_ENV=test", () => {
  it("with RT_TEST_CRASH_MID_ATTEMPT=1 but NODE_ENV stubbed to a non-test value, attemptRecreation completes normally", async () => {
    const db = openDatabase(join(dir, "guard.sqlite"));
    seedInstallation(db, SCOPE);
    const source: DeletedTimeEntry = {
      workspaceId: WORKSPACE_ID,
      entryId: "entry-a",
      ownerId: OWNER_ID,
      ownerName: "User One",
      description: "d",
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
    };
    const entry = ingestEntry(db, {
      id: "re-1",
      scope: SCOPE,
      sourceEntryId: "entry-a",
      ownerId: OWNER_ID,
      detectedAt: "2026-08-08T09:00:00Z",
      source,
    }).entry;
    const planned: PlannedRequest = { workspaceId: WORKSPACE_ID, userId: OWNER_ID, start: source.start, end: "2026-08-08T11:00:00Z", description: source.description, billable: source.billable };
    plans.createActive(db, {
      id: "plan-guard",
      recoverableEntryId: entry.id,
      createdBy: OWNER_ID,
      createdAt: "2026-08-08T09:00:30.000Z",
      sourceHash: "hash",
      choices: {},
      resolution: [],
      presentation: { project: null, task: null, tags: [], customFields: [], editable: [] },
      plannedRequest: planned,
      warnings: [],
      blockers: [],
      actionRequired: [],
      fidelity: "FULL",
    });
    entries.claim(db, { id: entry.id, scope: SCOPE, claimToken: "tok-guard", now: new Date("2026-08-08T09:01:00Z") });

    const fetchStub: typeof fetch = async (input, init) => {
      const path = pathOf(input);
      const method = methodOf(input, init);
      if (method === "GET" && path.endsWith("/time-entries") && path.includes("/user/")) return jsonResponse([]);
      if (method === "POST" && path.endsWith("/time-entries")) {
        return jsonResponse(
          { id: "new-entry-1", scope: SCOPE, userId: OWNER_ID, description: "d", billable: true, tagIds: [], type: "REGULAR", timeInterval: { start: source.start, end: "2026-08-08T11:00:00Z" } },
          201,
        );
      }
      if (method === "GET" && path.includes("/time-entries/new-entry-1")) {
        return jsonResponse({ id: "new-entry-1", scope: SCOPE, userId: OWNER_ID, description: "d", billable: true, tagIds: [], type: "REGULAR", timeInterval: { start: source.start, end: "2026-08-08T11:00:00Z" } });
      }
      return jsonResponse({ message: "unstubbed" }, 404);
    };
    const client = createClockifyClient({ addonToken: "tok", baseUrl: "https://developer.clockify.me/api/v1", timeoutInSeconds: 30, fetch: fetchStub });

    vi.stubEnv("NODE_ENV", "production");
    process.env.RT_TEST_CRASH_MID_ATTEMPT = "1"; // set, but must be ignored — the guard is NODE_ENV, not this flag alone
    try {
      const result = await attemptRecreation({
        db,
        client,
        entryId: entry.id,
        scope: SCOPE,
        planId: "plan-guard",
        plannedRequest: planned,
        claimToken: "tok-guard",
        recreatedBy: OWNER_ID,
      });
      expect(result.outcome).toBe("RECREATED");
    } finally {
      vi.unstubAllEnvs();
      delete process.env.RT_TEST_CRASH_MID_ATTEMPT;
      db.close();
    }
  });
});
