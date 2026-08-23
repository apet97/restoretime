// The admin list filters by name, over `/api/*` (docs/10 §2, docs/09).
//
// The design decision this pins: the filter matches the owner/project name **stored on the row at
// deletion time**, and never resolves a name to a Clockify id. A deleted project and a deactivated
// member are the rows this product exists for; neither appears in any current options list, so an
// id-resolving filter would silently fail to find exactly them. That case is the first test here —
// if it is not tested, the design is not protected.
//
// `/api/options?kind=users` feeds the `<datalist>` suggestions for the same filter, and is
// admin-only for the same reason `userId`/`userName` are: it names other people.
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
import { createServer } from "../../src/server.js";
import type { AppConfig } from "../../src/config.js";
import * as entries from "../../src/store/entries.js";

const ADDON_KEY = "restoretime-test";
const WORKSPACE_ID = "ws-1";
const ADDON_ID = "addon-1";
const OWNER_ID = "user-1";
const OTHER_ID = "user-2";
const GONE_PROJECT_ID = "proj-deleted";
const CURRENT_TAG_ID = "tag-current";
const ARCHIVED_TAG_ID = "tag-archived";

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
  dir = mkdtempSync(join(tmpdir(), "restoretime-name-filters-"));
  keys = await generateTestKeys();
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  vi.unstubAllGlobals();
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

/** Clockify as it is *now*: "Gone Project" no longer exists and Ada is deactivated. Both still own
 * stored rows, which is the whole point. `projects.list` therefore never mentions the gone project
 * and `projects.get` rejects it exactly as live Clockify does (see project-gone.test.ts). */
function currentWorkspaceStub(): typeof fetch {
  return async (input) => {
    const path = new URL(typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url).pathname;
    if (path.includes(`/projects/${GONE_PROJECT_ID}`)) {
      return jsonResponse({ message: "Project doesn't belong to Workspace", code: 501 }, 400);
    }
    if (/\/workspaces\/[^/]+$/.test(path)) return jsonResponse({ id: WORKSPACE_ID, workspaceSettings: {} });
    if (path.endsWith("/users")) {
      return jsonResponse([
        { id: OWNER_ID, email: "ada@example.invalid", name: "Ada Lovelace", status: "INACTIVE" },
        { id: OTHER_ID, email: "grace@example.invalid", name: "Grace Hopper", status: "ACTIVE" },
      ]);
    }
    // `public` and `memberships` decide what a non-admin may target (docs/09); real Clockify
    // always returns both, so the stub does too.
    if (path.endsWith("/projects")) return jsonResponse([{ id: "proj-live", name: "Still Here", archived: false, public: true, memberships: [] }]);
    if (path.endsWith("/tasks")) {
      return jsonResponse([
        { id: "task-active", name: "Current task", status: "ACTIVE" },
        { id: "task-done", name: "Completed task", status: "DONE" },
      ]);
    }
    if (path.endsWith("/tags")) {
      return jsonResponse([
        { id: CURRENT_TAG_ID, name: "Current tag", archived: false },
        { id: ARCHIVED_TAG_ID, name: "Archived tag", archived: true },
      ]);
    }
    return jsonResponse([]);
  };
}

interface Seeded {
  readonly server: Awaited<ReturnType<typeof createServer>>;
  readonly adminToken: string;
  readonly memberToken: string;
}

