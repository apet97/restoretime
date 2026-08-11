// IT-07 / IT-09 extension (docs/13, docs/09, docs/12). Every `/api/*` route, against five
// forgeries: an expired token, a token signed for a different addon key, a forged/cross workspace
// (a verified viewer in a workspace that does not own the referenced row), a forged/other user (a
// verified member who is neither the entry's owner nor an admin), and a demoted admin (a member who
// previously created a plan on someone else's entry as admin). Each case asserts the exact failure
// mode docs/09 specifies (404 with no existence leak, or 403) and that no row changed underneath
// the rejected call.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateTestKeys, signTestToken, type ClockifyTestKeys } from "@apet97/clockify-addon-sdk/testing";
import type { AddonRequest } from "@apet97/clockify-addon-sdk";
import { createServer, type AppServer } from "../../src/server.js";
import type { AppConfig } from "../../src/config.js";
import * as entries from "../../src/store/entries.js";
import * as plans from "../../src/store/plans.js";
import type { DeletedTimeEntry } from "../../src/domain/entry.js";

const ADDON_KEY = "restoretime-permneg";
const OTHER_ADDON_KEY = "someone-elses-addon";
const WORKSPACE_ID = "ws-1";
const OTHER_WORKSPACE_ID = "ws-2";
const ADDON_ID = "addon-1";
const OWNER_ID = "user-1"; // entry owner, plain member
const OTHER_MEMBER_ID = "user-2"; // a different member — never had access
const DEMOTED_ADMIN_ID = "admin-1"; // created a plan as admin, then role dropped to member

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

const SOURCE: DeletedTimeEntry = {
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

let server: AppServer;
let entryId: string;
let planIdByDemotedAdmin: string;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "restoretime-permneg-"));
  keys = await generateTestKeys();
  server = await createServer(testConfig(), { publicKey: keys.publicKey });

  const { entry } = entries.ingestDeletedEntry(server.db, {
    id: "re-1",
    workspaceId: WORKSPACE_ID,
    sourceEntryId: "entry-a",
    ownerId: OWNER_ID,
    detectedAt: "2026-08-08T09:00:00Z",
    source: SOURCE,
  });
  entryId = entry.id;

  // A plan DEMOTED_ADMIN_ID created while still admin — the one case docs/09 marks 403, not 404.
  const plan = plans.createActive(server.db, {
    id: "plan-by-demoted-admin",
    recoverableEntryId: entryId,
    createdBy: DEMOTED_ADMIN_ID,
    createdAt: "2026-08-08T09:00:30.000Z",
    sourceHash: "hash",
    choices: {},
    resolution: [],
    plannedRequest: { workspaceId: WORKSPACE_ID, userId: OWNER_ID, start: SOURCE.start, end: "2026-08-08T11:00:00Z", description: SOURCE.description, billable: SOURCE.billable },
    warnings: [],
    blockers: [],
    actionRequired: [],
    fidelity: "FULL",
  });
  planIdByDemotedAdmin = plan.id;
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

async function tokenFor(opts: { workspaceId?: string; user?: string; role?: string; addonKey?: string; expiresIn?: string }): Promise<string> {
  return signTestToken(
    keys.privateKey,
    opts.addonKey ?? ADDON_KEY,
    {
      workspaceId: opts.workspaceId ?? WORKSPACE_ID,
      addonId: ADDON_ID,
      user: opts.user ?? OWNER_ID,
      workspaceRole: opts.role ?? "member",
    },
    opts.expiresIn ?? "30m",
  );
}

/** docs/13 says each case asserts "no row changed". The entry row alone is not enough: a refactor
 * that consumed the plan before the access check would leave the entry untouched while a forged
 * request burned another user's plan. Snapshot the plan status and the attempt count too. */
