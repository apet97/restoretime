// LV-10 chaos-hook proof (docs/13, PASS-05 pass file). The `RT_CHAOS_FETCH` hook
// (src/clockify/chaos-fetch.ts, wired into `buildClockifyClient`) is the mechanism LV-10 depends
// on at release time; this test proves the mechanism itself works against a mocked transport —
// the only thing missing at release is the live credential (`CK_LIVE_API_KEY`). Same pattern as
// `tests/integration/mutation.test.ts`'s IT-04 ambiguous-protocol cases, but the transport
// failures come from the real chaos wrapper instead of a hand-built stub, and the client is built
// through `buildClockifyClient` (the app's own boundary, docs/03 §2) rather than
// `createClockifyClient` directly, so the hook's wiring into the real boundary is exercised too.
import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ClockifyApiError, ClockifyApiTimeoutError } from "clockify-sdk-ts-115";
import { openDatabase } from "../../src/store/db.js";
import * as entries from "../../src/store/entries.js";
import * as plans from "../../src/store/plans.js";
import { buildClockifyClient } from "../../src/clockify/client.js";
import { ChaosFetchInjectedError } from "../../src/clockify/chaos-fetch.js";
import { attemptRecreation, runReconcile } from "../../src/clockify/recreate.js";
import type { DeletedTimeEntry, PlannedRequest } from "../../src/domain/entry.js";

const WORKSPACE_ID = "ws-1";
const USER_ID = "user-1";

let dir: string;

function freshDb() {
  dir = mkdtempSync(join(tmpdir(), "restoretime-chaos-drill-"));
  return openDatabase(join(dir, "restoretime.sqlite"));
}

afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  delete process.env.RT_CHAOS_FETCH;
  vi.unstubAllEnvs();
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

describe("LV-10 chaos hook, mode lose-response (docs/13 LV-10(a))", () => {
  it("the real create POST is sent and committed, but the caller sees a ClockifyApiTimeoutError -> AMBIGUOUS; reconcile then adopts the committed entry -> RECREATED", async () => {
    const db = freshDb();
    const entry = seedEntry(db);
    seedPlan(db, entry.id);
    entries.claim(db, { id: entry.id, workspaceId: WORKSPACE_ID, claimToken: "tok-1", now: new Date("2026-08-08T09:01:00Z") });

    let createCalls = 0;
    const fetchStub: typeof fetch = async (input, init) => {
      const path = pathOf(input);
      const method = methodOf(input, init);
      if (method === "GET" && path.endsWith("/time-entries") && path.includes("/user/")) return jsonResponse([]);
      if (method === "POST" && path.endsWith("/time-entries")) {
        createCalls++;
        // The real transport really does commit — this is the response the chaos wrapper drains
        // and discards, never handing it to the SDK.
        return jsonResponse(candidateEntry(), 201);
      }
      return jsonResponse({ message: "unstubbed" }, 404);
    };

    process.env.RT_CHAOS_FETCH = "lose-response";
    const client = buildClockifyClient({ apiUrl: "https://developer.clockify.me/api", authToken: "tok" }, { fetch: fetchStub });

    let unexpectedError: unknown;
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
      onUnexpectedError: (err) => {
        unexpectedError = err;
      },
    });

    // The real POST was sent and "succeeded" server-side — the wrapper only lost the reply.
    expect(createCalls).toBe(1);
    expect(result.outcome).toBe("AMBIGUOUS");
    expect(entries.getById(db, WORKSPACE_ID, entry.id)?.lifecycleState).toBe("AMBIGUOUS");
    // The SDK classifies ClockifyApiTimeoutError as `possibly-committed`. The unexpected-error
    // reporter is only for `unknown`, so it must not fire here.
    expect(unexpectedError).toBeUndefined();

    // Reconcile: a fresh read (not through the chaos-wrapped client) finds the entry Clockify
    // really created and adopts it.
    delete process.env.RT_CHAOS_FETCH;
    const reconcileFetch: typeof fetch = async (input) => {
      const path = pathOf(input);
      if (path.endsWith("/time-entries") && path.includes("/user/")) return jsonResponse([candidateEntry()]);
      return jsonResponse({ message: "unstubbed" }, 404);
    };
    const reconcileClient = buildClockifyClient({ apiUrl: "https://developer.clockify.me/api", authToken: "tok" }, { fetch: reconcileFetch });

    const reconcileResult = await runReconcile({
      db,
      client: reconcileClient,
      entryId: entry.id,
      workspaceId: WORKSPACE_ID,
      userId: USER_ID,
      plannedRequest: PLANNED,
      baseline: [],
      expectedAttemptId: "tok-1",
      recreatedBy: "viewer-1",
      now: new Date("2026-08-08T09:03:00Z"),
    });
    expect(reconcileResult).toEqual({ kind: "adopted", newEntryId: "new-entry-1" });
    const row = entries.getById(db, WORKSPACE_ID, entry.id);
    expect(row?.lifecycleState).toBe("RECREATED");
    expect(row?.newEntryId).toBe("new-entry-1");
  });
});

