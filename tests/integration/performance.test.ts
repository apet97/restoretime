// IT-17 — Performance sanity (docs/13, pass file §Scope). Seeds ~5000 `recoverable_entries` rows and
// proves two things about `GET /api/entries`:
//
// 1. No N+1: the known PASS-02 gap ("`fetchEntryWorkspaceState` does a project and a task lookup
//    per listed row, so fifty rows across fifty projects is ~100 Clockify calls") is fixed by
//    `src/clockify/preflight-data.ts`'s per-request `ProjectTaskCache` — a counting fetch stub
//    asserts the EXACT number of project/task Clockify calls equals the number of DISTINCT
//    projects among the actionable rows, not the number of rows.
// 2. A documented local p95 budget: `LOCAL_P95_BUDGET_MS` below is the number this test enforces.
//    It is a *local, stub-backed, in-process* budget — not a production SLA (no network, no real
//    Clockify latency) — recorded here so a regression has something concrete to fail against, per
//    the pass file's "record p95... against a documented local budget."
//
// Only a SUBSET of the 5000 rows are actionable (IDLE/FAILED — the only states that trigger a
// preflight computation, per `handleListEntries`). Seeding all 5000 as actionable would make the
// p95 number measure the stub's own dispatch overhead at a scale no real workspace's *deleted*
// entries backlog is likely to reach in the "needs a decision" state at once, and would slow this
// suite for no proportional benefit. The exact actionable count and its distinct-project count are
// asserted explicitly below so the N+1 assertion is auditable, not implicit.
import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { buildInstalledPayload, createTestLifecycleRequest, generateTestKeys, signTestToken, type ClockifyTestKeys } from "@apet97/clockify-addon-sdk/testing";
import { createServer, type AppServer } from "../../src/server.js";
import type { AppConfig } from "../../src/config.js";
import type { DeletedTimeEntry, LifecycleState } from "../../src/domain/entry.js";

const ADDON_KEY = "restoretime-perf";
const WORKSPACE_ID = "ws-1";
const ADDON_ID = "addon-1";
const OWNER_ID = "user-1";

const TOTAL_ROWS = 5000;
const ACTIONABLE_ROWS = 50;
const DISTINCT_PROJECTS = 5; // ACTIONABLE_ROWS / DISTINCT_PROJECTS = 10 rows per project
const ROWS_PER_PROJECT = ACTIONABLE_ROWS / DISTINCT_PROJECTS;

/** Local, stub-backed, in-process budget for `GET /api/entries` against 5000 seeded rows (50
 * actionable across 5 projects) on the machine this pass was hardened on. Not a production SLA. */
const LOCAL_P95_BUDGET_MS = 150;
const MEASURED_REQUESTS = 15;

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

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  vi.unstubAllGlobals();
});

function source(projectId: string | null): DeletedTimeEntry {
  return {
    workspaceId: WORKSPACE_ID,
    entryId: randomUUID(),
    ownerId: OWNER_ID,
    ownerName: "User One",
    description: "d",
    billable: true,
    start: "2026-08-08T10:00:00Z",
    end: "2026-08-08T11:00:00Z",
    wasRunning: false,
    type: "REGULAR",
    timeZone: "UTC",
    projectId,
    projectName: projectId ? `Project ${projectId}` : null,
    clientName: null,
    taskId: null,
    taskName: null,
    tags: [],
    customFieldValues: [],
  };
}

/** Seeds `TOTAL_ROWS` rows directly (one prepared statement, one transaction — the fast path a
 * webhook-per-row seed would not give us at this scale). `ACTIONABLE_ROWS` are IDLE, spread evenly
 * across `DISTINCT_PROJECTS`; the rest are RECREATED (never actionable, so `handleListEntries`
 * never computes a preflight for them — they exist purely to prove the endpoint scales to 5000
 * rows returned, not 5000 rows preflighted). */