function snapshotRow() {
  const entry = entries.getById(server.db, WORKSPACE_ID, entryId);
  const planStatuses = server.db
    .prepare("SELECT id, status FROM recreation_plans WHERE recoverable_entry_id = ? ORDER BY id")
    .all(entryId);
  const attemptCount = server.db
    .prepare("SELECT COUNT(*) AS n FROM recreation_attempts WHERE recoverable_entry_id = ?")
    .get(entryId) as { n: number };
  return { entry, planStatuses, attemptCount: attemptCount.n };
}

function req(method: "GET" | "POST", path: string, token: string, body?: unknown, query?: Record<string, string>): AddonRequest {
  return {
    method,
    path,
    query: new URLSearchParams(query ?? {}),
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    ...(body !== undefined ? { body } : {}),
  };
}

// --- Route table --------------------------------------------------------------------------

interface RouteSpec {
  readonly name: string;
  readonly method: "GET" | "POST";
  readonly path: string;
  /** Builds the request body/query referencing THIS test's `entryId` (an owned, IDLE entry). */
  readonly build: () => { body?: unknown; query?: Record<string, string> };
  /** Whether this route is entry-scoped (participates in the cross-workspace / other-user / 404
   * existence-leak checks) or is a workspace-wide / admin-gated route that needs its own assertion. */
  readonly kind: "entry-scoped" | "workspace-wide" | "admin-only-bulk";
}

const ROUTES: readonly RouteSpec[] = [
  { name: "GET /api/entries", method: "GET", path: "/api/entries", build: () => ({}), kind: "workspace-wide" },
  { name: "GET /api/entries/detail", method: "GET", path: "/api/entries/detail", build: () => ({ query: { id: entryId } }), kind: "entry-scoped" },
  { name: "POST /api/entries/preflight", method: "POST", path: "/api/entries/preflight", build: () => ({ body: { entryId, choices: {} } }), kind: "entry-scoped" },
  { name: "POST /api/entries/reconcile", method: "POST", path: "/api/entries/reconcile", build: () => ({ body: { entryId } }), kind: "entry-scoped" },
  { name: "POST /api/entries/mark-not-created", method: "POST", path: "/api/entries/mark-not-created", build: () => ({ body: { entryId } }), kind: "entry-scoped" },
  { name: "POST /api/entries/resolve-ambiguous", method: "POST", path: "/api/entries/resolve-ambiguous", build: () => ({ body: { entryId, newEntryId: "some-id" } }), kind: "entry-scoped" },
  { name: "POST /api/entries/dismiss", method: "POST", path: "/api/entries/dismiss", build: () => ({ body: { entryId } }), kind: "entry-scoped" },
  { name: "POST /api/entries/undismiss", method: "POST", path: "/api/entries/undismiss", build: () => ({ body: { entryId } }), kind: "entry-scoped" },
  { name: "GET /api/options", method: "GET", path: "/api/options", build: () => ({ query: { kind: "projects" } }), kind: "workspace-wide" },
  { name: "POST /api/entries/bulk-preflight", method: "POST", path: "/api/entries/bulk-preflight", build: () => ({ body: { ids: [entryId] } }), kind: "admin-only-bulk" },
  { name: "POST /api/entries/bulk-recreate", method: "POST", path: "/api/entries/bulk-recreate", build: () => ({ body: { planIds: [planIdByDemotedAdmin] } }), kind: "admin-only-bulk" },
  // recreate is exercised separately below: it is the one route with the 403-not-404 asymmetry.
];