async function seed(): Promise<Seeded> {
  const server = await createServer(testConfig(), { publicKey: keys.publicKey });
  const lifecycleToken = await signTestToken(keys.privateKey, ADDON_KEY, { workspaceId: WORKSPACE_ID, addonId: ADDON_ID });
  await server.addon.handle(
    createTestLifecycleRequest(
      lifecycleToken,
      buildInstalledPayload({
        workspaceId: WORKSPACE_ID,
        addonId: ADDON_ID,
        apiUrl: "https://developer.clockify.me/api",
        webhooks: [{ path: "/webhooks/time-entry-deleted", webhookType: "ADDON", authToken: lifecycleToken }],
      }),
      { path: "/lifecycle/installed" },
    ),
  );

  // Ada's entry: on a project that has since been deleted from Clockify.
  await server.addon.handle(
    createTestWebhookRequest(
      lifecycleToken,
      "TIME_ENTRY_DELETED",
      {
        id: "entry-gone",
        workspaceId: WORKSPACE_ID,
        userId: OWNER_ID,
        description: "legacy work",
        billable: true,
        projectId: GONE_PROJECT_ID,
        type: "REGULAR",
        currentlyRunning: false,
        timeInterval: { start: "2026-08-08T10:00:00Z", end: "2026-08-08T11:00:00Z", timeZone: "UTC" },
        project: { id: GONE_PROJECT_ID, name: "Gone Project" },
        task: null,
        tags: [],
        user: { name: "Ada Lovelace" },
        customFieldValues: [],
      },
      { path: "/webhooks/time-entry-deleted" },
    ),
  );
  // Grace's entry: on a project that still exists.
  await server.addon.handle(
    createTestWebhookRequest(
      lifecycleToken,
      "TIME_ENTRY_DELETED",
      {
        id: "entry-live",
        workspaceId: WORKSPACE_ID,
        userId: OTHER_ID,
        description: "current work",
        billable: true,
        projectId: "proj-live",
        type: "REGULAR",
        currentlyRunning: false,
        timeInterval: { start: "2026-08-08T12:00:00Z", end: "2026-08-08T13:00:00Z", timeZone: "UTC" },
        project: { id: "proj-live", name: "Still Here" },
        task: null,
        tags: [],
        user: { name: "Grace Hopper" },
        customFieldValues: [],
      },
      { path: "/webhooks/time-entry-deleted" },
    ),
  );

  vi.stubGlobal("fetch", currentWorkspaceStub());
  const claims = { workspaceId: WORKSPACE_ID, addonId: ADDON_ID };
  return {
    server,
    adminToken: await signTestToken(keys.privateKey, ADDON_KEY, { ...claims, user: OTHER_ID, workspaceRole: "admin" }),
    memberToken: await signTestToken(keys.privateKey, ADDON_KEY, { ...claims, user: OTHER_ID, workspaceRole: "member" }),
  };
}

function get(seeded: Seeded, token: string, path: string, query?: Record<string, string>) {
  return seeded.server.addon.handle({
    method: "GET",
    path,
    headers: { authorization: `Bearer ${token}` },
    ...(query ? { query: new URLSearchParams(query) } : {}),
  });
}

async function descriptions(seeded: Seeded, token: string, query?: Record<string, string>): Promise<string[]> {
  const res = await get(seeded, token, "/api/entries", query);
  expect(res.status).toBe(200);
  return (res.body as { entries: { source: { description: string } }[] }).entries.map((e) => e.source.description);
}

describe("filtering the admin list by name (docs/10 §2)", () => {
  it("finds an entry whose project no longer exists in Clockify, by the project name stored at deletion time", async () => {
    const seeded = await seed();
    // The project is gone: it is absent from the options list an id-based filter would have to
    // come from, and `projects.get` rejects it outright.
    const options = await get(seeded, seeded.adminToken, "/api/options", { kind: "projects" });
    expect((options.body as { items: { name: string }[] }).items.map((p) => p.name)).toEqual(["Still Here"]);

    // The stored name still finds it. This is the case the design exists for.
    expect(await descriptions(seeded, seeded.adminToken, { projectName: "Gone" })).toEqual(["legacy work"]);
    expect(await descriptions(seeded, seeded.adminToken, { projectName: "Still" })).toEqual(["current work"]);
  });

  it("finds a deactivated member's entry by their stored name", async () => {
    const seeded = await seed();
    expect(await descriptions(seeded, seeded.adminToken, { userName: "lovelace" })).toEqual(["legacy work"]);
    expect(await descriptions(seeded, seeded.adminToken, { userName: "Hopper" })).toEqual(["current work"]);
  });

  it("a non-matching name returns nothing rather than falling back to the unfiltered list", async () => {
    const seeded = await seed();
    expect(await descriptions(seeded, seeded.adminToken, { projectName: "no such project" })).toEqual([]);
  });

  it("userName never widens a non-admin's scope — asking for another member by name returns only their own rows", async () => {
    const seeded = await seed();
    // Grace is the viewer; Ada's row must stay invisible however it is asked for. Same contract as
    // the `userId` case in permission-negatives.test.ts: the param is silently ignored.
    expect(await descriptions(seeded, seeded.memberToken, { userName: "Lovelace" })).toEqual(["current work"]);
    expect(await descriptions(seeded, seeded.memberToken)).toEqual(["current work"]);
  });
});

