// Keyset pagination for `GET /api/entries` (docs/03). Before this, the list returned a fixed
// window with no continuation, so a workspace with more matching rows than one page could not
// reach the rest through the product at all — changing filters is a way to search, not a way to
// paginate. The ordering is `detected_at DESC, id DESC`; `id` is what makes a page boundary
// deterministic when a burst of deletions shares a timestamp.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateTestKeys, signTestToken, type ClockifyTestKeys } from "@apet97/clockify-addon-sdk/testing";
import { createServer, type AppServer } from "../../src/server.js";
import type { AppConfig } from "../../src/config.js";
import { seedInstallation } from "../support/installation-fixture.js";

const ADDON_KEY = "restoretime-pagination";
const WORKSPACE_ID = "ws-1";
const ADDON_ID = "addon-1";
const SCOPE = { workspaceId: WORKSPACE_ID, addonId: ADDON_ID };
const OWNER_ID = "user-1";
const TOTAL = 101;
const PAGE = 50;

let dir: string;
let keys: ClockifyTestKeys;
let server: AppServer;
let token: string;

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

/** Seeds rows directly: this suite is about traversal, not ingestion. Every row shares the same
 * filters so paging is the only way to reach the tail. */
function seedRows(count: number, sharedTimestamp = false): void {
  const insert = server.db.prepare(
    `INSERT INTO recoverable_entries
       (id, workspace_id, addon_id, source_entry_id, owner_id, detected_at, source_json, lifecycle_state)
     VALUES (@id, @workspaceId, @addonId, @sourceEntryId, @ownerId, @detectedAt, @sourceJson, 'RECREATED')`,
  );
  const run = server.db.transaction(() => {
    for (let i = 0; i < count; i += 1) {
      const index = String(i).padStart(4, "0");
      insert.run({
        id: `re-${index}`,
        workspaceId: WORKSPACE_ID,
        addonId: ADDON_ID,
        sourceEntryId: `source-${index}`,
        ownerId: OWNER_ID,
        // RECREATED rows skip the per-row preflight fan-out, keeping this suite about traversal.
        detectedAt: sharedTimestamp
          ? "2026-08-08T09:00:00.000Z"
          : new Date(Date.UTC(2026, 7, 8, 9, 0, i)).toISOString(),
        sourceJson: JSON.stringify({ workspaceId: WORKSPACE_ID, entryId: `source-${index}`, ownerId: OWNER_ID, tags: [] }),
      });
    }
  });
  run();
}

async function page(query: Record<string, string> = {}): Promise<{ ids: string[]; nextCursor: string | null; status: number; body: unknown }> {
  const response = await server.addon.handle({
    method: "GET",
    path: "/api/entries",
    query: new URLSearchParams(query),
    headers: { authorization: `Bearer ${token}` },
  });
  const body = response.body as { entries?: { id: string }[]; nextCursor?: string | null };
  return {
    ids: (body.entries ?? []).map((entry) => entry.id),
    nextCursor: body.nextCursor ?? null,
    status: response.status ?? 0,
    body: response.body,
  };
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "restoretime-pagination-"));
  keys = await generateTestKeys();
  server = await createServer(testConfig(), { publicKey: keys.publicKey });
  seedInstallation(server.db, SCOPE);
  token = await signTestToken(keys.privateKey, ADDON_KEY, {
    workspaceId: WORKSPACE_ID,
    addonId: ADDON_ID,
    user: OWNER_ID,
    workspaceRole: "admin",
  });
});