describe("detail lineage authorization", () => {
  it("hides another member's lineage while preserving same-owner and admin access", async () => {
    const foreignParent = entries.ingestDeletedEntry(server.db, {
      id: "foreign-parent",
      workspaceId: WORKSPACE_ID,
      sourceEntryId: "foreign-source",
      ownerId: OTHER_MEMBER_ID,
      detectedAt: "2026-08-08T08:00:00Z",
      source: {
        ...SOURCE,
        entryId: "foreign-source",
        ownerId: OTHER_MEMBER_ID,
        ownerName: "Other Member",
        description: "private lineage description",
      },
    }).entry;
    server.db.prepare(
      "UPDATE recoverable_entries SET parent_recoverable_id=? WHERE id=?",
    ).run(foreignParent.id, entryId);

    const memberToken = await tokenFor({ user: OWNER_ID, role: "member" });
    const member = await server.addon.handle(req(
      "GET",
      "/api/entries/detail",
      memberToken,
      undefined,
      { id: entryId },
    ));
    expect(member.status).toBe(200);
    expect((member.body as { lineage: { parent: unknown } }).lineage.parent).toBeNull();
    expect((member.body as { entry: { parentRecoverableId: string | null } }).entry.parentRecoverableId).toBeNull();
    const memberDetailJson = JSON.stringify(member.body);
    expect(memberDetailJson).not.toContain(foreignParent.id);
    expect(memberDetailJson).not.toContain("private lineage description");
    expect(memberDetailJson).not.toContain("Other Member");

    const memberList = await server.addon.handle(req("GET", "/api/entries", memberToken));
    expect(memberList.status).toBe(200);
    expect(JSON.stringify(memberList.body)).not.toContain(foreignParent.id);
    expect((memberList.body as {
      entries: Array<{ id: string; parentRecoverableId: string | null }>;
    }).entries.find((row) => row.id === entryId)?.parentRecoverableId).toBeNull();

    const ownParent = entries.ingestDeletedEntry(server.db, {
      id: "own-parent",
      workspaceId: WORKSPACE_ID,
      sourceEntryId: "own-source",
      ownerId: OWNER_ID,
      detectedAt: "2026-08-08T08:30:00Z",
      source: { ...SOURCE, entryId: "own-source", description: "owned lineage description" },
    }).entry;
    server.db.prepare(
      "UPDATE recoverable_entries SET parent_recoverable_id=? WHERE id=?",
    ).run(ownParent.id, entryId);
    const sameOwner = await server.addon.handle(req(
      "GET",
      "/api/entries/detail",
      memberToken,
      undefined,
      { id: entryId },
    ));
    expect(sameOwner.body).toMatchObject({
      entry: { parentRecoverableId: ownParent.id },
      lineage: { parent: { id: ownParent.id, source: { description: "owned lineage description" } } },
    });

    server.db.prepare(
      "UPDATE recoverable_entries SET parent_recoverable_id=? WHERE id=?",
    ).run(foreignParent.id, entryId);
    const admin = await server.addon.handle(req(
      "GET",
      "/api/entries/detail",
      await tokenFor({ user: DEMOTED_ADMIN_ID, role: "admin" }),
      undefined,
      { id: entryId },
    ));
    expect(admin.body).toMatchObject({
      entry: { parentRecoverableId: foreignParent.id },
      lineage: { parent: { id: foreignParent.id, source: { description: "private lineage description" } } },
    });
  });
});

describe("permission negatives sweep: expired token -> 401 on every route, no row changed", () => {
  for (const route of ROUTES) {
    it(route.name, async () => {
      const before = snapshotRow();
      const token = await tokenFor({ expiresIn: "-1s" });
      const { body, query } = route.build();
      const res = await server.addon.handle(req(route.method, route.path, token, body, query));
      expect(res.status).toBe(401);
      expect(snapshotRow()).toEqual(before);
    });
  }

  it("POST /api/entries/recreate", async () => {
    const before = snapshotRow();
    const token = await tokenFor({ expiresIn: "-1s" });
    const res = await server.addon.handle(req("POST", "/api/entries/recreate", token, { entryId, planId: planIdByDemotedAdmin }));
    expect(res.status).toBe(401);
    expect(snapshotRow()).toEqual(before);
  });
});

