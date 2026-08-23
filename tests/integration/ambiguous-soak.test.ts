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
import { insertAttemptFixture } from "../support/attempt-fixture.js";
import { beginReconcileFixture, setReconcileFixture } from "../support/reconcile-fixture.js";
import { attemptRecreation, runReconcile } from "../../src/clockify/recreate.js";
import type { DeletedTimeEntry, PlannedRequest } from "../../src/domain/entry.js";
import { ingestEntry, seedInstallation } from "../support/installation-fixture.js";

const ADDON_KEY = "restoretime-ambiguoussoak";
const WORKSPACE_ID = "ws-1";
const ADDON_ID = "addon-1";
const SCOPE = { workspaceId: WORKSPACE_ID, addonId: ADDON_ID };
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

function finishAmbiguousFixture(db: AppServer["db"], id: string): void {
  const finished = attempts.finishUnfinished(db, {
    id,
    finishedAt: "2026-08-08T09:01:59Z",
    outcome: "AMBIGUOUS",
    newEntryId: null,
    errorStatus: null,
    errorCode: null,
    errorMessage: null,
    diffs: null,
  });
  if (!finished) throw new Error("could not record ambiguous attempt fixture");
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
  seedInstallation(server.db, SCOPE);
  return { server, keys };
}

async function install(server: AppServer, keys: ClockifyTestKeys): Promise<string> {
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
        apiUrl: "https://developer.clockify.me/api",
      }),
      { path: "/lifecycle/installed" },
    ),
  );
  return signTestToken(keys.privateKey, ADDON_KEY, {
    workspaceId: WORKSPACE_ID,
    addonId: ADDON_ID,
    user: OWNER_ID,
    workspaceRole: "member",
  });
}