function seedRows(server: AppServer): void {
  const insert = server.db.prepare(
    `INSERT INTO recoverable_entries
       (id, workspace_id, source_entry_id, owner_id, detected_at, source_json, lifecycle_state, new_entry_id)
     VALUES (@id, @workspaceId, @sourceEntryId, @ownerId, @detectedAt, @sourceJson, @lifecycleState, @newEntryId)`,
  );
  const run = server.db.transaction((rows: { id: string; sourceEntryId: string; sourceJson: string; lifecycleState: LifecycleState; newEntryId: string | null }[]) => {
    for (const row of rows) {
      insert.run({
        id: row.id,
        workspaceId: WORKSPACE_ID,
        sourceEntryId: row.sourceEntryId,
        ownerId: OWNER_ID,
        detectedAt: "2026-08-08T09:00:00.000Z",
        sourceJson: row.sourceJson,
        lifecycleState: row.lifecycleState,
        newEntryId: row.newEntryId,
      });
    }
  });

  const rows: { id: string; sourceEntryId: string; sourceJson: string; lifecycleState: LifecycleState; newEntryId: string | null }[] = [];
  for (let i = 0; i < ACTIONABLE_ROWS; i++) {
    const projectId = `proj-${i % DISTINCT_PROJECTS}`;
    rows.push({ id: `re-actionable-${i}`, sourceEntryId: `src-actionable-${i}`, sourceJson: JSON.stringify(source(projectId)), lifecycleState: "IDLE", newEntryId: null });
  }
  for (let i = 0; i < TOTAL_ROWS - ACTIONABLE_ROWS; i++) {
    // RECREATED rows need a `new_entry_id` (docs/08 invariant); distinct per row so nothing
    // collides with the unique (workspace_id, new_entry_id) index.
    rows.push({ id: `re-filler-${i}`, sourceEntryId: `src-filler-${i}`, sourceJson: JSON.stringify(source(null)), lifecycleState: "RECREATED", newEntryId: `filler-clockify-id-${i}` });
  }
  run(rows);
}