describe("permission negatives sweep: token signed for a different addon key -> 401 on every route, no row changed", () => {
  for (const route of ROUTES) {
    it(route.name, async () => {
      const before = snapshotRow();
      const token = await tokenFor({ addonKey: OTHER_ADDON_KEY });
      const { body, query } = route.build();
      const res = await server.addon.handle(req(route.method, route.path, token, body, query));
      expect(res.status).toBe(401);
      expect(snapshotRow()).toEqual(before);
    });
  }

  it("POST /api/entries/recreate", async () => {
    const before = snapshotRow();
    const token = await tokenFor({ addonKey: OTHER_ADDON_KEY });
    const res = await server.addon.handle(req("POST", "/api/entries/recreate", token, { entryId, planId: planIdByDemotedAdmin }));
    expect(res.status).toBe(401);
    expect(snapshotRow()).toEqual(before);
  });
});

describe("permission negatives sweep: forged/cross-workspace viewer -> 404 with no existence leak, no row changed", () => {
  for (const route of ROUTES.filter((r) => r.kind === "entry-scoped")) {
    it(route.name, async () => {
      const before = snapshotRow();
      // A genuinely verified admin of a DIFFERENT workspace, referencing `entryId` (which belongs
      // to ws-1). The scoped row lookup finds nothing under ws-2 — no distinguishing status leaks
      // that the entry exists elsewhere.
      const token = await tokenFor({ workspaceId: OTHER_WORKSPACE_ID, user: "someone", role: "admin" });
      const { body, query } = route.build();
      const res = await server.addon.handle(req(route.method, route.path, token, body, query));
      expect(res.status).toBe(404);
      expect(snapshotRow()).toEqual(before);
    });
  }

  it("POST /api/entries/recreate", async () => {
    const before = snapshotRow();
    const token = await tokenFor({ workspaceId: OTHER_WORKSPACE_ID, user: "someone", role: "admin" });
    const res = await server.addon.handle(req("POST", "/api/entries/recreate", token, { entryId, planId: planIdByDemotedAdmin }));
    expect(res.status).toBe(404);
    expect(snapshotRow()).toEqual(before);
  });

  it("GET /api/entries as a cross-workspace admin never returns ws-1's row", async () => {
    const token = await tokenFor({ workspaceId: OTHER_WORKSPACE_ID, user: "someone", role: "admin" });
    const res = await server.addon.handle(req("GET", "/api/entries", token));
    expect(res.status).toBe(200);
    const body = res.body as { entries: { id: string }[] };
    expect(body.entries.map((e) => e.id)).not.toContain(entryId);
  });

  it("bulk-preflight as a cross-workspace admin reports the id as not-found, never the ws-1 row", async () => {
    // bulk-preflight needs a Clockify client (loadClient) before it ever reaches the per-id check —
    // give ws-2 an installation and a trivial stub so that gate passes, isolating the assertion to
    // the per-id scoping this test actually targets.
    await server.installations.save({
      workspaceId: OTHER_WORKSPACE_ID,
      addonId: ADDON_ID,
      addonUserId: "addon-user-1",
      asUser: "someone",
      apiUrl: "https://developer.clockify.me/api",
      authToken: "tok",
      installedAt: 1000,
    });
    vi.stubGlobal(
      "fetch",
      (async (input: string | URL | Request) => {
        const path = new URL(typeof input === "string" ? input : input instanceof URL ? input : input.url, "http://localhost/").pathname;
        if (/\/workspaces\/[^/]+$/.test(path)) return new Response(JSON.stringify({ id: OTHER_WORKSPACE_ID, workspaceSettings: {} }), { status: 200 });
        if (path.endsWith("/users")) return new Response(JSON.stringify([]), { status: 200 });
        if (path.endsWith("/tags")) return new Response(JSON.stringify([]), { status: 200 });
        if (path.endsWith("/custom-fields")) return new Response(JSON.stringify([]), { status: 200 });
        return new Response(JSON.stringify({ message: "unstubbed" }), { status: 404 });
      }) as typeof fetch,
    );
    const token = await tokenFor({ workspaceId: OTHER_WORKSPACE_ID, user: "someone", role: "admin" });
    const res = await server.addon.handle(req("POST", "/api/entries/bulk-preflight", token, { ids: [entryId] }));
    expect(res.status).toBe(200);
    const body = res.body as { results: { entryId: string; status: string }[] };
    expect(body.results).toEqual([{ entryId, status: "not-found" }]);
    vi.unstubAllGlobals();
  });

  it("bulk-recreate does not reveal whether a plan exists in another workspace", async () => {
    const before = snapshotRow();
    const token = await tokenFor({ workspaceId: OTHER_WORKSPACE_ID, user: "someone", role: "admin" });
    const unknownPlanId = "plan-that-does-not-exist";
    const res = await server.addon.handle(req("POST", "/api/entries/bulk-recreate", token, {
      planIds: [planIdByDemotedAdmin, unknownPlanId],
    }));
    expect(res.status).toBe(200);
    const body = res.body as {
      results: { planId: string; entryId: string | null; outcome: string; message: string }[];
    };
    expect(body.results).toEqual([
      { planId: planIdByDemotedAdmin, entryId: null, outcome: "ERROR", message: "not found" },
      { planId: unknownPlanId, entryId: null, outcome: "ERROR", message: "not found" },
    ]);
    expect(snapshotRow()).toEqual(before);
  });
});

