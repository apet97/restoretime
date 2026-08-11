// IT-14 (docs/13). Both halves live here: the preflight read and the AMBIGUOUS reconcile read.
// A stub transport returns full pages past `maxPages: 10`, so the page-bound condition
// (`page === maxPages && hasNextPage`) is the only thing that can stop the walk. Preflight then
// fails with "workspace too large to verify; try again", and a reconcile stays AMBIGUOUS and
// reports the bound — never a partial result, never a guess (docs/03 note 5, docs/07 §8).
//
// Per docs/13's mock-transport contract: "a stub fetch injected into createClockifyClient...the
// Clockify SDK stays real; only the network is stubbed." No fake client object.
import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../../src/store/db.js";
import { ingestDeletedEntry, getById } from "../../src/store/entries.js";
import { runReconcile } from "../../src/clockify/recreate.js";
import type { PlannedRequest } from "../../src/domain/entry.js";
import { buildClockifyClient } from "../../src/clockify/client.js";
import { fetchWorkspaceState, PreflightTruncatedError } from "../../src/clockify/preflight-data.js";
import type { DeletedTimeEntry } from "../../src/domain/entry.js";

const WORKSPACE_ID = "ws-1";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

/** Every page of `/tags` returns exactly `pageSize` (200) items, forever — the SDK's
 * `hasNextPage` heuristic ("this page returned exactly pageSize items") never goes false, so the
 * page-bound condition (`page === maxPages && hasNextPage`) is the only thing that can stop it. */
function stubFetchWithUnboundedTags(): typeof fetch {
  const impl: typeof fetch = async (input) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as Request).url);
    const path = url.pathname;
    if (path.endsWith("/tags")) {
      const page = Number(url.searchParams.get("page") ?? "1");
      const items = Array.from({ length: 200 }, (_, i) => ({
        id: `tag-${page}-${i}`,
        name: `Tag ${page}-${i}`,
        archived: false,
        workspaceId: WORKSPACE_ID,
      }));
      return jsonResponse(items);
    }
    if (/\/workspaces\/[^/]+$/.test(path)) {
      return jsonResponse({ id: WORKSPACE_ID, workspaceSettings: {} });
    }
    if (path.endsWith("/users")) return jsonResponse([]);
    if (path.endsWith("/custom-fields")) return jsonResponse([]);
    return jsonResponse({ message: "not stubbed", code: 0 }, 404);
  };
  return impl;
}

const SOURCE: DeletedTimeEntry = {
  workspaceId: WORKSPACE_ID,
  entryId: "entry-a",
  ownerId: "user-1",
  ownerName: "User One",
  description: "d",
  billable: true,
  start: "2026-08-08T10:00:00Z",
  end: "2026-08-08T11:00:00Z",
  wasRunning: false,
  type: "REGULAR",
  timeZone: "UTC",
  projectId: null, // no project/task lookup needed — isolates the truncation to /tags
  projectName: null,
  clientName: null,
  taskId: null,
  taskName: null,
  tags: [{ id: "tag-x", name: "Tag X" }],
  customFieldValues: [],
};

