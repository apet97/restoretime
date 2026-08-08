// IT-14 (docs/13), preflight half: a stub transport that returns full pages past `maxPages: 10`
// makes `fetchWorkspaceState` fail with "workspace too large to verify; try again" — never a
// partial result. The reconcile half of IT-14 (an AMBIGUOUS reconcile staying AMBIGUOUS and
// reporting the bound) lives in tests/integration/mutation.test.ts, once the reconcile path
// exists (layer 4) — this file is the preflight side, testable now that
// src/clockify/preflight-data.ts exists.
//
// Per docs/13's mock-transport contract: "a stub fetch injected into createClockifyClient...the
// Clockify SDK stays real; only the network is stubbed." No fake client object.
import { describe, expect, it } from "vitest";
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