function seedEligibleAmbiguous(
  server: AppServer,
  input: { entryId: string; attemptId: string; planId: string; description: string },
) {
  const entry = ingestEntry(server.db, {
    id: input.entryId,
    scope: SCOPE,
    sourceEntryId: `source-${input.entryId}`,
    ownerId: OWNER_ID,
    detectedAt: "2026-08-08T09:00:00Z",
    source: sourceFor(`source-${input.entryId}`, input.description),
  }).entry;
  const planned = plannedFor(input.description);
  plans.createActive(server.db, {
    id: input.planId,
    recoverableEntryId: entry.id,
    createdBy: OWNER_ID,
    createdAt: "2026-08-08T09:00:30Z",
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
  entries.claim(server.db, {
    id: entry.id,
    scope: SCOPE,
    claimToken: input.attemptId,
    now: new Date("2026-08-08T09:01:00Z"),
  });
  insertAttemptFixture(server.db, {
    id: input.attemptId,
    planId: input.planId,
    recoverableEntryId: entry.id,
    startedAt: "2026-08-08T09:01:01Z",
    baseline: [],
  });
  finishAmbiguousFixture(server.db, input.attemptId);
  entries.setAmbiguous(server.db, {
    id: entry.id,
    scope: SCOPE,
    claimToken: input.attemptId,
  });
  setReconcileFixture(server.db, input.attemptId, {
    checkedAt: new Date(Date.now() - 11 * 60 * 1000).toISOString(),
    firstEligibleCheckAt: new Date(Date.now() - 22 * 60 * 1000).toISOString(),
    checks: 3,
    matchCount: 0,
    candidateIds: [],
    truncated: false,
  });
  return { entry, planned };
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
  it("commit-lost adopts; nothing-committed marks not created; a double-candidate stays AMBIGUOUS; one shared entry is adopted only once", async () => {
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
    const entryA = ingestEntry(db, {
      id: "re-a",
      scope: SCOPE,
      sourceEntryId: "src-a",
      ownerId: OWNER_ID,
      detectedAt: "2026-08-08T09:00:00Z",
      source: sourceFor("src-a", "soak-A-commit-lost"),
    }).entry;
    const plannedA = plannedFor("soak-A-commit-lost");
    plans.createActive(db, { id: "plan-a", recoverableEntryId: entryA.id, createdBy: OWNER_ID, createdAt: "2026-08-08T09:00:30Z", sourceHash: "h", choices: {}, resolution: [], plannedRequest: plannedA, presentation: { project: null, task: null, tags: [], customFields: [], editable: [] }, warnings: [], blockers: [], actionRequired: [], fidelity: "FULL" });
    entries.claim(db, { id: entryA.id, scope: SCOPE, claimToken: "tok-a", now: new Date("2026-08-08T09:01:00Z") });

    const resultA = await attemptRecreation({
      db, client: timingOutCreateClient(candidateEntry("clockify-a", "soak-A-commit-lost")),
      entryId: entryA.id, scope: SCOPE, planId: "plan-a", plannedRequest: plannedA,
      claimToken: "tok-a", recreatedBy: OWNER_ID,
    });
    expect(resultA.outcome).toBe("AMBIGUOUS");
    expect(entries.getById(db, SCOPE, entryA.id)?.lifecycleState).toBe("AMBIGUOUS");

    const runA = beginReconcileFixture(db, { recoverableEntryId: entryA.id, scope: SCOPE, expectedAttemptId: "tok-a" });
    const reconcileA = await runReconcile({
      db, client: reconcileClientReturning([candidateEntry("clockify-a", "soak-A-commit-lost")]),
      entryId: entryA.id, scope: SCOPE, userId: OWNER_ID, plannedRequest: plannedA,
      baseline: [], expectedAttemptId: "tok-a", reconcileRunId: runA, recreatedBy: OWNER_ID, now: new Date("2026-08-08T09:03:00Z"),
    });
    expect(reconcileA).toEqual({ kind: "adopted", newEntryId: "clockify-a" });
    expect(entries.getById(db, SCOPE, entryA.id)?.lifecycleState).toBe("RECREATED");
    expect(attempts.getById(db, "tok-a")?.diffs).toContainEqual({
      field: "_verification",
      planned: null,
      actual: "verification read unavailable",
    });

    // --- Phase 2: nothing-committed -> bounded reconcile -> user marks not created -> IDLE. ---
    const entryB = ingestEntry(db, {
      id: "re-b",
      scope: SCOPE,
      sourceEntryId: "src-b",
      ownerId: OWNER_ID,
      detectedAt: "2026-08-08T09:00:00Z",
      source: sourceFor("src-b", "soak-B-nothing-committed"),
    }).entry;
    const plannedB = plannedFor("soak-B-nothing-committed");
    plans.createActive(db, { id: "plan-b", recoverableEntryId: entryB.id, createdBy: OWNER_ID, createdAt: "2026-08-08T09:00:30Z", sourceHash: "h", choices: {}, resolution: [], plannedRequest: plannedB, presentation: { project: null, task: null, tags: [], customFields: [], editable: [] }, warnings: [], blockers: [], actionRequired: [], fidelity: "FULL" });
    entries.claim(db, { id: entryB.id, scope: SCOPE, claimToken: "tok-b", now: new Date("2026-08-08T09:01:00Z") });
    entries.setAmbiguous(db, { id: entryB.id, scope: SCOPE, claimToken: "tok-b" });
    insertAttemptFixture(db, { id: "tok-b", planId: "plan-b", recoverableEntryId: entryB.id, startedAt: "2026-08-08T09:01:30Z", baseline: [] });
    finishAmbiguousFixture(db, "tok-b");

    const runB = beginReconcileFixture(db, { recoverableEntryId: entryB.id, scope: SCOPE, expectedAttemptId: "tok-b" });
    const reconcileB = await runReconcile({
      db, client: reconcileClientReturning([]), // nothing in Clockify matches — never committed
      entryId: entryB.id, scope: SCOPE, userId: OWNER_ID, plannedRequest: plannedB,
      baseline: [], expectedAttemptId: "tok-b", reconcileRunId: runB, recreatedBy: OWNER_ID, now: new Date("2026-08-08T09:03:00Z"),
    });
    expect(reconcileB).toEqual({ kind: "none" });
    expect(entries.getById(db, SCOPE, entryB.id)?.lifecycleState).toBe("AMBIGUOUS");
    const markedB = entries.markNotCreated(db, SCOPE, entryB.id);
    expect(markedB?.lifecycleState).toBe("IDLE");

    // --- Phase 3: a double-candidate -> stays AMBIGUOUS, reports both, never auto-picks. ------
    const entryC = ingestEntry(db, {
      id: "re-c",
      scope: SCOPE,
      sourceEntryId: "src-c",
      ownerId: OWNER_ID,
      detectedAt: "2026-08-08T09:00:00Z",
      source: sourceFor("src-c", "soak-C-double-candidate"),
    }).entry;
    const plannedC = plannedFor("soak-C-double-candidate");
    plans.createActive(db, { id: "plan-c", recoverableEntryId: entryC.id, createdBy: OWNER_ID, createdAt: "2026-08-08T09:00:30Z", sourceHash: "h", choices: {}, resolution: [], plannedRequest: plannedC, presentation: { project: null, task: null, tags: [], customFields: [], editable: [] }, warnings: [], blockers: [], actionRequired: [], fidelity: "FULL" });
    entries.claim(db, { id: entryC.id, scope: SCOPE, claimToken: "tok-c", now: new Date("2026-08-08T09:01:00Z") });
    entries.setAmbiguous(db, { id: entryC.id, scope: SCOPE, claimToken: "tok-c" });
    insertAttemptFixture(db, { id: "tok-c", planId: "plan-c", recoverableEntryId: entryC.id, startedAt: "2026-08-08T09:01:30Z", baseline: [] });
    finishAmbiguousFixture(db, "tok-c");

    const runC = beginReconcileFixture(db, { recoverableEntryId: entryC.id, scope: SCOPE, expectedAttemptId: "tok-c" });
    const reconcileC = await runReconcile({
      db,
      client: reconcileClientReturning([
        candidateEntry("clockify-c1", "soak-C-double-candidate"),
        candidateEntry("clockify-c2", "soak-C-double-candidate"),
      ]),
      entryId: entryC.id, scope: SCOPE, userId: OWNER_ID, plannedRequest: plannedC,
      baseline: [], expectedAttemptId: "tok-c", reconcileRunId: runC, recreatedBy: OWNER_ID, now: new Date("2026-08-08T09:03:00Z"),
    });
    expect(reconcileC).toEqual({ kind: "many", candidateIds: ["clockify-c1", "clockify-c2"] });
    expect(entries.getById(db, SCOPE, entryC.id)?.lifecycleState).toBe("AMBIGUOUS");

    // --- Phase 4: double-adoption. Two DIFFERENT rows (D, E) both resolve, via the real HTTP
    // route, to the SAME Clockify id -> the first wins (200 RECREATED), the second gets exactly
    // one 409, and the row it belongs to is untouched (still AMBIGUOUS). -----------------------
    const sharedPlanned = plannedFor("soak-DE-double-adopt");
    const entryD = ingestEntry(db, { id: "re-d", scope: SCOPE, sourceEntryId: "src-d", ownerId: OWNER_ID, detectedAt: "2026-08-08T09:00:00Z", source: sourceFor("src-d", "soak-DE-double-adopt") }).entry;
    const entryE = ingestEntry(db, { id: "re-e", scope: SCOPE, sourceEntryId: "src-e", ownerId: OWNER_ID, detectedAt: "2026-08-08T09:00:00Z", source: sourceFor("src-e", "soak-DE-double-adopt") }).entry;
    for (const [entry, token, planId] of [
      [entryD, "tok-d", "plan-d"],
      [entryE, "tok-e", "plan-e"],
    ] as const) {
      plans.createActive(db, { id: planId, recoverableEntryId: entry.id, createdBy: OWNER_ID, createdAt: "2026-08-08T09:00:30Z", sourceHash: "h", choices: {}, resolution: [], plannedRequest: sharedPlanned, presentation: { project: null, task: null, tags: [], customFields: [], editable: [] }, warnings: [], blockers: [], actionRequired: [], fidelity: "FULL" });
      entries.claim(db, { id: entry.id, scope: SCOPE, claimToken: token, now: new Date("2026-08-08T09:01:00Z") });
      entries.setAmbiguous(db, { id: entry.id, scope: SCOPE, claimToken: token });
      insertAttemptFixture(db, { id: token, planId, recoverableEntryId: entry.id, startedAt: "2026-08-08T09:01:30Z", baseline: [] });
      finishAmbiguousFixture(db, token);
    }

    const sharedClockifyId = "clockify-shared-de";
    const missingProbeId = "clockify-missing-probe";
    const malformedProbeId = "clockify-malformed-probe";
    const otherUserProbeId = "clockify-other-user-probe";
    vi.stubGlobal(
      "fetch",
      (async (input, init) => {
        const path = pathOf(input);
        const method = methodOf(input, init);
        if (method === "GET" && path.endsWith(`/time-entries/${sharedClockifyId}`)) {
          return jsonResponse(candidateEntry(sharedClockifyId, "soak-DE-double-adopt"));
        }
        if (method === "GET" && path.endsWith(`/time-entries/${otherUserProbeId}`)) {
          return jsonResponse(candidateEntry(otherUserProbeId, "soak-DE-double-adopt", { userId: "other-user" }));
        }
        if (method === "GET" && path.endsWith(`/time-entries/${missingProbeId}`)) {
          return jsonResponse({ message: "not found" }, 404);
        }
        if (method === "GET" && path.endsWith(`/time-entries/${malformedProbeId}`)) {
          return jsonResponse({ message: "invalid id" }, 400);
        }
        return jsonResponse({ message: "unstubbed" }, 404);
      }) as typeof fetch,
    );
    const viewerToken = await signTestToken(keys.privateKey, ADDON_KEY, { workspaceId: WORKSPACE_ID, addonId: ADDON_ID, user: OWNER_ID, workspaceRole: "member" });

    const probe = (newEntryId: string) => server.addon.handle({
      method: "POST",
      path: "/api/entries/resolve-ambiguous",
      query: new URLSearchParams(),
      headers: { authorization: `Bearer ${viewerToken}`, "content-type": "application/json" },
      body: { entryId: entryD.id, newEntryId },
    });
    const [missingProbe, malformedProbe, otherUserProbe] = await Promise.all([
      probe(missingProbeId),
      probe(malformedProbeId),
      probe(otherUserProbeId),
    ]);
    expect({ status: missingProbe.status, body: missingProbe.body }).toEqual({
      status: otherUserProbe.status,
      body: otherUserProbe.body,
    });
    expect({ status: malformedProbe.status, body: malformedProbe.body }).toEqual({
      status: missingProbe.status,
      body: missingProbe.body,
    });

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
    expect(secondAdopt.status).toBe(400);
    expect(secondAdopt.body).toEqual({ error: "This entry cannot be used for this recreation." });

    // The row that lost the race is untouched — still AMBIGUOUS, no new_entry_id, no attempt
    // silently marked SUCCESS for an id it does not actually own.
    const rowE = entries.getById(db, SCOPE, entryE.id);
    expect(rowE?.lifecycleState).toBe("AMBIGUOUS");
    expect(rowE?.newEntryId).toBeNull();
    // Exactly one row in the whole workspace ended up linked to the shared Clockify id.
    const linkedCount = (
      db.prepare("SELECT COUNT(*) AS n FROM recoverable_entries WHERE workspace_id = ? AND new_entry_id = ?").get(WORKSPACE_ID, sharedClockifyId) as { n: number }
    ).n;
    expect(linkedCount).toBe(1);
  });

  it("manually adopts the known billable override and does not allow the consumed plan to retry", async () => {
    const { server, keys } = await boot();
    const token = await install(server, keys);
    const description = "billable-override-manual-adoption";
    const source = { ...sourceFor("source-billable-override", description), billable: false };
    const planned = { ...plannedFor(description), billable: false };
    const entry = ingestEntry(server.db, {
      id: "re-billable-override",
      scope: SCOPE,
      sourceEntryId: source.entryId,
      ownerId: OWNER_ID,
      detectedAt: "2026-08-08T09:00:00Z",
      source,
    }).entry;
    plans.createActive(server.db, {
      id: "plan-billable-override",
      recoverableEntryId: entry.id,
      createdBy: OWNER_ID,
      createdAt: "2026-08-08T09:00:30Z",
      sourceHash: "hash",
      choices: {},
      resolution: [],
      presentation: { project: null, task: null, tags: [], customFields: [], editable: [] },
      plannedRequest: planned,
      warnings: [{
        ruleId: "P-BILL",
        code: "BILLABLE_MAY_CHANGE",
        message: "Clockify may change the billable status of this entry based on workspace settings.",
      }],
      blockers: [],
      actionRequired: [],
      fidelity: "FULL",
    });
    expect(entries.claimForActivePlan(server.db, {
      id: entry.id,
      scope: SCOPE,
      planId: "plan-billable-override",
      claimToken: "attempt-billable-override",
      now: new Date("2026-08-08T09:01:00Z"),
    }).kind).toBe("claimed");
    insertAttemptFixture(server.db, {
      id: "attempt-billable-override",
      planId: "plan-billable-override",
      recoverableEntryId: entry.id,
      startedAt: "2026-08-08T09:01:01Z",
      baseline: [],
    });
    finishAmbiguousFixture(server.db, "attempt-billable-override");
    entries.setAmbiguous(server.db, {
      id: entry.id,
      scope: SCOPE,
      claimToken: "attempt-billable-override",
    });

    const candidateId = "clockify-billable-override";
    vi.stubGlobal("fetch", (async (input, init) => {
      const path = pathOf(input);
      const method = methodOf(input, init);
      if (method === "GET" && path.endsWith(`/time-entries/${candidateId}`)) {
        return jsonResponse(candidateEntry(candidateId, description, { billable: true }));
      }
      return jsonResponse({ message: "unstubbed" }, 404);
    }) as typeof fetch);

    const adopted = await server.addon.handle({
      method: "POST",
      path: "/api/entries/resolve-ambiguous",
      query: new URLSearchParams(),
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: { entryId: entry.id, newEntryId: candidateId },
    });
    expect(adopted.status).toBe(200);
    expect(entries.getById(server.db, SCOPE, entry.id)).toMatchObject({
      lifecycleState: "RECREATED",
      newEntryId: candidateId,
    });
    expect(attempts.getById(server.db, "attempt-billable-override")).toMatchObject({
      outcome: "SUCCESS",
      diffs: [{ field: "billable", planned: false, actual: true }],
    });

    let replayReads = 0;
    vi.stubGlobal("fetch", (async () => {
      replayReads += 1;
      return jsonResponse({ message: "must not be called" }, 500);
    }) as typeof fetch);
    const replay = await server.addon.handle({
      method: "POST",
      path: "/api/entries/recreate",
      query: new URLSearchParams(),
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: { entryId: entry.id, planId: "plan-billable-override" },
    });
    expect(replay.status).toBe(409);
    expect(replayReads).toBe(0);
  });

  it("returns an eligible mark-not-created action without refreshing its reconcile window", async () => {
    const { server, keys } = await boot();
    const token = await install(server, keys);
    const { entry } = seedEligibleAmbiguous(server, {
      entryId: "re-mark-eligible",
      attemptId: "attempt-mark-eligible",
      planId: "plan-mark-eligible",
      description: "mark-not-created-eligible",
    });
    let clockifyReads = 0;
    vi.stubGlobal("fetch", (async () => {
      clockifyReads += 1;
      return jsonResponse([]);
    }) as typeof fetch);

    const detail = await server.addon.handle({
      method: "GET",
      path: "/api/entries/detail",
      query: new URLSearchParams({ id: entry.id }),
      headers: { authorization: `Bearer ${token}` },
    });
    expect(detail.status).toBe(200);
    expect((detail.body as { canMarkNotCreated: boolean }).canMarkNotCreated).toBe(true);
    expect(clockifyReads).toBe(0);

    const marked = await server.addon.handle({
      method: "POST",
      path: "/api/entries/mark-not-created",
      query: new URLSearchParams(),
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: { entryId: entry.id },
    });
    expect(marked.status).toBe(200);
    expect((marked.body as { entry: { lifecycleState: string } }).entry.lifecycleState).toBe("IDLE");
    expect(attempts.getById(server.db, "attempt-mark-eligible")).toMatchObject({
      baseline: null,
      reconcile: null,
    });
    expect(clockifyReads).toBe(0);
  });

  it("rejects three rapid zero-match checks that do not span ten minutes", async () => {
    const { server, keys } = await boot();
    const token = await install(server, keys);
    const { entry } = seedEligibleAmbiguous(server, {
      entryId: "re-rapid-checks",
      attemptId: "attempt-rapid-checks",
      planId: "plan-rapid-checks",
      description: "rapid-checks",
    });
    const now = new Date();
    setReconcileFixture(server.db, "attempt-rapid-checks", {
      firstEligibleCheckAt: new Date(now.getTime() - 2 * 60 * 1000).toISOString(),
      checkedAt: now.toISOString(),
      checks: 3,
      matchCount: 0,
      candidateIds: [],
      truncated: false,
    });

    const result = await server.addon.handle({
      method: "POST",
      path: "/api/entries/mark-not-created",
      query: new URLSearchParams(),
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: { entryId: entry.id },
    });
    expect(result.status).toBe(409);
    expect(entries.getById(server.db, SCOPE, entry.id)?.lifecycleState).toBe("AMBIGUOUS");
  });

  it("accepts complete zero-match checks at t0, t5, and t10", async () => {
    const { server, keys } = await boot();
    const token = await install(server, keys);
    const { entry } = seedEligibleAmbiguous(server, {
      entryId: "re-spanning-checks",
      attemptId: "attempt-spanning-checks",
      planId: "plan-spanning-checks",
      description: "spanning-checks",
    });
    const latest = new Date();
    setReconcileFixture(server.db, "attempt-spanning-checks", {
      firstEligibleCheckAt: new Date(latest.getTime() - 10 * 60 * 1000).toISOString(),
      checkedAt: latest.toISOString(),
      checks: 3,
      matchCount: 0,
      candidateIds: [],
      truncated: false,
    });

    const result = await server.addon.handle({
      method: "POST",
      path: "/api/entries/mark-not-created",
      query: new URLSearchParams(),
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: { entryId: entry.id },
    });
    expect(result.status).toBe(200);
    expect(entries.getById(server.db, SCOPE, entry.id)?.lifecycleState).toBe("IDLE");
  });

  it("fails closed for legacy timing evidence and for a backward clock", async () => {
    const { server, keys } = await boot();
    const token = await install(server, keys);
    const legacy = seedEligibleAmbiguous(server, {
      entryId: "re-legacy-checks",
      attemptId: "attempt-legacy-checks",
      planId: "plan-legacy-checks",
      description: "legacy-checks",
    }).entry;
    const rollback = seedEligibleAmbiguous(server, {
      entryId: "re-rollback-checks",
      attemptId: "attempt-rollback-checks",
      planId: "plan-rollback-checks",
      description: "rollback-checks",
    }).entry;
    const now = new Date();
    setReconcileFixture(server.db, "attempt-legacy-checks", {
      checkedAt: now.toISOString(),
      checks: 99,
      matchCount: 0,
      candidateIds: [],
      truncated: false,
    });
    setReconcileFixture(server.db, "attempt-rollback-checks", {
      firstEligibleCheckAt: now.toISOString(),
      checkedAt: new Date(now.getTime() - 10 * 60 * 1000).toISOString(),
      checks: 3,
      matchCount: 0,
      candidateIds: [],
      truncated: false,
    });

    for (const entry of [legacy, rollback]) {
      const result = await server.addon.handle({
        method: "POST",
        path: "/api/entries/mark-not-created",
        query: new URLSearchParams(),
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: { entryId: entry.id },
      });
      expect(result.status).toBe(409);
    }
  });

  it("omits baselines and private timing, but retains known candidates only for the current ambiguity", async () => {
    const { server, keys } = await boot();
    const token = await install(server, keys);
    const { entry } = seedEligibleAmbiguous(server, {
      entryId: "re-private-wire",
      attemptId: "attempt-private-wire",
      planId: "plan-private-wire",
      description: "private-wire",
    });
    setReconcileFixture(server.db, "attempt-private-wire", {
      firstEligibleCheckAt: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
      checkedAt: new Date().toISOString(),
      checks: 2,
      matchCount: 0,
      candidateIds: ["known-positive-candidate"],
      truncated: true,
    });
    server.db.prepare("UPDATE recreation_attempts SET outcome='AMBIGUOUS' WHERE id=?").run("attempt-private-wire");

    const readDetail = () => server.addon.handle({
      method: "GET",
      path: "/api/entries/detail",
      query: new URLSearchParams({ id: entry.id }),
      headers: { authorization: `Bearer ${token}` },
    });
    const ambiguous = await readDetail();
    const ambiguousAttempt = (ambiguous.body as { attempts: Array<Record<string, unknown>> }).attempts[0]!;
    expect(ambiguousAttempt).not.toHaveProperty("baseline");
    expect(ambiguousAttempt.reconcile).toMatchObject({ candidateIds: ["known-positive-candidate"], truncated: true });
    expect(ambiguousAttempt.reconcile).not.toHaveProperty("firstEligibleCheckAt");

    server.db.prepare("UPDATE recoverable_entries SET lifecycle_state='FAILED' WHERE id=?").run(entry.id);
    const finalized = await readDetail();
    const finalizedAttempt = (finalized.body as { attempts: Array<Record<string, unknown>> }).attempts[0]!;
    expect(finalizedAttempt).not.toHaveProperty("baseline");
    expect(finalizedAttempt.reconcile).not.toHaveProperty("candidateIds");
    expect(finalizedAttempt.reconcile).not.toHaveProperty("firstEligibleCheckAt");
  });

  it("blocks mark-not-created while an automatic reconcile read is in flight", async () => {
    const { server, keys } = await boot();
    const token = await install(server, keys);
    const { entry } = seedEligibleAmbiguous(server, {
      entryId: "re-auto-fence",
      attemptId: "attempt-auto-fence",
      planId: "plan-auto-fence",
      description: "automatic-inflight-fence",
    });

    let releaseRead!: () => void;
    const readReleased = new Promise<void>((resolve) => { releaseRead = resolve; });
    let signalRead!: () => void;
    const readStarted = new Promise<void>((resolve) => { signalRead = resolve; });
    vi.stubGlobal("fetch", (async (input) => {
      const path = pathOf(input);
      if (path.endsWith("/time-entries") && path.includes("/user/")) {
        signalRead();
        await readReleased;
        return jsonResponse([]);
      }
      return jsonResponse({ message: "unstubbed" }, 404);
    }) as typeof fetch);

    const reconcileRequest = server.addon.handle({
      method: "POST",
      path: "/api/entries/reconcile",
      query: new URLSearchParams(),
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: { entryId: entry.id },
    });
    await readStarted;
    const whilePending = await server.addon.handle({
      method: "POST",
      path: "/api/entries/mark-not-created",
      query: new URLSearchParams(),
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: { entryId: entry.id },
    });
    releaseRead();
    const reconciled = await reconcileRequest;

    expect(whilePending.status).toBe(409);
    expect(reconciled.status).toBe(200);
    expect((reconciled.body as { result: { kind: string } }).result.kind).toBe("none");
    expect(entries.getById(server.db, SCOPE, entry.id)?.lifecycleState).toBe("AMBIGUOUS");

    // The prior three checks already span the documented window, so this complete no-match read
    // keeps the action eligible without using the browser clock.
    const summary = attempts.getById(server.db, "attempt-auto-fence")?.reconcile;
    expect(summary?.checks).toBe(4);
    const afterWindow = await server.addon.handle({
      method: "POST",
      path: "/api/entries/mark-not-created",
      query: new URLSearchParams(),
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: { entryId: entry.id },
    });
    expect(afterWindow.status).toBe(200);
    expect((afterWindow.body as { entry: { lifecycleState: string } }).entry.lifecycleState).toBe("IDLE");
  });

  it("blocks mark-not-created while a manual candidate read is in flight", async () => {
    const { server, keys } = await boot();
    const token = await install(server, keys);
    const description = "manual-inflight-fence";
    const { entry } = seedEligibleAmbiguous(server, {
      entryId: "re-manual-fence",
      attemptId: "attempt-manual-fence",
      planId: "plan-manual-fence",
      description,
    });
    const candidateId = "candidate-manual-fence";

    let releaseRead!: () => void;
    const readReleased = new Promise<void>((resolve) => { releaseRead = resolve; });
    let signalRead!: () => void;
    const readStarted = new Promise<void>((resolve) => { signalRead = resolve; });
    let candidateReads = 0;
    vi.stubGlobal("fetch", (async (input) => {
      const path = pathOf(input);
      if (path.endsWith(`/time-entries/${candidateId}`)) {
        candidateReads += 1;
        if (candidateReads === 1) {
          signalRead();
          await readReleased;
        }
        return jsonResponse(candidateEntry(candidateId, description));
      }
      return jsonResponse({ message: "unstubbed" }, 404);
    }) as typeof fetch);

    const resolveRequest = server.addon.handle({
      method: "POST",
      path: "/api/entries/resolve-ambiguous",
      query: new URLSearchParams(),
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: { entryId: entry.id, newEntryId: candidateId },
    });
    await readStarted;
    const whilePending = await server.addon.handle({
      method: "POST",
      path: "/api/entries/mark-not-created",
      query: new URLSearchParams(),
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: { entryId: entry.id },
    });
    releaseRead();
    const resolved = await resolveRequest;

    expect(whilePending.status).toBe(409);
    expect(resolved.status).toBe(200);
    expect(candidateReads).toBe(1);
    expect(entries.getById(server.db, SCOPE, entry.id)).toMatchObject({
      lifecycleState: "RECREATED",
      newEntryId: candidateId,
    });
  });

  it("manual adoption refuses a result when a replacement attempt starts during the Clockify read", async () => {
    const { server, keys } = await boot();
    const db = server.db;
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
          apiUrl: "https://developer.clockify.me/api",
        }),
        { path: "/lifecycle/installed" },
      ),
    );

    const description = "stale-manual-adoption";
    const entry = ingestEntry(db, {
      id: "re-stale",
      scope: SCOPE,
      sourceEntryId: "src-stale",
      ownerId: OWNER_ID,
      detectedAt: "2026-08-08T09:00:00Z",
      source: sourceFor("src-stale", description),
    }).entry;
    const planned = plannedFor(description);
    plans.createActive(db, {
      id: "plan-stale-a",
      recoverableEntryId: entry.id,
      createdBy: OWNER_ID,
      createdAt: "2026-08-08T09:00:30Z",
      sourceHash: "h",
      choices: {},
      resolution: [],
      presentation: { project: null, task: null, tags: [], customFields: [], editable: [] },
      plannedRequest: planned,
      warnings: [],
      blockers: [],
      actionRequired: [],
      fidelity: "FULL",
    });
    entries.claim(db, {
      id: entry.id,
      scope: SCOPE,
      claimToken: "attempt-stale-a",
      now: new Date("2026-08-08T09:01:00Z"),
    });
    insertAttemptFixture(db, {
      id: "attempt-stale-a",
      planId: "plan-stale-a",
      recoverableEntryId: entry.id,
      startedAt: "2026-08-08T09:01:01Z",
      baseline: [],
    });
    finishAmbiguousFixture(db, "attempt-stale-a");
    entries.setAmbiguous(db, {
      id: entry.id,
      scope: SCOPE,
      claimToken: "attempt-stale-a",
    });

    const candidateId = "clockify-stale-candidate";
    vi.stubGlobal("fetch", (async (input, init) => {
      const path = pathOf(input);
      const method = methodOf(input, init);
      if (method === "GET" && path.endsWith(`/time-entries/${candidateId}`)) {
        entries.markNotCreated(db, SCOPE, entry.id);
        plans.createActive(db, {
          id: "plan-stale-b",
          recoverableEntryId: entry.id,
          createdBy: OWNER_ID,
          createdAt: "2026-08-08T09:02:00Z",
          sourceHash: "h",
          choices: {},
          resolution: [],
          presentation: { project: null, task: null, tags: [], customFields: [], editable: [] },
          plannedRequest: planned,
          warnings: [],
          blockers: [],
          actionRequired: [],
          fidelity: "FULL",
        });
        entries.claim(db, {
          id: entry.id,
          scope: SCOPE,
          claimToken: "attempt-stale-b",
          now: new Date("2026-08-08T09:02:01Z"),
        });
        insertAttemptFixture(db, {
          id: "attempt-stale-b",
          planId: "plan-stale-b",
          recoverableEntryId: entry.id,
          startedAt: "2026-08-08T09:02:02Z",
          baseline: [],
        });
        finishAmbiguousFixture(db, "attempt-stale-b");
        entries.setAmbiguous(db, {
          id: entry.id,
          scope: SCOPE,
          claimToken: "attempt-stale-b",
        });
        return jsonResponse(candidateEntry(candidateId, description));
      }
      return jsonResponse({ message: "unstubbed" }, 404);
    }) as typeof fetch);
    const viewerToken = await signTestToken(keys.privateKey, ADDON_KEY, {
      workspaceId: WORKSPACE_ID,
      addonId: ADDON_ID,
      user: OWNER_ID,
      workspaceRole: "member",
    });

    const response = await server.addon.handle({
      method: "POST",
      path: "/api/entries/resolve-ambiguous",
      query: new URLSearchParams(),
      headers: { authorization: `Bearer ${viewerToken}`, "content-type": "application/json" },
      body: { entryId: entry.id, newEntryId: candidateId },
    });

    expect(response.status).toBe(409);
    expect(response.body).toEqual({
      error: "the entry or recreation attempt changed; check the entry again",
    });
    expect(entries.getById(db, SCOPE, entry.id)).toMatchObject({
      lifecycleState: "AMBIGUOUS",
      newEntryId: null,
    });
    expect(attempts.getById(db, "attempt-stale-a")?.outcome).toBe("AMBIGUOUS");
    expect(attempts.getById(db, "attempt-stale-b")?.outcome).toBe("AMBIGUOUS");
  });
});