describe("permission negatives sweep: forged/other user (neither owner nor admin) -> 404, no row changed", () => {
  for (const route of ROUTES.filter((r) => r.kind === "entry-scoped")) {
    it(route.name, async () => {
      const before = snapshotRow();
      const token = await tokenFor({ user: OTHER_MEMBER_ID, role: "member" });
      const { body, query } = route.build();
      const res = await server.addon.handle(req(route.method, route.path, token, body, query));
      expect(res.status).toBe(404);
      expect(snapshotRow()).toEqual(before);
    });
  }

  it("POST /api/entries/recreate — an other member with no history on this entry -> 404, not 403", async () => {
    const before = snapshotRow();
    const token = await tokenFor({ user: OTHER_MEMBER_ID, role: "member" });
    const res = await server.addon.handle(req("POST", "/api/entries/recreate", token, { entryId, planId: planIdByDemotedAdmin }));
    expect(res.status).toBe(404);
    expect(snapshotRow()).toEqual(before);
  });

  it("an own plan does not reveal whether an unrelated entry id exists", async () => {
    const ownEntry = entries.ingestDeletedEntry(server.db, {
      id: "re-other-member",
      workspaceId: WORKSPACE_ID,
      sourceEntryId: "entry-other-member",
      ownerId: OTHER_MEMBER_ID,
      detectedAt: "2026-08-08T09:01:00Z",
      source: {
        ...SOURCE,
        entryId: "entry-other-member",
        ownerId: OTHER_MEMBER_ID,
        ownerName: "User Two",
      },
    }).entry;
    const ownPlan = plans.createActive(server.db, {
      id: "plan-by-other-member",
      recoverableEntryId: ownEntry.id,
      createdBy: OTHER_MEMBER_ID,
      createdAt: "2026-08-08T09:01:30Z",
      sourceHash: "hash",
      choices: {},
      resolution: [],
      plannedRequest: {
        workspaceId: WORKSPACE_ID,
        userId: OTHER_MEMBER_ID,
        start: SOURCE.start,
        end: SOURCE.end ?? "2026-08-08T11:00:00Z",
      },
      warnings: [],
      blockers: [],
      actionRequired: [],
      fidelity: "FULL",
    });
    const token = await tokenFor({ user: OTHER_MEMBER_ID, role: "member" });
    const existing = await server.addon.handle(req("POST", "/api/entries/recreate", token, {
      entryId,
      planId: ownPlan.id,
    }));
    const missing = await server.addon.handle(req("POST", "/api/entries/recreate", token, {
      entryId: "missing-entry-id",
      planId: ownPlan.id,
    }));

    expect({ status: existing.status, body: existing.body }).toEqual({
      status: missing.status,
      body: missing.body,
    });
    expect(existing.status).toBe(404);
  });

  it("GET /api/entries as a non-admin never returns another user's row, even asking for it by userId", async () => {
    const token = await tokenFor({ user: OTHER_MEMBER_ID, role: "member" });
    const res = await server.addon.handle(req("GET", "/api/entries", token, undefined, { userId: OWNER_ID }));
    expect(res.status).toBe(200);
    const body = res.body as { entries: { id: string }[] };
    // docs/09: "non-admin filters are validated, never widen the workspace scope" — the userId
    // query param is silently ignored for a non-admin viewer.
    expect(body.entries.map((e) => e.id)).not.toContain(entryId);
  });

  it("GET /api/entries as a non-admin never returns another user's row, even asking for it by userName", async () => {
    const token = await tokenFor({ user: OTHER_MEMBER_ID, role: "member" });
    const res = await server.addon.handle(req("GET", "/api/entries", token, undefined, { userName: "User One" }));
    expect(res.status).toBe(200);
    // Same contract as `userId` above: naming the person instead of their id changes nothing.
    expect((res.body as { entries: { id: string }[] }).entries.map((e) => e.id)).not.toContain(entryId);
  });

  it("GET /api/options?kind=users is admin-only — a member cannot enumerate the workspace's people", async () => {
    const token = await tokenFor({ user: OTHER_MEMBER_ID, role: "member" });
    const res = await server.addon.handle(req("GET", "/api/options", token, undefined, { kind: "users" }));
    expect(res.status).toBe(403);
  });
});

