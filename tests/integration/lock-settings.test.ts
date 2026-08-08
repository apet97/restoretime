// An unlocked workspace must not look locked.
//
// Live-observed 2026-08-08 (evidence/live-release-run.md "Live run 8"): the developer workspace,
// which has no lock configured, returns `workspaceSettings.automaticLock: null` — an explicit null,
// not an absent field. The mapping read `automaticLock !== undefined`, so `null !== undefined` made
// `automaticLockSet` true on every such workspace. docs/07 §3 requires the setting to be *set*, so
// P-LOCK-REG then warned every regular user that "the entry's date may be in a locked period" on
// any entry 24 h or older — on a workspace with no lock at all.
//
// The unit preflight tests could not catch this: they build `WorkspaceState` directly and so start
// from `automaticLockSet` already decided. The defect lives in the API mapping, which is what this
// file exercises. Per docs/13's mock-transport contract only `fetch` is stubbed; the Clockify SDK
// stays real, so the parsed shape is the one the SDK actually produces.
import { describe, expect, it } from "vitest";
import { buildClockifyClient } from "../../src/clockify/client.js";
import { fetchSharedWorkspaceData } from "../../src/clockify/preflight-data.js";

const WORKSPACE_ID = "ws-1";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

/** Answers the workspace read with `settings`; every other preflight read is empty. */
function stubFetch(settings: unknown): typeof fetch {
  return async (input) => {
    const url = new URL(
      typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as Request).url,
    );
    if (/\/workspaces\/[^/]+$/.test(url.pathname)) {
      return jsonResponse({ id: WORKSPACE_ID, workspaceSettings: settings });
    }
    return jsonResponse([], 200);
  };
}

function read(settings: unknown) {
  return fetchSharedWorkspaceData(
    buildClockifyClient(
      { apiUrl: "https://developer.clockify.me/api", authToken: "tok" },
      { fetch: stubFetch(settings) },
    ),
    WORKSPACE_ID,
  );
}

describe("workspace lock settings are mapped from the shape Clockify really sends", () => {
  it("treats the live unlocked shape (automaticLock: null) as no lock", async () => {
    const data = await read({ automaticLock: null, lockTimeEntries: null });
    expect(data.automaticLockSet).toBe(false);
    expect(data.lockTimeEntries).toBeNull();
  });

  it("treats an absent automaticLock as no lock", async () => {
    expect((await read({})).automaticLockSet).toBe(false);
  });

  it("still detects a configured automatic lock", async () => {
    // The exact object Clockify returned with "Automatically update lock date" switched on,
    // captured from the developer workspace 2026-08-08 — not an invented shape.
    const data = await read({
      automaticLock: {
        type: "WEEKLY",
        changeDay: "WEDNESDAY",
        firstDay: "MONDAY",
        dayOfMonth: 1,
        olderThanPeriod: "DAYS",
        olderThanValue: 1,
      },
      lockTimeEntries: null,
    });
    expect(data.automaticLockSet).toBe(true);
  });

  it("still detects a manual lock date", async () => {
    const data = await read({ automaticLock: null, lockTimeEntries: "2026-08-01T00:00:00Z" });
    expect(data.lockTimeEntries).toBe("2026-08-01T00:00:00Z");
  });
});
