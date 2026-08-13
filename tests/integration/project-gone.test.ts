// A deleted project must reach P-PROJ-GONE, not the "Clockify could not be reached" path.
//
// Live-probed 2026-08-08 (evidence/error-shapes-2026-08-08.md): `projects.get` on a project that
// was created, archived, and deleted returns `400 {"message":"Project doesn't belong to
// Workspace","code":501}` — NOT 404, which is what docs/03 §2 originally claimed. Treating 404
// alone as "gone" makes the most common recovery scenario fail with a generic transport error.
//
// Per docs/13's mock-transport contract, only `fetch` is stubbed; the Clockify SDK stays real, so
// the ClockifyApiError this asserts on is the one the SDK actually constructs.
import { describe, expect, it } from "vitest";
import { buildClockifyClient } from "../../src/clockify/client.js";
import { fetchWorkspaceState } from "../../src/clockify/preflight-data.js";
import type { DeletedTimeEntry } from "../../src/domain/entry.js";

const WORKSPACE_ID = "ws-1";
const PROJECT_ID = "proj-deleted";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** Stubs every preflight read as empty/minimal, and answers the project lookup with `projectReply`. */
function stubFetch(projectReply: () => Response, onTaskList?: () => void): typeof fetch {
  return async (input) => {
    const url = new URL(
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : (input as Request).url,
    );
    const path = url.pathname;
    if (path.includes("/projects/")) return projectReply();
    if (path.endsWith("/tasks")) onTaskList?.();
    if (/\/workspaces\/[^/]+$/.test(path)) {
      return jsonResponse({ id: WORKSPACE_ID, workspaceSettings: {} });
    }
    if (path.endsWith("/users")) return jsonResponse([]);
    if (path.endsWith("/tags")) return jsonResponse([]);
    if (path.endsWith("/custom-fields")) return jsonResponse([]);
    return jsonResponse([], 200);
  };
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
  projectId: PROJECT_ID,
  projectName: "Gone Project",
  clientName: null,
  taskId: null,
  taskName: null,
  tags: [],
  customFieldValues: [],
};

function client(projectReply: () => Response, onTaskList?: () => void) {
  return buildClockifyClient(
    { apiUrl: "https://developer.clockify.me/api", authToken: "tok" },
    { fetch: stubFetch(projectReply, onTaskList) },
  );
}

describe("a gone project resolves to P-PROJ-GONE, not a transport failure", () => {
  it('maps the live shape 400 {"code":501} to "the project is gone"', async () => {
    const state = await fetchWorkspaceState(
      client(() =>
        jsonResponse({ message: "Project doesn't belong to Workspace", code: 501 }, 400),
      ),
      WORKSPACE_ID,
      SOURCE,
      {},
    );
    expect(state.effectiveProject).toBeNull();
  });

  it("still maps a 404 to the same outcome", async () => {
    const state = await fetchWorkspaceState(
      client(() => jsonResponse({ message: "Not found" }, 404)),
      WORKSPACE_ID,
      SOURCE,
      {},
    );
    expect(state.effectiveProject).toBeNull();
  });

  it("does not list tasks when the effective project is gone", async () => {
    let taskListCalls = 0;
    const state = await fetchWorkspaceState(
      client(
        () => jsonResponse({ message: "Not found" }, 404),
        () => { taskListCalls += 1; },
      ),
      WORKSPACE_ID,
      { ...SOURCE, taskId: "task-deleted", taskName: "Gone Task" },
      {},
    );
    expect(state.effectiveProject).toBeNull();
    expect(state.effectiveTask).toBeNull();
    expect(taskListCalls).toBe(0);
  });

  it("reports a project that still exists", async () => {
    const state = await fetchWorkspaceState(
      client(() => jsonResponse({ id: PROJECT_ID, name: "Live Project", archived: false })),
      WORKSPACE_ID,
      SOURCE,
      {},
    );
    expect(state.effectiveProject).toEqual({ id: PROJECT_ID, name: "Live Project", archived: false });
  });

  it("does NOT swallow an unrelated 400 — a body code other than 501 still fails the preflight", async () => {
    // The narrowing is scoped to code 501 on this one lookup. Anything else must stay honest.
    await expect(
      fetchWorkspaceState(
        client(() => jsonResponse({ message: "Something else", code: 4030 }, 400)),
        WORKSPACE_ID,
        SOURCE,
        {},
      ),
    ).rejects.toThrow();
  });

  it("does NOT swallow a 5xx", async () => {
    await expect(
      fetchWorkspaceState(
        client(() => jsonResponse({ message: "server error" }, 500)),
        WORKSPACE_ID,
        SOURCE,
        {},
      ),
    ).rejects.toThrow();
  });
});