describe("LV-10 chaos hook, mode fail-before-send (docs/13 LV-10(b))", () => {
  it("the create POST is never sent -> AMBIGUOUS; reconcile finds nothing -> stays AMBIGUOUS -> user marks not-created -> IDLE", async () => {
    const db = freshDb();
    const entry = seedEntry(db);
    seedPlan(db, entry.id);
    entries.claim(db, { id: entry.id, workspaceId: WORKSPACE_ID, claimToken: "tok-1", now: new Date("2026-08-08T09:01:00Z") });

    let createCalls = 0;
    const fetchStub: typeof fetch = async (input, init) => {
      const path = pathOf(input);
      const method = methodOf(input, init);
      if (method === "GET" && path.endsWith("/time-entries") && path.includes("/user/")) return jsonResponse([]);
      if (method === "POST" && path.endsWith("/time-entries")) {
        createCalls++;
        return jsonResponse(candidateEntry(), 201);
      }
      return jsonResponse({ message: "unstubbed" }, 404);
    };

    process.env.RT_CHAOS_FETCH = "fail-before-send";
    const client = buildClockifyClient({ apiUrl: "https://developer.clockify.me/api", authToken: "tok" }, { fetch: fetchStub });

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

    // Nothing was ever sent to Clockify.
    expect(createCalls).toBe(0);
    expect(result.outcome).toBe("AMBIGUOUS");

    delete process.env.RT_CHAOS_FETCH;
    const emptyFetch: typeof fetch = async (input) => {
      const path = pathOf(input);
      if (path.endsWith("/time-entries") && path.includes("/user/")) return jsonResponse([]);
      return jsonResponse({ message: "unstubbed" }, 404);
    };
    const reconcileClient = buildClockifyClient({ apiUrl: "https://developer.clockify.me/api", authToken: "tok" }, { fetch: emptyFetch });

    const reconcileResult = await runReconcile({
      db,
      client: reconcileClient,
      entryId: entry.id,
      workspaceId: WORKSPACE_ID,
      userId: USER_ID,
      plannedRequest: PLANNED,
      baseline: [],
      expectedAttemptId: "tok-1",
      recreatedBy: "viewer-1",
      now: new Date("2026-08-08T09:03:00Z"),
    });
    expect(reconcileResult).toEqual({ kind: "none" });
    expect(entries.getById(db, WORKSPACE_ID, entry.id)?.lifecycleState).toBe("AMBIGUOUS");

    const marked = entries.markNotCreated(db, WORKSPACE_ID, entry.id);
    expect(marked?.lifecycleState).toBe("IDLE");
  });
});