describe("IT-14 page bound reached (preflight)", () => {
  it("a paginated read that never terminates fails with the truncation error, never a partial result", async () => {
    const client = buildClockifyClient(
      { apiUrl: "https://developer.clockify.me/api", authToken: "tok" },
      { fetch: stubFetchWithUnboundedTags() },
    );

    await expect(fetchWorkspaceState(client, WORKSPACE_ID, SOURCE, {})).rejects.toThrow(
      PreflightTruncatedError,
    );
    await expect(fetchWorkspaceState(client, WORKSPACE_ID, SOURCE, {})).rejects.toThrow(
      "workspace too large to verify; try again",
    );
  });

  it("a workspace within the page bound succeeds normally", async () => {
    const boundedFetch: typeof fetch = async (input) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as Request).url);
      const path = url.pathname;
      if (path.endsWith("/tags")) {
        const page = Number(url.searchParams.get("page") ?? "1");
        if (page > 1) return jsonResponse([]);
        return jsonResponse([{ id: "tag-x", name: "Tag X", archived: false, workspaceId: WORKSPACE_ID }]);
      }
      if (/\/workspaces\/[^/]+$/.test(path)) return jsonResponse({ id: WORKSPACE_ID, workspaceSettings: {} });
      if (path.endsWith("/users")) return jsonResponse([{ id: "user-1", email: "a@b.com", name: "A", status: "ACTIVE" }]);
      if (path.endsWith("/custom-fields")) return jsonResponse([]);
      return jsonResponse({ message: "not stubbed", code: 0 }, 404);
    };
    const client = buildClockifyClient(
      { apiUrl: "https://developer.clockify.me/api", authToken: "tok" },
      { fetch: boundedFetch },
    );
    const state = await fetchWorkspaceState(client, WORKSPACE_ID, SOURCE, {});
    expect(state.ownerStatus).toBe("ACTIVE");
    expect(state.currentTags.get("tag-x")).toEqual({ id: "tag-x", archived: false });
  });
});

// --- IT-14, reconcile half -----------------------------------------------------------------
//
// The dangerous failure here is the quiet one: a truncated read sees a partial list, finds no
// match, and looks exactly like "Clockify never created it". That is the reasoning the user
// relies on to press "it was not created", which leads to a duplicate entry. So a truncated
// reconcile must stay AMBIGUOUS, report the bound, and not count as a check.
describe("IT-14 page bound reached (reconcile)", () => {
  const PLANNED: PlannedRequest = {
    workspaceId: WORKSPACE_ID,
    userId: "user-1",
    start: "2026-08-08T10:00:00Z",
    end: "2026-08-08T11:00:00Z",
    description: "Quarterly report",
    billable: true,
  };

  function stubUnboundedUserEntries(): typeof fetch {
    return async (input) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as Request).url);
      if (url.pathname.endsWith("/time-entries") && url.pathname.includes("/user/")) {
        const page = Number(url.searchParams.get("page") ?? "1");
        return jsonResponse(
          Array.from({ length: 200 }, (_, i) => ({
            id: `other-${page}-${i}`,
            description: "Quarterly report",
            billable: true,
            timeInterval: { start: "2026-01-01T00:00:00Z", end: "2026-01-01T01:00:00Z" },
            userId: "user-1",
            workspaceId: WORKSPACE_ID,
          })),
        );
      }
      return jsonResponse({ message: "not stubbed" }, 404);
    };
  }

  it("stays AMBIGUOUS and reports the bound instead of concluding nothing was created", async () => {
    const dir = mkdtempSync(join(tmpdir(), "restoretime-reconcile-bound-"));
    try {
      const db = openDatabase(join(dir, "restoretime.sqlite"));
      const { entry } = ingestDeletedEntry(db, {
        id: "re-1",
        workspaceId: WORKSPACE_ID,
        sourceEntryId: "entry-a",
        ownerId: "user-1",
        detectedAt: "2026-08-08T09:00:00Z",
        source: SOURCE,
      });
      db.prepare("UPDATE recoverable_entries SET lifecycle_state='AMBIGUOUS' WHERE id=?").run(entry.id);

      const client = buildClockifyClient(
        { apiUrl: "https://developer.clockify.me/api", authToken: "tok" },
        { fetch: stubUnboundedUserEntries() },
      );

      const result = await runReconcile({
        db,
        client,
        entryId: entry.id,
        workspaceId: WORKSPACE_ID,
        userId: "user-1",
        plannedRequest: PLANNED,
        baseline: [],
        expectedAttemptId: "no-attempt",
        recreatedBy: "user-1",
        now: new Date("2026-08-08T10:05:00Z"),
      });

      expect(result.kind).toBe("truncated");
      const after = getById(db, WORKSPACE_ID, entry.id);
      expect(after?.lifecycleState).toBe("AMBIGUOUS");
      expect(after?.newEntryId).toBeNull();
      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