describe("permission negatives sweep: demoted admin (created a plan while admin, now a member) -> 403 where the viewer already knows the row exists, 404 elsewhere", () => {
  it("POST /api/entries/recreate: the one route wired with deniedIsForbidden -> 403, not 404", async () => {
    const before = snapshotRow();
    const token = await tokenFor({ user: DEMOTED_ADMIN_ID, role: "member" });
    const res = await server.addon.handle(req("POST", "/api/entries/recreate", token, { entryId, planId: planIdByDemotedAdmin }));
    expect(res.status).toBe(403);
    expect(snapshotRow()).toEqual(before);
  });

  // Every other entry-scoped route has no `deniedIsForbidden` wiring (routes.ts only passes it on
  // `handleRecreate`, keyed off `plan.createdBy`), so the demoted admin gets the same "no existence
  // leak" 404 as any other unauthorized viewer there — the asymmetry is confined to the one route
  // that actually needs it.
  for (const route of ROUTES.filter((r) => r.kind === "entry-scoped")) {
    it(`${route.name}: 404 (the 403 asymmetry does not leak into other routes)`, async () => {
      const before = snapshotRow();
      const token = await tokenFor({ user: DEMOTED_ADMIN_ID, role: "member" });
      const { body, query } = route.build();
      const res = await server.addon.handle(req(route.method, route.path, token, body, query));
      expect(res.status).toBe(404);
      expect(snapshotRow()).toEqual(before);
    });
  }

  it("bulk-preflight / bulk-recreate: a demoted admin fails the route's own admin gate (403), before any per-entry check", async () => {
    const token = await tokenFor({ user: DEMOTED_ADMIN_ID, role: "member" });
    const before = snapshotRow();
    const bulkPreflight = await server.addon.handle(req("POST", "/api/entries/bulk-preflight", token, { ids: [entryId] }));
    expect(bulkPreflight.status).toBe(403);
    const bulkRecreate = await server.addon.handle(req("POST", "/api/entries/bulk-recreate", token, { planIds: [planIdByDemotedAdmin] }));
    expect(bulkRecreate.status).toBe(403);
    expect(snapshotRow()).toEqual(before);
  });
});
