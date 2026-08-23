// Credential authority (docs/09). The Clockify add-on platform issues exactly one server
// credential per installation — the add-on token from the INSTALLED payload — and no user-scoped
// exchange exists, so every Clockify call this app makes carries authority the viewer may not
// have. Anything the *viewer chooses* therefore has to be checked here, or a normal member could
// steer a privileged write into a project they cannot open, and read every private project's name
// out of the picker.
//
// Deliberately not covered, because it is intended behavior: a member recreating their own entry
// into the project it was deleted from, which Clockify already let them log time against.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildInstalledPayload,
  createTestLifecycleRequest,
  generateTestKeys,
  signTestToken,
  type ClockifyTestKeys,
} from "@apet97/clockify-addon-sdk/testing";
import { createServer, type AppServer } from "../../src/server.js";
import type { AppConfig } from "../../src/config.js";
import type { DeletedTimeEntry } from "../../src/domain/entry.js";
import { ingestEntry } from "../support/installation-fixture.js";

const ADDON_KEY = "restoretime-authority";
const WORKSPACE_ID = "ws-1";
const ADDON_ID = "addon-1";
const SCOPE = { workspaceId: WORKSPACE_ID, addonId: ADDON_ID };
const MEMBER_ID = "user-1";

const OPEN_PROJECT = "proj-open";       // public: every member may target it
const JOINED_PROJECT = "proj-joined";   // private, but this member is on it
const PRIVATE_PROJECT = "proj-private"; // private, and this member is not on it

let dir: string;
let keys: ClockifyTestKeys;
let server: AppServer;
let entryId: string;
/** Every Clockify write this suite would allow is a defect, so they are counted, not stubbed out. */
let writes: number;

const SOURCE: DeletedTimeEntry = {
  workspaceId: WORKSPACE_ID,
  entryId: "entry-a",
  ownerId: MEMBER_ID,
  ownerName: "User One",
  description: "work",
  billable: true,
  start: "2026-08-08T10:00:00Z",
  end: "2026-08-08T11:00:00Z",
  wasRunning: false,
  type: "REGULAR",
  timeZone: "UTC",
  projectId: OPEN_PROJECT,
  projectName: "Open project",
  clientName: null,
  taskId: null,
  taskName: null,
  tags: [],
  customFieldValues: [],
};

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

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
}

/** The workspace as the *installation token* sees it: all three projects, because that credential
 * is workspace-wide. Only `public` and `memberships` distinguish what the viewer may target. */
function clockifyStub() {
  return async (input: Parameters<typeof fetch>[0], init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const path = new URL(url).pathname;
    const method = (init?.method ?? "GET").toUpperCase();
    if (method !== "GET") {
      writes += 1;
      return jsonResponse({ id: "new-entry" });
    }
    if (path.endsWith("/projects")) {
      return jsonResponse([
        { id: OPEN_PROJECT, name: "Open project", archived: false, public: true, memberships: [] },
        { id: JOINED_PROJECT, name: "Joined project", archived: false, public: false, memberships: [{ userId: MEMBER_ID }] },
        { id: PRIVATE_PROJECT, name: "Secret rebrand", archived: false, public: false, memberships: [{ userId: "someone-else" }] },
      ]);
    }
    if (path.endsWith("/tasks")) return jsonResponse([{ id: "task-1", name: "Task", status: "ACTIVE" }]);
    if (path.includes("/projects/")) {
      const id = path.split("/projects/")[1]?.split("/")[0] ?? "";
      return jsonResponse({ id, name: `Project ${id}`, archived: false, public: false, memberships: [] });
    }
    if (path.endsWith("/tags")) return jsonResponse([]);
    if (path.includes("/custom-fields")) return jsonResponse([]);
    if (path.endsWith("/users")) return jsonResponse([{ id: MEMBER_ID, name: "User One", status: "ACTIVE" }]);
    if (path.includes("/time-entries")) return jsonResponse([]);
    return jsonResponse({ id: WORKSPACE_ID, workspaceSettings: {} });
  };
}

async function tokenFor(role: "member" | "admin"): Promise<string> {
  return signTestToken(keys.privateKey, ADDON_KEY, {
    workspaceId: WORKSPACE_ID,
    addonId: ADDON_ID,
    user: MEMBER_ID,
    workspaceRole: role,
  });
}

