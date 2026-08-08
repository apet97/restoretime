// IT-04, IT-05, IT-08, IT-13 (docs/13). Real SQLite temp file + a stub `fetch` injected into
// `createClockifyClient` (docs/13 mock-transport contract): the Clockify SDK stays real, only the
// network is stubbed, so real SDK error classes (ClockifyApiTimeoutError, ClockifyApiError) drive
// the classification under test.
import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClockifyClient } from "clockify-sdk-ts-115";
import { openDatabase } from "../../src/store/db.js";
import * as entries from "../../src/store/entries.js";
import * as plans from "../../src/store/plans.js";
import { createSqliteInstallationStore, markInstallationBroken } from "../../src/platform/installations.js";
import { attemptRecreation, runReconcile } from "../../src/clockify/recreate.js";
import type { DeletedTimeEntry, PlannedRequest } from "../../src/domain/entry.js";

const WORKSPACE_ID = "ws-1";
const USER_ID = "user-1";

let dir: string;

function freshDb() {
  dir = mkdtempSync(join(tmpdir(), "restoretime-mutation-it-"));
  return openDatabase(join(dir, "restoretime.sqlite"));
}

afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function pathOf(input: string | URL | Request): string {
  const raw = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
  return new URL(raw).pathname;
}

/** The SDK's request layer builds a `Request` object (method baked in) and calls
 * `fetch(request)` with no separate `init` — `init?.method` alone would always read "GET". */
