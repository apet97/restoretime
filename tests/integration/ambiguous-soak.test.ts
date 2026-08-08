// AMBIGUOUS soak (docs/13 IT-04 extension, docs/07 §8). One scripted sequence, against one shared
// database, covering all four AMBIGUOUS outcomes in order: commit-lost (reconcile adopts),
// nothing-committed (bounded reconcile -> user marks not created -> IDLE), a double-candidate
// (reconcile stays AMBIGUOUS, never auto-picks), and a double-adoption attempt — two DIFFERENT
// recoverable rows both resolving to the same Clockify id via the real `/api/entries/
// resolve-ambiguous` HTTP route — where exactly one call succeeds and the other gets a 409.
//
// Phases 1-3 call `attemptRecreation`/`runReconcile` directly (the same production functions
// `tests/integration/mutation.test.ts` exercises individually); phase 4 goes through the real HTTP
// route because the "exactly one 409" requirement is a route-level mapping
// (`handleResolveAmbiguous`'s `SQLITE_CONSTRAINT` catch), not something `runReconcile` itself
// returns as a status code.
import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClockifyClient } from "clockify-sdk-ts-115";
import { buildInstalledPayload, createTestLifecycleRequest, generateTestKeys, signTestToken, type ClockifyTestKeys } from "@apet97/clockify-addon-sdk/testing";
import { createServer, type AppServer } from "../../src/server.js";
import type { AppConfig } from "../../src/config.js";
import * as entries from "../../src/store/entries.js";
import * as plans from "../../src/store/plans.js";
import * as attempts from "../../src/store/attempts.js";
import { attemptRecreation, runReconcile } from "../../src/clockify/recreate.js";
import type { DeletedTimeEntry, PlannedRequest } from "../../src/domain/entry.js";

const ADDON_KEY = "restoretime-ambiguoussoak";
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

function candidateEntry(id: string, description: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    workspaceId: WORKSPACE_ID,
    userId: OWNER_ID,
    description,
    billable: true,
    isLocked: false,
    tagIds: [],
    type: "REGULAR",
    timeInterval: { start: "2026-08-08T10:00:00Z", end: "2026-08-08T11:00:00Z" },
    ...overrides,
  };
}

function sourceFor(entryId: string, description: string): DeletedTimeEntry {
  return {
    workspaceId: WORKSPACE_ID,
    entryId,
    ownerId: OWNER_ID,
    ownerName: "User One",
    description,
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
}

function plannedFor(description: string): PlannedRequest {
  return { workspaceId: WORKSPACE_ID, userId: OWNER_ID, start: "2026-08-08T10:00:00Z", end: "2026-08-08T11:00:00Z", description, billable: true };
}

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  vi.unstubAllGlobals();
});

async function boot(): Promise<{ server: AppServer; keys: ClockifyTestKeys }> {
  dir = mkdtempSync(join(tmpdir(), "restoretime-ambiguoussoak-"));
  const keys: ClockifyTestKeys = await generateTestKeys();
  const server = await createServer(testConfig(), { publicKey: keys.publicKey });
  return { server, keys };
}

/** A create that "times out" client-side after the server already committed it — the exact
 * commit-lost mechanism `mutation.test.ts` IT-04 uses: a slow create response racing a very short
 * client timeout. */
function timingOutCreateClient(candidate: ReturnType<typeof candidateEntry>) {
  const fetchStub: typeof fetch = async (input, init) => {
    const path = pathOf(input);
    const method = methodOf(input, init);
    if (method === "GET" && path.endsWith("/time-entries") && path.includes("/user/")) return jsonResponse([]);
    if (method === "POST" && path.endsWith("/time-entries")) {
      await new Promise((resolve) => setTimeout(resolve, 150));
      return jsonResponse(candidate, 201);
    }
    return jsonResponse({ message: "unstubbed" }, 404);
  };
  return createClockifyClient({ addonToken: "tok", baseUrl: "https://developer.clockify.me/api/v1", timeoutInSeconds: 0.02, fetch: fetchStub });
}