async function optionIds(role: "member" | "admin", kind: string, extra: Record<string, string> = {}) {
  const response = await server.addon.handle({
    method: "GET",
    path: "/api/options",
    query: new URLSearchParams({ kind, ...extra }),
    headers: { authorization: `Bearer ${await tokenFor(role)}` },
  });
  return {
    status: response.status,
    ids: ((response.body as { items?: { id: string }[] }).items ?? []).map((item) => item.id),
    body: response.body,
  };
}

async function preflight(role: "member" | "admin", choices: Record<string, unknown>) {
  return server.addon.handle({
    method: "POST",
    path: "/api/entries/preflight",
    headers: { authorization: `Bearer ${await tokenFor(role)}`, "content-type": "application/json" },
    body: { entryId, choices },
  });
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "restoretime-authority-"));
  writes = 0;
  keys = await generateTestKeys();
  server = await createServer(testConfig(), { publicKey: keys.publicKey });
  // Through the real lifecycle, not a raw row: `loadClient` reads the add-on token back through
  // the encrypting store, so only a genuinely installed row yields a usable Clockify client.
  await server.addon.handle(
    createTestLifecycleRequest(
      await signTestToken(keys.privateKey, ADDON_KEY, { workspaceId: WORKSPACE_ID, addonId: ADDON_ID }),
      buildInstalledPayload({
        workspaceId: WORKSPACE_ID,
        addonId: ADDON_ID,
        apiUrl: "https://developer.clockify.me/api",
      }),
      { path: "/lifecycle/installed" },
    ),
  );
  entryId = ingestEntry(server.db, {
    id: "re-1",
    scope: SCOPE,
    sourceEntryId: "entry-a",
    ownerId: MEMBER_ID,
    detectedAt: "2026-08-08T09:00:00Z",
    source: SOURCE,
  }).entry.id;
  vi.stubGlobal("fetch", clockifyStub());
});

afterEach(() => {
  vi.unstubAllGlobals();
  server.db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("the project picker shows a member only what they may target", () => {
  it("omits a private project the member is not a member of", async () => {
    const result = await optionIds("member", "projects");
    expect(result.status).toBe(200);
    expect(result.ids).toEqual([OPEN_PROJECT, JOINED_PROJECT]);
    // Not just the id — the name of a private project is itself the disclosure.
    expect(JSON.stringify(result.body)).not.toContain("Secret rebrand");
  });

  it("shows an admin the whole workspace, whose authority already covers it", async () => {
    const result = await optionIds("admin", "projects");
    expect(result.ids).toEqual([OPEN_PROJECT, JOINED_PROJECT, PRIVATE_PROJECT]);
  });

  it("answers 404, not 403, when a member asks for a private project's tasks", async () => {
    // 403 would confirm the project exists. 404 is the same answer an unknown id gets.
    expect((await optionIds("member", "tasks", { projectId: PRIVATE_PROJECT })).status).toBe(404);
    expect((await optionIds("member", "tasks", { projectId: JOINED_PROJECT })).status).toBe(200);
    expect((await optionIds("admin", "tasks", { projectId: PRIVATE_PROJECT })).status).toBe(200);
  });
});

describe("a member cannot re-target a recreation into a project they cannot open", () => {
  it("refuses the choice before a plan exists, and sends no write", async () => {
    const response = await preflight("member", { projectId: PRIVATE_PROJECT });
    expect(response.status).toBe(403);
    expect((response.body as { error: string }).error).toContain("do not have access to that project");
    // No plan was persisted, so nothing can later be confirmed against it.
    expect(
      server.db.prepare("SELECT COUNT(*) AS n FROM recreation_plans").get() as { n: number },
    ).toEqual({ n: 0 });
    expect(writes).toBe(0);
  });

  it("allows a public project and one the member belongs to", async () => {
    expect((await preflight("member", { projectId: OPEN_PROJECT })).status).toBe(200);
    expect((await preflight("member", { projectId: JOINED_PROJECT })).status).toBe(200);
  });

  it("allows an admin to re-target anywhere in the workspace", async () => {
    expect((await preflight("admin", { projectId: PRIVATE_PROJECT })).status).toBe(200);
  });

  it("leaves the entry's own original project reachable without a membership check", async () => {
    // The source project is what the product exists to restore; only an explicit re-targeting
    // choice is constrained.
    expect((await preflight("member", {})).status).toBe(200);
  });
});