describe("the chaos hook itself is inert outside NODE_ENV=test", () => {
  it("with RT_CHAOS_FETCH=lose-response but NODE_ENV stubbed to a non-test value, the create call reaches the stub fetch untouched and succeeds normally", async () => {
    const db = freshDb();
    const entry = seedEntry(db);
    seedPlan(db, entry.id);
    entries.claim(db, { id: entry.id, workspaceId: WORKSPACE_ID, claimToken: "tok-1", now: new Date("2026-08-08T09:01:00Z") });

    let createCalls = 0;
    const fetchStub: typeof fetch = async (input, init) => {
      const path = pathOf(input);
      const method = methodOf(input, init);
      if (method === "GET" && path.endsWith("/time-entries") && path.includes("/user/")) return jsonResponse([]);
      if (method === "POST" && path.endsWith("/time-entries")) {
        createCalls++;
        return jsonResponse(candidateEntry(), 201);
      }
      if (method === "GET" && path.includes("/time-entries/new-entry-1")) return jsonResponse(candidateEntry());
      return jsonResponse({ message: "unstubbed" }, 404);
    };

    vi.stubEnv("NODE_ENV", "production");
    process.env.RT_CHAOS_FETCH = "lose-response"; // set, but must be ignored — the guard is NODE_ENV, not this flag alone
    try {
      const client = buildClockifyClient({ apiUrl: "https://developer.clockify.me/api", authToken: "tok" }, { fetch: fetchStub });
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
      expect(createCalls).toBe(1);
      expect(result.outcome).toBe("RECREATED");
    } finally {
      vi.unstubAllEnvs();
      delete process.env.RT_CHAOS_FETCH;
    }
  });

  it("an unrecognized RT_CHAOS_FETCH value under NODE_ENV=test is also inert (no crash, no interception)", async () => {
    const db = freshDb();
    const entry = seedEntry(db);
    seedPlan(db, entry.id);
    entries.claim(db, { id: entry.id, workspaceId: WORKSPACE_ID, claimToken: "tok-1", now: new Date("2026-08-08T09:01:00Z") });

    const fetchStub: typeof fetch = async (input, init) => {
      const path = pathOf(input);
      const method = methodOf(input, init);
      if (method === "GET" && path.endsWith("/time-entries") && path.includes("/user/")) return jsonResponse([]);
      if (method === "POST" && path.endsWith("/time-entries")) return jsonResponse(candidateEntry(), 201);
      if (method === "GET" && path.includes("/time-entries/new-entry-1")) return jsonResponse(candidateEntry());
      return jsonResponse({ message: "unstubbed" }, 404);
    };

    process.env.RT_CHAOS_FETCH = "not-a-real-mode";
    const client = buildClockifyClient({ apiUrl: "https://developer.clockify.me/api", authToken: "tok" }, { fetch: fetchStub });
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
  });
});

describe("the chaos hook only ever touches the createForUser POST", () => {
  it("a GET request (e.g. the baseline/reconcile listForUser read) is never intercepted, even while lose-response is active", async () => {
    let getCalls = 0;
    const fetchStub: typeof fetch = async (input, init) => {
      const path = pathOf(input);
      const method = methodOf(input, init);
      if (method === "GET" && path.endsWith("/time-entries") && path.includes("/user/")) {
        getCalls++;
        return jsonResponse([]);
      }
      return jsonResponse({ message: "unstubbed" }, 404);
    };

    process.env.RT_CHAOS_FETCH = "lose-response";
    const client = buildClockifyClient({ apiUrl: "https://developer.clockify.me/api", authToken: "tok" }, { fetch: fetchStub });
    // A plain listForUser read must resolve normally (proves the "createForUser POST only"
    // matcher, not "any request while chaos is active").
    const list = await client.timeEntries.listForUser({ workspaceId: WORKSPACE_ID, userId: USER_ID });
    expect(list).toEqual([]);
    expect(getCalls).toBe(1);
  });

  it("mode fail-before-send: the wrapper itself throws ChaosFetchInjectedError, which the SDK's request layer (not this app) then wraps as a ClockifyApiError with statusCode undefined and cause=ChaosFetchInjectedError — the same shape a genuine DNS/connection failure produces, and the exact class executeCreate's AMBIGUOUS branch 2 (docs/03 §3) matches on", async () => {
    const fetchStub: typeof fetch = async () => jsonResponse(candidateEntry(), 201);
    process.env.RT_CHAOS_FETCH = "fail-before-send";
    const client = buildClockifyClient({ apiUrl: "https://developer.clockify.me/api", authToken: "tok" }, { fetch: fetchStub });
    try {
      await client.timeEntries.createForUser({ workspaceId: WORKSPACE_ID, userId: USER_ID, start: SOURCE.start });
      expect.unreachable("createForUser must reject");
    } catch (err) {
      expect(err).toBeInstanceOf(ClockifyApiError);
      expect((err as ClockifyApiError).statusCode).toBeUndefined();
      expect((err as ClockifyApiError).cause).toBeInstanceOf(ChaosFetchInjectedError);
    }
  });

  it("mode lose-response rejects the createForUser call with ClockifyApiTimeoutError specifically", async () => {
    const fetchStub: typeof fetch = async () => jsonResponse(candidateEntry(), 201);
    process.env.RT_CHAOS_FETCH = "lose-response";
    const client = buildClockifyClient({ apiUrl: "https://developer.clockify.me/api", authToken: "tok" }, { fetch: fetchStub });
    await expect(
      client.timeEntries.createForUser({ workspaceId: WORKSPACE_ID, userId: USER_ID, start: SOURCE.start }),
    ).rejects.toThrow(ClockifyApiTimeoutError);
  });
});