describe("Performance sanity: 5000 seeded rows, no N+1, documented p95 budget", () => {
  it(`GET /api/entries issues exactly ${DISTINCT_PROJECTS} project lookups (one per distinct project among ${ACTIONABLE_ROWS} actionable rows), not ${ACTIONABLE_ROWS}`, async () => {
    dir = mkdtempSync(join(tmpdir(), "restoretime-perf-"));
    const keys: ClockifyTestKeys = await generateTestKeys();
    const server = await createServer(testConfig(), { publicKey: keys.publicKey });
    const installToken = await signTestToken(keys.privateKey, ADDON_KEY, { workspaceId: WORKSPACE_ID, addonId: ADDON_ID });
    await server.addon.handle(
      createTestLifecycleRequest(installToken, buildInstalledPayload({ workspaceId: WORKSPACE_ID, addonId: ADDON_ID, apiUrl: "https://developer.clockify.me/api" }), { path: "/lifecycle/installed" }),
    );
    seedRows(server);

    let workspaceCalls = 0;
    let usersCalls = 0;
    let tagsCalls = 0;
    let customFieldsCalls = 0;
    const projectCallsByPath = new Map<string, number>();
    let taskListCalls = 0;

    vi.stubGlobal(
      "fetch",
      (async (input: string | URL | Request, init?: RequestInit) => {
        const path = pathOf(input);
        const method = methodOf(input, init);
        if (method === "GET" && /\/workspaces\/[^/]+$/.test(path)) {
          workspaceCalls++;
          return jsonResponse({ id: WORKSPACE_ID, workspaceSettings: {} });
        }
        if (method === "GET" && path.endsWith("/users")) {
          usersCalls++;
          return jsonResponse([{ id: OWNER_ID, email: "a@b.com", name: "User One", status: "ACTIVE" }]);
        }
        if (method === "GET" && path.endsWith("/tags")) {
          tagsCalls++;
          return jsonResponse([]);
        }
        if (method === "GET" && path.endsWith("/custom-fields")) {
          customFieldsCalls++;
          return jsonResponse([]);
        }
        if (method === "GET" && /\/projects\/proj-\d+$/.test(path)) {
          projectCallsByPath.set(path, (projectCallsByPath.get(path) ?? 0) + 1);
          const projectId = path.split("/").pop()!;
          return jsonResponse({ id: projectId, name: `Project ${projectId}`, archived: false });
        }
        if (method === "GET" && path.endsWith("/tasks")) {
          taskListCalls++;
          return jsonResponse([]);
        }
        return jsonResponse({ message: "unstubbed" }, 404);
      }) as typeof fetch,
    );

    const token = await signTestToken(keys.privateKey, ADDON_KEY, { workspaceId: WORKSPACE_ID, addonId: ADDON_ID, user: OWNER_ID, workspaceRole: "member" });
    const response = await server.addon.handle({ method: "GET", path: "/api/entries", query: new URLSearchParams(), headers: { authorization: `Bearer ${token}` } });

    expect(response.status).toBe(200);
    const body = response.body as { entries: unknown[] };
    expect(body.entries).toHaveLength(TOTAL_ROWS);

    // Shared workspace-level lookups: exactly once per request, regardless of row count.
    expect(workspaceCalls).toBe(1);
    expect(usersCalls).toBe(1);
    expect(tagsCalls).toBe(1);
    expect(customFieldsCalls).toBe(1);

    // The N+1 assertion: one project lookup per DISTINCT project, not per actionable row. No
    // source entry set a taskId, so `lookupTask` short-circuits before any `tasks.list` call.
    expect(projectCallsByPath.size).toBe(DISTINCT_PROJECTS);
    for (const count of projectCallsByPath.values()) expect(count).toBe(1);
    expect([...projectCallsByPath.values()].reduce((a, b) => a + b, 0)).toBe(DISTINCT_PROJECTS);
    expect(taskListCalls).toBe(0);

    // Sanity on the fixture shape this assertion depends on.
    expect(ROWS_PER_PROJECT).toBeGreaterThan(1); // several rows really do share each project
  }, 30_000);

  it(`p95 of ${MEASURED_REQUESTS} requests against the seeded 5000 rows stays under the documented local budget (${LOCAL_P95_BUDGET_MS} ms)`, async () => {
    dir = mkdtempSync(join(tmpdir(), "restoretime-perf-p95-"));
    const keys: ClockifyTestKeys = await generateTestKeys();
    const server = await createServer(testConfig(), { publicKey: keys.publicKey });
    const installToken = await signTestToken(keys.privateKey, ADDON_KEY, { workspaceId: WORKSPACE_ID, addonId: ADDON_ID });
    await server.addon.handle(
      createTestLifecycleRequest(installToken, buildInstalledPayload({ workspaceId: WORKSPACE_ID, addonId: ADDON_ID, apiUrl: "https://developer.clockify.me/api" }), { path: "/lifecycle/installed" }),
    );
    seedRows(server);

    vi.stubGlobal(
      "fetch",
      (async (input: string | URL | Request, init?: RequestInit) => {
        const path = pathOf(input);
        const method = methodOf(input, init);
        if (method === "GET" && /\/workspaces\/[^/]+$/.test(path)) return jsonResponse({ id: WORKSPACE_ID, workspaceSettings: {} });
        if (method === "GET" && path.endsWith("/users")) return jsonResponse([{ id: OWNER_ID, email: "a@b.com", name: "User One", status: "ACTIVE" }]);
        if (method === "GET" && path.endsWith("/tags")) return jsonResponse([]);
        if (method === "GET" && path.endsWith("/custom-fields")) return jsonResponse([]);
        if (method === "GET" && /\/projects\/proj-\d+$/.test(path)) {
          const projectId = path.split("/").pop()!;
          return jsonResponse({ id: projectId, name: `Project ${projectId}`, archived: false });
        }
        return jsonResponse({ message: "unstubbed" }, 404);
      }) as typeof fetch,
    );

    const token = await signTestToken(keys.privateKey, ADDON_KEY, { workspaceId: WORKSPACE_ID, addonId: ADDON_ID, user: OWNER_ID, workspaceRole: "member" });

    const durationsMs: number[] = [];
    for (let i = 0; i < MEASURED_REQUESTS; i++) {
      const start = performance.now();
      const response = await server.addon.handle({ method: "GET", path: "/api/entries", query: new URLSearchParams(), headers: { authorization: `Bearer ${token}` } });
      durationsMs.push(performance.now() - start);
      expect(response.status).toBe(200);
    }

    durationsMs.sort((a, b) => a - b);
    const p95Index = Math.min(durationsMs.length - 1, Math.ceil(durationsMs.length * 0.95) - 1);
    const p95 = durationsMs[p95Index]!;

    // eslint-disable-next-line no-console
    console.log(`[performance] GET /api/entries (${TOTAL_ROWS} rows, ${ACTIONABLE_ROWS} actionable across ${DISTINCT_PROJECTS} projects): p95=${p95.toFixed(1)}ms over ${MEASURED_REQUESTS} requests, budget=${LOCAL_P95_BUDGET_MS}ms`);
    expect(p95).toBeLessThan(LOCAL_P95_BUDGET_MS);
  }, 30_000);
});