function methodOf(input: string | URL | Request, init?: RequestInit): string {
  return (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
}

const SOURCE: DeletedTimeEntry = {
  workspaceId: WORKSPACE_ID,
  entryId: "entry-a",
  ownerId: USER_ID,
  ownerName: "User One",
  description: "hello",
  billable: true,
  start: "2026-08-08T10:00:00Z",
  end: "2026-08-08T11:00:00Z",
  wasRunning: false,
  type: "REGULAR",
  timeZone: "UTC",
  projectId: "proj-1",
  projectName: "Project One",
  clientName: null,
  taskId: null,
  taskName: null,
  tags: [],
  customFieldValues: [],
};

function seedEntry(db: ReturnType<typeof freshDb>) {
  return entries.ingestDeletedEntry(db, {
    id: "re-1",
    workspaceId: WORKSPACE_ID,
    sourceEntryId: "entry-a",
    ownerId: USER_ID,
    detectedAt: "2026-08-08T09:00:00Z",
    source: SOURCE,
  }).entry;
}

const PLANNED: PlannedRequest = {
  workspaceId: WORKSPACE_ID,
  userId: USER_ID,
  start: SOURCE.start,
  end: "2026-08-08T11:00:00Z",
  description: SOURCE.description,
  billable: SOURCE.billable,
  projectId: "proj-1",
};

function seedPlan(db: ReturnType<typeof freshDb>, recoverableEntryId: string) {
  return plans.createActive(db, {
    id: "plan-1",
    recoverableEntryId,
    createdBy: USER_ID,
    createdAt: "2026-08-08T09:00:30.000Z",
    sourceHash: "hash",
    choices: {},
    resolution: [],
    plannedRequest: PLANNED,
    warnings: [],
    blockers: [],
    actionRequired: [],
    fidelity: "FULL",
  });
}

function candidateEntry(overrides: Record<string, unknown> = {}) {
  return {
    id: "new-entry-1",
    workspaceId: WORKSPACE_ID,
    userId: USER_ID,
    description: "hello",
    billable: true,
    isLocked: false,
    projectId: "proj-1",
    tagIds: [],
    type: "REGULAR",
    timeInterval: { start: "2026-08-08T10:00:00Z", end: "2026-08-08T11:00:00Z" },
    ...overrides,
  };
}

describe("IT-13 create succeeds, verification read fails after read-retries", () => {
  it("still RECREATED; the diff falls back to the 201 body and records the fallback note", async () => {
    const db = freshDb();
    const entry = seedEntry(db);
    seedPlan(db, entry.id);
    entries.claim(db, { id: entry.id, workspaceId: WORKSPACE_ID, claimToken: "tok-1", now: new Date("2026-08-08T09:01:00Z") });

    const fetchStub: typeof fetch = async (input, init) => {
      const path = pathOf(input);
      const method = methodOf(input, init);
      if (method === "GET" && path.endsWith("/time-entries") && path.includes("/user/")) return jsonResponse([]); // baseline: empty
      if (method === "POST" && path.endsWith("/time-entries")) return jsonResponse(candidateEntry(), 201);
      if (method === "GET" && path.includes("/time-entries/new-entry-1")) return jsonResponse({ message: "server hiccup" }, 500);
      return jsonResponse({ message: "unstubbed" }, 404);
    };
    const client = createClockifyClient({ addonToken: "tok", baseUrl: "https://developer.clockify.me/api/v1", timeoutInSeconds: 30, fetch: fetchStub });

    const result = await attemptRecreation({
      db,
      client,
      entryId: entry.id,
      workspaceId: WORKSPACE_ID,
      planId: "plan-1",
      plannedRequest: PLANNED,
      claimToken: "tok-1",
      recreatedBy: USER_ID,
      now: new Date("2026-08-08T09:02:00Z"),
    });

    expect(result.outcome).toBe("RECREATED");
    if (result.outcome !== "RECREATED") throw new Error("expected RECREATED");
    expect(result.newEntryId).toBe("new-entry-1");
    expect(result.diffs.some((d) => d.field === "_verification" && d.actual === "verification read unavailable")).toBe(true);

    const row = entries.getById(db, WORKSPACE_ID, entry.id);
    expect(row?.lifecycleState).toBe("RECREATED");
    expect(row?.newEntryId).toBe("new-entry-1");
  });
});

describe("IT-05 dependency deleted between plan and create", () => {
  it("a 4xx create rejection -> FAILED with the mapped reason; nothing created", async () => {
    const db = freshDb();
    const entry = seedEntry(db);
    seedPlan(db, entry.id);
    entries.claim(db, { id: entry.id, workspaceId: WORKSPACE_ID, claimToken: "tok-1", now: new Date("2026-08-08T09:01:00Z") });

    const fetchStub: typeof fetch = async (input, init) => {
      const path = pathOf(input);
      const method = methodOf(input, init);
      if (method === "GET" && path.endsWith("/time-entries") && path.includes("/user/")) return jsonResponse([]);
      if (method === "POST" && path.endsWith("/time-entries")) {
        return jsonResponse({ message: "Project doesn't belong to Workspace", code: 501 }, 400);
      }
      return jsonResponse({ message: "unstubbed" }, 404);
    };
    const client = createClockifyClient({ addonToken: "tok", baseUrl: "https://developer.clockify.me/api/v1", timeoutInSeconds: 30, fetch: fetchStub });

    const result = await attemptRecreation({
      db,
      client,
      entryId: entry.id,
      workspaceId: WORKSPACE_ID,
      planId: "plan-1",
      plannedRequest: PLANNED,
      claimToken: "tok-1",
      recreatedBy: USER_ID,
      now: new Date("2026-08-08T09:02:00Z"),
    });

    expect(result.outcome).toBe("FAILED");
    if (result.outcome !== "FAILED") throw new Error("expected FAILED");
    expect(result.status).toBe(400);
    expect(result.code).toBe("501");

    const row = entries.getById(db, WORKSPACE_ID, entry.id);
    expect(row?.lifecycleState).toBe("FAILED");
    expect(row?.newEntryId).toBeNull();
  });
});

describe("IT-08 addon token rejected (401 code 4017)", () => {
  it("marks the installation broken without disturbing the user-facing status", async () => {
    const db = freshDb();
    db.prepare(
      `INSERT INTO installations (workspace_id, addon_id, addon_user_id, as_user, api_url, auth_token, installed_at)
       VALUES (?, 'addon-1', 'addon-user-1', 'user-1', 'https://developer.clockify.me/api', 'tok', 1000)`,
    ).run(WORKSPACE_ID);
    const entry = seedEntry(db);
    seedPlan(db, entry.id);
    entries.claim(db, { id: entry.id, workspaceId: WORKSPACE_ID, claimToken: "tok-1", now: new Date("2026-08-08T09:01:00Z") });

    const fetchStub: typeof fetch = async (input, init) => {
      const path = pathOf(input);
      const method = methodOf(input, init);
      if (method === "GET" && path.endsWith("/time-entries") && path.includes("/user/")) return jsonResponse([]);
      if (method === "POST" && path.endsWith("/time-entries")) {
        return jsonResponse({ message: "Addon token invalid", code: 4017 }, 401);
      }
      return jsonResponse({ message: "unstubbed" }, 404);
    };
    const client = createClockifyClient({ addonToken: "tok", baseUrl: "https://developer.clockify.me/api/v1", timeoutInSeconds: 30, fetch: fetchStub });

    let markedBroken = false;
    const result = await attemptRecreation({
      db,
      client,
      entryId: entry.id,
      workspaceId: WORKSPACE_ID,
      planId: "plan-1",
      plannedRequest: PLANNED,
      claimToken: "tok-1",
      recreatedBy: USER_ID,
      now: new Date("2026-08-08T09:02:00Z"),
      // The production callback, not a test double: routes.ts wires exactly this.
      onAddonTokenInvalid: () => {
        markedBroken = true;
        markInstallationBroken(db, WORKSPACE_ID, "addon-1", "2026-08-08T09:02:00Z");
      },
    });

    expect(result.outcome).toBe("FAILED");
    expect(markedBroken).toBe(true);
    const row = db
      .prepare("SELECT status, broken_at FROM installations WHERE workspace_id = ?")
      .get(WORKSPACE_ID) as { status: string; broken_at: string | null };
    expect(row.broken_at).toBe("2026-08-08T09:02:00Z");
    // A rejected token is not the same condition as a user disabling the addon: docs/14 and
    // docs/10 §8 prescribe different notices, so `status` must stay untouched.
    expect(row.status).toBe("ACTIVE");
  });

  it("a reinstall clears the broken flag", async () => {
    const db = freshDb();
    db.prepare(
      `INSERT INTO installations (workspace_id, addon_id, addon_user_id, as_user, api_url, auth_token, installed_at)
       VALUES (?, 'addon-1', 'addon-user-1', 'user-1', 'https://developer.clockify.me/api', 'tok', 1000)`,
    ).run(WORKSPACE_ID);
    markInstallationBroken(db, WORKSPACE_ID, "addon-1", "2026-08-08T09:02:00Z");

    const store = createSqliteInstallationStore(db);
    await store.save({
      workspaceId: WORKSPACE_ID,
      addonId: "addon-1",
      addonUserId: "addon-user-1",
      asUser: "user-1",
      apiUrl: "https://developer.clockify.me/api",
      authToken: "fresh-token",
      installedAt: 2000,
    });

    const row = db
      .prepare("SELECT broken_at FROM installations WHERE workspace_id = ?")
      .get(WORKSPACE_ID) as { broken_at: string | null };
    expect(row.broken_at).toBeNull();
  });
});

describe("IT-04 ambiguous protocol", () => {
  it("commit-lost: the create times out but Clockify committed it -> reconcile adopts -> RECREATED", async () => {
    const db = freshDb();
    const entry = seedEntry(db);
    seedPlan(db, entry.id);
    entries.claim(db, { id: entry.id, workspaceId: WORKSPACE_ID, claimToken: "tok-1", now: new Date("2026-08-08T09:01:00Z") });

    // The create "commits" server-side but the client never sees the response (simulated via a
    // very short client timeout racing a deliberately slow POST response).
    const fetchStub: typeof fetch = async (input, init) => {
      const path = pathOf(input);
      const method = methodOf(input, init);
      if (method === "GET" && path.endsWith("/time-entries") && path.includes("/user/")) return jsonResponse([]);
      if (method === "POST" && path.endsWith("/time-entries")) {
        await new Promise((resolve) => setTimeout(resolve, 150));
        return jsonResponse(candidateEntry(), 201);
      }
      return jsonResponse({ message: "unstubbed" }, 404);
    };
    const client = createClockifyClient({ addonToken: "tok", baseUrl: "https://developer.clockify.me/api/v1", timeoutInSeconds: 0.02, fetch: fetchStub });

    const result = await attemptRecreation({
      db,
      client,
      entryId: entry.id,
      workspaceId: WORKSPACE_ID,
      planId: "plan-1",
      plannedRequest: PLANNED,
      claimToken: "tok-1",
      recreatedBy: USER_ID,
      now: new Date("2026-08-08T09:02:00Z"),
    });
    expect(result.outcome).toBe("AMBIGUOUS");
    expect(entries.getById(db, WORKSPACE_ID, entry.id)?.lifecycleState).toBe("AMBIGUOUS");

    // Reconcile: this time the read client is not the slow/timing-out one — the entry is findable.
    const reconcileFetch: typeof fetch = async (input) => {
      const path = pathOf(input);
      if (path.endsWith("/time-entries") && path.includes("/user/")) return jsonResponse([candidateEntry()]);
      return jsonResponse({ message: "unstubbed" }, 404);
    };
    const reconcileClient = createClockifyClient({ addonToken: "tok", baseUrl: "https://developer.clockify.me/api/v1", timeoutInSeconds: 30, fetch: reconcileFetch });

    const reconcileResult = await runReconcile({
      db,
      client: reconcileClient,
      entryId: entry.id,
      workspaceId: WORKSPACE_ID,
      userId: USER_ID,
      plannedRequest: PLANNED,
      baseline: [],
      recreatedBy: "viewer-1",
      now: new Date("2026-08-08T09:03:00Z"),
    });
    expect(reconcileResult).toEqual({ kind: "adopted", newEntryId: "new-entry-1" });
    const row = entries.getById(db, WORKSPACE_ID, entry.id);
    expect(row?.lifecycleState).toBe("RECREATED");
    expect(row?.newEntryId).toBe("new-entry-1");
  });

  it("nothing-committed: reconcile finds no match -> stays AMBIGUOUS -> user marks 'not created' -> IDLE", async () => {
    const db = freshDb();
    const entry = seedEntry(db);
    seedPlan(db, entry.id);
    entries.claim(db, { id: entry.id, workspaceId: WORKSPACE_ID, claimToken: "tok-1", now: new Date("2026-08-08T09:01:00Z") });
    entries.setAmbiguous(db, { id: entry.id, workspaceId: WORKSPACE_ID, claimToken: "tok-1" });

    const emptyFetch: typeof fetch = async (input) => {
      const path = pathOf(input);
      if (path.endsWith("/time-entries") && path.includes("/user/")) return jsonResponse([]);
      return jsonResponse({ message: "unstubbed" }, 404);
    };
    const client = createClockifyClient({ addonToken: "tok", baseUrl: "https://developer.clockify.me/api/v1", timeoutInSeconds: 30, fetch: emptyFetch });

    const reconcileResult = await runReconcile({
      db,
      client,
      entryId: entry.id,
      workspaceId: WORKSPACE_ID,
      userId: USER_ID,
      plannedRequest: PLANNED,
      baseline: [],
      recreatedBy: "viewer-1",
      now: new Date("2026-08-08T09:03:00Z"),
    });
    expect(reconcileResult).toEqual({ kind: "none" });
    expect(entries.getById(db, WORKSPACE_ID, entry.id)?.lifecycleState).toBe("AMBIGUOUS");

    // Bounded window elapsed; the user confirms "not created".
    const marked = entries.markNotCreated(db, WORKSPACE_ID, entry.id);
    expect(marked?.lifecycleState).toBe("IDLE");
  });

  it("two candidates: reconcile stays AMBIGUOUS and reports both, never auto-adopting", async () => {
    const db = freshDb();
    const entry = seedEntry(db);
    seedPlan(db, entry.id);
    entries.claim(db, { id: entry.id, workspaceId: WORKSPACE_ID, claimToken: "tok-1", now: new Date("2026-08-08T09:01:00Z") });
    entries.setAmbiguous(db, { id: entry.id, workspaceId: WORKSPACE_ID, claimToken: "tok-1" });

    const twoMatchesFetch: typeof fetch = async (input) => {
      const path = pathOf(input);
      if (path.endsWith("/time-entries") && path.includes("/user/")) {
        return jsonResponse([candidateEntry({ id: "cand-1" }), candidateEntry({ id: "cand-2" })]);
      }
      return jsonResponse({ message: "unstubbed" }, 404);
    };
    const client = createClockifyClient({ addonToken: "tok", baseUrl: "https://developer.clockify.me/api/v1", timeoutInSeconds: 30, fetch: twoMatchesFetch });

    const reconcileResult = await runReconcile({
      db,
      client,
      entryId: entry.id,
      workspaceId: WORKSPACE_ID,
      userId: USER_ID,
      plannedRequest: PLANNED,
      baseline: [],
      recreatedBy: "viewer-1",
      now: new Date("2026-08-08T09:03:00Z"),
    });
    expect(reconcileResult).toEqual({ kind: "many", candidateIds: ["cand-1", "cand-2"] });
    expect(entries.getById(db, WORKSPACE_ID, entry.id)?.lifecycleState).toBe("AMBIGUOUS");
  });
});