afterEach(() => {
  server.db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("GET /api/entries keyset pagination", () => {
  it("reaches every one of 101 identically-filtered rows exactly once", async () => {
    seedRows(TOTAL);

    const first = await page();
    expect(first.status).toBe(200);
    expect(first.ids).toHaveLength(PAGE);
    expect(first.nextCursor).not.toBeNull();

    const second = await page({ cursor: first.nextCursor! });
    expect(second.ids).toHaveLength(PAGE);
    expect(second.nextCursor).not.toBeNull();

    const third = await page({ cursor: second.nextCursor! });
    expect(third.ids).toHaveLength(TOTAL - 2 * PAGE);
    // The last page says so, rather than leaving the caller to infer it from a short page.
    expect(third.nextCursor).toBeNull();

    const all = [...first.ids, ...second.ids, ...third.ids];
    expect(new Set(all).size).toBe(TOTAL);
    // Newest first, and strictly descending across page boundaries.
    expect(all).toEqual([...all].sort().reverse());
  });

  it("keeps the boundary deterministic when every row shares one detected_at", async () => {
    seedRows(TOTAL, true);

    const first = await page();
    const second = await page({ cursor: first.nextCursor! });
    const third = await page({ cursor: second.nextCursor! });
    const all = [...first.ids, ...second.ids, ...third.ids];

    // With no id tiebreaker these pages would overlap or skip; the union proves neither happened.
    expect(new Set(all).size).toBe(TOTAL);
    expect(all).toEqual([...all].sort().reverse());
  });

  it("never repeats a row already returned when a newer row is inserted between pages", async () => {
    seedRows(TOTAL);
    const first = await page();

    server.db
      .prepare(
        `INSERT INTO recoverable_entries
           (id, workspace_id, addon_id, source_entry_id, owner_id, detected_at, source_json, lifecycle_state)
         VALUES ('re-newest', ?, ?, 'source-newest', ?, '2026-08-09T09:00:00.000Z', '{"tags":[]}', 'RECREATED')`,
      )
      .run(WORKSPACE_ID, ADDON_ID, OWNER_ID);

    const second = await page({ cursor: first.nextCursor! });
    // The cursor names a position in the order, so a row inserted ahead of it is simply not seen
    // by this traversal — it never shifts an already-returned row into a later page.
    expect(second.ids).not.toContain("re-newest");
    expect(first.ids.filter((id) => second.ids.includes(id))).toEqual([]);
  });

  it("rejects a malformed or unsupported cursor instead of silently returning page one", async () => {
    seedRows(3);
    for (const cursor of ["not-base64!", Buffer.from("{}", "utf8").toString("base64url"), Buffer.from(JSON.stringify({ v: 99, d: "x", i: "y" }), "utf8").toString("base64url")]) {
      const result = await page({ cursor });
      expect(result.status).toBe(400);
      expect(result.body).toEqual({ error: "cursor is not a valid continuation token; reload the list" });
    }
  });

  it("bounds a caller-supplied limit rather than trusting or silently clamping it", async () => {
    seedRows(TOTAL);
    expect((await page({ limit: "10" })).ids).toHaveLength(10);
    for (const limit of ["0", "51", "-1", "9999", "abc", "10.5"]) {
      const result = await page({ limit });
      expect(result.status).toBe(400);
      expect(result.body).toEqual({ error: `limit must be an integer between 1 and ${PAGE}` });
    }
  });

  it("cannot reach another installation generation's rows through a cursor", async () => {
    seedRows(TOTAL);
    const first = await page();

    // A second generation in the same workspace, with rows of its own.
    seedInstallation(server.db, { workspaceId: WORKSPACE_ID, addonId: "addon-2" }, 2_000);
    server.db
      .prepare(
        `INSERT INTO recoverable_entries
           (id, workspace_id, addon_id, source_entry_id, owner_id, detected_at, source_json, lifecycle_state)
         VALUES ('re-other-gen', ?, 'addon-2', 'source-other-gen', ?, '2026-08-08T09:00:30.000Z', '{"tags":[]}', 'RECREATED')`,
      )
      .run(WORKSPACE_ID, OWNER_ID);

    const second = await page({ cursor: first.nextCursor! });
    const third = await page({ cursor: second.nextCursor! });
    expect([...first.ids, ...second.ids, ...third.ids]).not.toContain("re-other-gen");
  });
});