describe("strict UTC bounds on the deleted-entry list", () => {
  it("accepts seconds through milliseconds and keeps exact millisecond bounds inclusive", async () => {
    const seeded = await seed();
    seeded.server.db
      .prepare("UPDATE recoverable_entries SET detected_at = CASE source_entry_id WHEN 'entry-gone' THEN ? ELSE ? END")
      .run("2026-08-08T10:00:00.000Z", "2026-08-08T11:00:00.000Z");

    for (const [from, to] of [
      ["2026-08-08T10:00:00Z", "2026-08-08T11:00:00Z"],
      ["2026-08-08T10:00:00.0Z", "2026-08-08T11:00:00.0Z"],
      ["2026-08-08T10:00:00.00Z", "2026-08-08T11:00:00.00Z"],
      ["2026-08-08T10:00:00.000Z", "2026-08-08T11:00:00.000Z"],
    ] as const) {
      expect(await descriptions(seeded, seeded.adminToken, { from, to })).toEqual([
        "current work",
        "legacy work",
      ]);
    }
  });

  it("rejects invalid, over-precise, and reversed bounds before querying rows", async () => {
    const seeded = await seed();
    const list = vi.spyOn(entries, "list");
    const rejectedQueries: ReadonlyArray<readonly [Record<string, string>, string]> = [
      [{ from: "2026-08-08T10:00:00.000000001Z" }, "from must be a UTC ISO timestamp with at most millisecond precision"],
      [{ to: "2026-08-08T10:00:00.000000001Z" }, "to must be a UTC ISO timestamp with at most millisecond precision"],
      [{ from: "2026-08-08T10:00:00.1234Z" }, "from must be a UTC ISO timestamp with at most millisecond precision"],
      [{ to: "2026-08-08T10:00:00.1234Z" }, "to must be a UTC ISO timestamp with at most millisecond precision"],
      [{ from: "2026/08/08 10:00:00" }, "from must be a UTC ISO timestamp with at most millisecond precision"],
      [{ to: "2026-08-08T11:00:00+01:00" }, "to must be a UTC ISO timestamp with at most millisecond precision"],
      [{ from: "2026-08-08T12:00:00Z", to: "2026-08-08T11:00:00Z" }, "from must not be after to"],
    ];
    for (const [query, error] of rejectedQueries) {
      const response = await get(seeded, seeded.adminToken, "/api/entries", query);
      expect(response).toMatchObject({ status: 400, body: { error } });
    }
    expect(list).not.toHaveBeenCalled();
  });
});

describe("/api/options?kind=users — the suggestions behind the user filter", () => {
  it("returns {id, name} for every member, including a deactivated one", async () => {
    const seeded = await seed();
    const res = await get(seeded, seeded.adminToken, "/api/options", { kind: "users" });
    expect(res.status).toBe(200);
    // `status: "ALL"`: Ada is INACTIVE and still owns rows, so suggesting her name is the point.
    expect(res.body).toEqual({
      items: [
        { id: OWNER_ID, name: "Ada Lovelace" },
        { id: OTHER_ID, name: "Grace Hopper" },
      ],
    });
  });

  it("is admin-only — a member gets 403 and no member list", async () => {
    const seeded = await seed();
    const res = await get(seeded, seeded.memberToken, "/api/options", { kind: "users" });
    expect(res.status).toBe(403);
    expect(JSON.stringify(res.body)).not.toContain("Lovelace");
  });

  it("the other option kinds stay open to a member — the gate is on `users` alone", async () => {
    const seeded = await seed();
    expect((await get(seeded, seeded.memberToken, "/api/options", { kind: "projects" })).status).toBe(200);
    expect((await get(seeded, seeded.memberToken, "/api/options", { kind: "tags" })).status).toBe(200);
  });
});

describe("/api/options?kind=tags — replacement tag choices", () => {
  it("returns current tags and omits archived tags", async () => {
    const seeded = await seed();
    const res = await get(seeded, seeded.memberToken, "/api/options", { kind: "tags" });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ items: [{ id: CURRENT_TAG_ID, name: "Current tag", archived: false }] });
    expect(JSON.stringify(res.body)).not.toContain(ARCHIVED_TAG_ID);
  });
});

describe("/api/options?kind=tasks — replacement task choices", () => {
  it("returns active tasks and omits completed tasks", async () => {
    const seeded = await seed();
    const res = await get(seeded, seeded.memberToken, "/api/options", {
      kind: "tasks",
      projectId: "proj-live",
    });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      items: [{ id: "task-active", name: "Current task", status: "ACTIVE" }],
    });
    expect(JSON.stringify(res.body)).not.toContain("task-done");
  });
});