function reconcileClientReturning(items: ReturnType<typeof candidateEntry>[]) {
  const fetchStub: typeof fetch = async (input) => {
    const path = pathOf(input);
    if (path.endsWith("/time-entries") && path.includes("/user/")) return jsonResponse(items);
    return jsonResponse({ message: "unstubbed" }, 404);
  };
  return createClockifyClient({ addonToken: "tok", baseUrl: "https://developer.clockify.me/api/v1", timeoutInSeconds: 30, fetch: fetchStub });
}

describe("AMBIGUOUS soak: one scripted sequence covering all four outcomes", () => {
  it("commit-lost adopts; nothing-committed marks not created; a double-candidate stays AMBIGUOUS; a double-adoption attempt across two rows -> exactly one 409", async () => {
    const { server, keys } = await boot();
    const db = server.db;
    // Installed so `loadClient` (used by the HTTP-level phase 4) has an installation to load.
    const installToken = await signTestToken(keys.privateKey, ADDON_KEY, { workspaceId: WORKSPACE_ID, addonId: ADDON_ID });
    await server.addon.handle(
      createTestLifecycleRequest(
        installToken,
        buildInstalledPayload({ workspaceId: WORKSPACE_ID, addonId: ADDON_ID, apiUrl: "https://developer.clockify.me/api" }),
        { path: "/lifecycle/installed" },
      ),
    );

    // --- Phase 1: commit-lost -> reconcile adopts -> RECREATED. ------------------------------
    const entryA = entries.ingestDeletedEntry(db, {
      id: "re-a",
      workspaceId: WORKSPACE_ID,
      sourceEntryId: "src-a",
      ownerId: OWNER_ID,
      detectedAt: "2026-08-08T09:00:00Z",
      source: sourceFor("src-a", "soak-A-commit-lost"),
    }).entry;
    const plannedA = plannedFor("soak-A-commit-lost");
    plans.createActive(db, { id: "plan-a", recoverableEntryId: entryA.id, createdBy: OWNER_ID, createdAt: "2026-08-08T09:00:30Z", sourceHash: "h", choices: {}, resolution: [], plannedRequest: plannedA, warnings: [], blockers: [], actionRequired: [], fidelity: "FULL" });
    entries.claim(db, { id: entryA.id, workspaceId: WORKSPACE_ID, claimToken: "tok-a", now: new Date("2026-08-08T09:01:00Z") });

    const resultA = await attemptRecreation({
      db, client: timingOutCreateClient(candidateEntry("clockify-a", "soak-A-commit-lost")),
      entryId: entryA.id, workspaceId: WORKSPACE_ID, planId: "plan-a", plannedRequest: plannedA,
      claimToken: "tok-a", recreatedBy: OWNER_ID, now: new Date("2026-08-08T09:02:00Z"),
    });
    expect(resultA.outcome).toBe("AMBIGUOUS");
    expect(entries.getById(db, WORKSPACE_ID, entryA.id)?.lifecycleState).toBe("AMBIGUOUS");

    const reconcileA = await runReconcile({
      db, client: reconcileClientReturning([candidateEntry("clockify-a", "soak-A-commit-lost")]),
      entryId: entryA.id, workspaceId: WORKSPACE_ID, userId: OWNER_ID, plannedRequest: plannedA,
      baseline: [], recreatedBy: OWNER_ID, now: new Date("2026-08-08T09:03:00Z"),
    });
    expect(reconcileA).toEqual({ kind: "adopted", newEntryId: "clockify-a" });
    expect(entries.getById(db, WORKSPACE_ID, entryA.id)?.lifecycleState).toBe("RECREATED");

    // --- Phase 2: nothing-committed -> bounded reconcile -> user marks not created -> IDLE. ---
    const entryB = entries.ingestDeletedEntry(db, {
      id: "re-b",
      workspaceId: WORKSPACE_ID,
      sourceEntryId: "src-b",
      ownerId: OWNER_ID,
      detectedAt: "2026-08-08T09:00:00Z",
      source: sourceFor("src-b", "soak-B-nothing-committed"),
    }).entry;
    const plannedB = plannedFor("soak-B-nothing-committed");
    plans.createActive(db, { id: "plan-b", recoverableEntryId: entryB.id, createdBy: OWNER_ID, createdAt: "2026-08-08T09:00:30Z", sourceHash: "h", choices: {}, resolution: [], plannedRequest: plannedB, warnings: [], blockers: [], actionRequired: [], fidelity: "FULL" });
    entries.claim(db, { id: entryB.id, workspaceId: WORKSPACE_ID, claimToken: "tok-b", now: new Date("2026-08-08T09:01:00Z") });
    entries.setAmbiguous(db, { id: entryB.id, workspaceId: WORKSPACE_ID, claimToken: "tok-b" });
    attempts.start(db, { id: "tok-b", planId: "plan-b", recoverableEntryId: entryB.id, startedAt: "2026-08-08T09:01:30Z", baseline: [] });

    const reconcileB = await runReconcile({
      db, client: reconcileClientReturning([]), // nothing in Clockify matches — never committed
      entryId: entryB.id, workspaceId: WORKSPACE_ID, userId: OWNER_ID, plannedRequest: plannedB,
      baseline: [], recreatedBy: OWNER_ID, now: new Date("2026-08-08T09:03:00Z"),
    });
    expect(reconcileB).toEqual({ kind: "none" });
    expect(entries.getById(db, WORKSPACE_ID, entryB.id)?.lifecycleState).toBe("AMBIGUOUS");
    const markedB = entries.markNotCreated(db, WORKSPACE_ID, entryB.id);
    expect(markedB?.lifecycleState).toBe("IDLE");

    // --- Phase 3: a double-candidate -> stays AMBIGUOUS, reports both, never auto-picks. ------
    const entryC = entries.ingestDeletedEntry(db, {
      id: "re-c",
      workspaceId: WORKSPACE_ID,
      sourceEntryId: "src-c",
      ownerId: OWNER_ID,
      detectedAt: "2026-08-08T09:00:00Z",
      source: sourceFor("src-c", "soak-C-double-candidate"),
    }).entry;
    const plannedC = plannedFor("soak-C-double-candidate");
    plans.createActive(db, { id: "plan-c", recoverableEntryId: entryC.id, createdBy: OWNER_ID, createdAt: "2026-08-08T09:00:30Z", sourceHash: "h", choices: {}, resolution: [], plannedRequest: plannedC, warnings: [], blockers: [], actionRequired: [], fidelity: "FULL" });
    entries.claim(db, { id: entryC.id, workspaceId: WORKSPACE_ID, claimToken: "tok-c", now: new Date("2026-08-08T09:01:00Z") });
    entries.setAmbiguous(db, { id: entryC.id, workspaceId: WORKSPACE_ID, claimToken: "tok-c" });
    attempts.start(db, { id: "tok-c", planId: "plan-c", recoverableEntryId: entryC.id, startedAt: "2026-08-08T09:01:30Z", baseline: [] });

    const reconcileC = await runReconcile({
      db,
      client: reconcileClientReturning([
        candidateEntry("clockify-c1", "soak-C-double-candidate"),
        candidateEntry("clockify-c2", "soak-C-double-candidate"),
      ]),
      entryId: entryC.id, workspaceId: WORKSPACE_ID, userId: OWNER_ID, plannedRequest: plannedC,
      baseline: [], recreatedBy: OWNER_ID, now: new Date("2026-08-08T09:03:00Z"),
    });
    expect(reconcileC).toEqual({ kind: "many", candidateIds: ["clockify-c1", "clockify-c2"] });
    expect(entries.getById(db, WORKSPACE_ID, entryC.id)?.lifecycleState).toBe("AMBIGUOUS");

    // --- Phase 4: double-adoption. Two DIFFERENT rows (D, E) both resolve, via the real HTTP
    // route, to the SAME Clockify id -> the first wins (200 RECREATED), the second gets exactly
    // one 409, and the row it belongs to is untouched (still AMBIGUOUS). -----------------------
    const sharedPlanned = plannedFor("soak-DE-double-adopt");
    const entryD = entries.ingestDeletedEntry(db, { id: "re-d", workspaceId: WORKSPACE_ID, sourceEntryId: "src-d", ownerId: OWNER_ID, detectedAt: "2026-08-08T09:00:00Z", source: sourceFor("src-d", "soak-DE-double-adopt") }).entry;
    const entryE = entries.ingestDeletedEntry(db, { id: "re-e", workspaceId: WORKSPACE_ID, sourceEntryId: "src-e", ownerId: OWNER_ID, detectedAt: "2026-08-08T09:00:00Z", source: sourceFor("src-e", "soak-DE-double-adopt") }).entry;
    for (const [entry, token, planId] of [
      [entryD, "tok-d", "plan-d"],
      [entryE, "tok-e", "plan-e"],
    ] as const) {
      plans.createActive(db, { id: planId, recoverableEntryId: entry.id, createdBy: OWNER_ID, createdAt: "2026-08-08T09:00:30Z", sourceHash: "h", choices: {}, resolution: [], plannedRequest: sharedPlanned, warnings: [], blockers: [], actionRequired: [], fidelity: "FULL" });
      entries.claim(db, { id: entry.id, workspaceId: WORKSPACE_ID, claimToken: token, now: new Date("2026-08-08T09:01:00Z") });
      entries.setAmbiguous(db, { id: entry.id, workspaceId: WORKSPACE_ID, claimToken: token });
      attempts.start(db, { id: token, planId, recoverableEntryId: entry.id, startedAt: "2026-08-08T09:01:30Z", baseline: [] });
    }

    const sharedClockifyId = "clockify-shared-de";
    vi.stubGlobal(
      "fetch",
      (async (input, init) => {
        const path = pathOf(input);
        const method = methodOf(input, init);
        if (method === "GET" && path.endsWith(`/time-entries/${sharedClockifyId}`)) {
          return jsonResponse(candidateEntry(sharedClockifyId, "soak-DE-double-adopt"));
        }
        return jsonResponse({ message: "unstubbed" }, 404);
      }) as typeof fetch,
    );
    const viewerToken = await signTestToken(keys.privateKey, ADDON_KEY, { workspaceId: WORKSPACE_ID, addonId: ADDON_ID, user: OWNER_ID, workspaceRole: "member" });

    const firstAdopt = await server.addon.handle({
      method: "POST",
      path: "/api/entries/resolve-ambiguous",
      query: new URLSearchParams(),
      headers: { authorization: `Bearer ${viewerToken}`, "content-type": "application/json" },
      body: { entryId: entryD.id, newEntryId: sharedClockifyId },
    });
    expect(firstAdopt.status).toBe(200);
    expect((firstAdopt.body as { entry: { lifecycleState: string } }).entry.lifecycleState).toBe("RECREATED");

    const secondAdopt = await server.addon.handle({
      method: "POST",
      path: "/api/entries/resolve-ambiguous",
      query: new URLSearchParams(),
      headers: { authorization: `Bearer ${viewerToken}`, "content-type": "application/json" },
      body: { entryId: entryE.id, newEntryId: sharedClockifyId },
    });
    expect(secondAdopt.status).toBe(409);
    expect(secondAdopt.body).toEqual({ error: "that Clockify entry is already linked to another recovered entry" });

    // The row that lost the race is untouched — still AMBIGUOUS, no new_entry_id, no attempt
    // silently marked SUCCESS for an id it does not actually own.
    const rowE = entries.getById(db, WORKSPACE_ID, entryE.id);
    expect(rowE?.lifecycleState).toBe("AMBIGUOUS");
    expect(rowE?.newEntryId).toBeNull();
    // Exactly one row in the whole workspace ended up linked to the shared Clockify id.
    const linkedCount = (
      db.prepare("SELECT COUNT(*) AS n FROM recoverable_entries WHERE workspace_id = ? AND new_entry_id = ?").get(WORKSPACE_ID, sharedClockifyId) as { n: number }
    ).n;
    expect(linkedCount).toBe(1);
  });
});
