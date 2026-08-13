// Proves the `recordingPassthroughFetch` seam (tests/live/support.ts, used by LV-09) works
// correctly when installed as `globalThis.fetch` — the exact way LV-09 installs it. Needs no
// credential and always runs: this is a mechanism proof, not a live scenario, so it belongs beside
// the helper it tests rather than under any LV-NN row.
//
// The bug this guards against: capturing "the real fetch" as the bare `fetch` identifier INSIDE
// the wrapper's own closure resolves through the global object at CALL TIME — by the time the
// wrapper is installed as `globalThis.fetch` and invoked, that identifier IS the wrapper itself,
// so every call recurses into itself and blows the stack on the very first request. The fix
// (`REAL_FETCH` captured once at module load, before any stubbing) is proved here by installing
// the wrapper and driving one real request through it against a closed local port: a fast,
// deterministic connection failure (ECONNREFUSED-shaped) is the expected outcome; a
// `RangeError: Maximum call stack size exceeded` would be the regression.
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ClockifyClient } from "clockify-sdk-ts-115";
import type { LiveEnv } from "./support.js";
import {
  assertNoSkippedLiveTests,
  assertLiveMutationTarget,
  assertLiveTargetIdentity,
  checkLiveAddonToken,
  checkLiveDeployedHost,
  checkLiveEnv,
  cleanupAllWorkspaceProbeArtifacts,
  cleanupAllWorkspaceProbes,
  recordingPassthroughFetch,
  runLiveCleanup,
  scanWorkspaceProbeArtifacts,
  validateLiveReceipt,
} from "./support.js";

function syntheticAddonJwt(overrides: Readonly<Record<string, unknown>> = {}): string {
  const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({
    iss: "clockify",
    sub: "restoretime",
    type: "addon",
    workspaceId: "ws-1",
    addonId: "addon-1",
    exp: Math.floor(Date.now() / 1000) + 3600,
    ...overrides,
  })).toString("base64url");
  return `${header}.${payload}.test-signature`;
}

const exactAddonToken = syntheticAddonJwt();

function stubExactRailwayHandoff(token = exactAddonToken): void {
  vi.stubEnv("CK_DEV_WORKSPACE_ID", "ws-1");
  vi.stubEnv("CK_DEV_ADDON_ID", "addon-1");
  vi.stubEnv("CK_DEV_ADDON_TOKEN", token);
  vi.stubEnv("CK_LIVE_INSTALLATION_SOURCE", "railway-handoff");
  vi.stubEnv("CK_RAILWAY_PROJECT_ID", "project-1");
  vi.stubEnv("CK_RAILWAY_ENVIRONMENT_ID", "environment-1");
  vi.stubEnv("CK_RAILWAY_SERVICE_ID", "service-1");
  vi.stubEnv("CK_RAILWAY_DEPLOYMENT_ID", "deployment-1");
  vi.stubEnv("CK_RAILWAY_DEPLOYMENT_INSTANCE_ID", "deployment-instance-1");
  vi.stubEnv("CK_LIVE_HANDOFF_PROJECT_ID", "project-1");
  vi.stubEnv("CK_LIVE_HANDOFF_ENVIRONMENT_ID", "environment-1");
  vi.stubEnv("CK_LIVE_HANDOFF_SERVICE_ID", "service-1");
  vi.stubEnv("CK_LIVE_HANDOFF_DEPLOYMENT_ID", "deployment-1");
  vi.stubEnv("CK_LIVE_HANDOFF_DEPLOYMENT_INSTANCE_ID", "deployment-instance-1");
  vi.stubEnv("CK_LIVE_HANDOFF_CANDIDATE_ID", "commit-abc");
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

const receiptEnv: LiveEnv = {
  apiKey: "redacted-api-key",
  apiUserId: "api-key-user",
  workspaceId: "ws-1",
  target: "developer",
  addonId: "addon-1",
  addonKey: "restoretime",
  candidateId: "commit-abc",
  lv02SourceId: "entry-1",
  addonToken: exactAddonToken,
};

describe("recordingPassthroughFetch (tests/live/support.ts)", () => {
  it("records the call and forwards to the REAL network fetch, not back into itself, once installed as globalThis.fetch", async () => {
    const recorded: { method: string; url: string }[] = [];
    vi.stubGlobal("fetch", recordingPassthroughFetch(recorded));

    // Port 1 is a closed, unprivileged-unreachable port on loopback: undici's fetch rejects with a
    // connection-refused-style error quickly and deterministically. A stack overflow would throw a
    // RangeError instead — an entirely different, easily distinguished failure shape.
    let caught: unknown;
    try {
      await fetch("http://127.0.0.1:1/");
      expect.unreachable("a request to a closed port must reject");
    } catch (err) {
      caught = err;
    }
    expect(caught).not.toBeInstanceOf(RangeError);
    expect(String(caught)).not.toMatch(/Maximum call stack size exceeded/);

    expect(recorded).toHaveLength(1);
    expect(recorded[0]?.method).toBe("GET");
    expect(recorded[0]?.url).toBe("http://127.0.0.1:1/");
  }, 10_000);
});

describe("live release gates", () => {
  it("keeps missing input diagnostic in test:live and fails it in test:live:release", () => {
    vi.stubEnv("CK_LIVE_TARGET", "");
    vi.stubEnv("CK_LIVE_STRICT", "0");
    expect(checkLiveEnv()).toMatchObject({ blocked: true, reason: expect.stringContaining("CK_LIVE_TARGET") });

    vi.stubEnv("CK_LIVE_STRICT", "1");
    expect(() => checkLiveEnv()).toThrow(/release gate blocked.*CK_LIVE_TARGET/);
  });

  it("rejects a production API base when the explicit target is developer", () => {
    vi.stubEnv("CK_LIVE_STRICT", "0");
    vi.stubEnv("CK_LIVE_TARGET", "developer");
    vi.stubEnv("CK_LIVE_API_KEY", "redacted");
    vi.stubEnv("CK_LIVE_API_USER_ID", "api-key-user");
    vi.stubEnv("CK_LIVE_WS", "ws-1");
    vi.stubEnv("CK_LIVE_ADDON_ID", "addon-1");
    vi.stubEnv("CK_LIVE_ADDON_KEY", "restoretime");
    vi.stubEnv("CK_LIVE_API_BASE", "https://api.clockify.me/api");
    expect(checkLiveEnv()).toMatchObject({ blocked: true, reason: expect.stringContaining("developer.clockify.me") });
  });

  it("requires the strict child environment to match the exact stored installation", () => {
    vi.stubEnv("CK_LIVE_STRICT", "1");
    stubExactRailwayHandoff();
    expect(checkLiveAddonToken(receiptEnv)).toMatchObject({ blocked: false });

    vi.stubEnv("CK_DEV_ADDON_ID", "another-addon");
    expect(() => checkLiveAddonToken(receiptEnv)).toThrow(/selected installation add-on/);
  });

  it.each([
    ["iss", "another-issuer"],
    ["sub", "another-addon-key"],
    ["type", "user"],
    ["workspaceId", "another-workspace"],
    ["addonId", "another-addon"],
  ])("rejects a strict installation token with the wrong %s claim", (claim, value) => {
    const token = syntheticAddonJwt({ [claim]: value });
    vi.stubEnv("CK_LIVE_STRICT", "1");
    stubExactRailwayHandoff(token);
    expect(() => checkLiveAddonToken({ ...receiptEnv, addonToken: token })).toThrow(new RegExp(`${claim} claim`));
  });

  it("accepts exact add-on claims and rejects a missing or expired token expiry", () => {
    vi.stubEnv("CK_LIVE_STRICT", "1");
    stubExactRailwayHandoff();
    expect(checkLiveAddonToken(receiptEnv)).toMatchObject({ blocked: false });

    const expired = syntheticAddonJwt({ exp: 1 });
    vi.stubEnv("CK_DEV_ADDON_TOKEN", expired);
    expect(() => checkLiveAddonToken({ ...receiptEnv, addonToken: expired })).toThrow(/exp claim/);

    const missingExpiry = syntheticAddonJwt({ exp: undefined });
    vi.stubEnv("CK_DEV_ADDON_TOKEN", missingExpiry);
    expect(() => checkLiveAddonToken({ ...receiptEnv, addonToken: missingExpiry })).toThrow(/exp claim/);
  });

  it("rejects a local installation row and a mismatched Railway deployment in strict mode", () => {
    vi.stubEnv("CK_LIVE_STRICT", "1");
    stubExactRailwayHandoff();
    vi.stubEnv("CK_LIVE_INSTALLATION_SOURCE", "local-database");
    expect(() => checkLiveAddonToken(receiptEnv)).toThrow(/candidate-bound Railway installation handoff/);

    vi.stubEnv("CK_LIVE_INSTALLATION_SOURCE", "railway-handoff");
    vi.stubEnv("CK_LIVE_HANDOFF_DEPLOYMENT_ID", "older-deployment");
    expect(() => checkLiveAddonToken(receiptEnv)).toThrow(/CK_LIVE_HANDOFF_DEPLOYMENT_ID/);
  });

  it.each([
    "http://candidate.example",
    "https://candidate.example/component",
    "https://candidate.example?query=1",
    "https://candidate.example#fragment",
  ])("rejects a deployed host that is not one exact HTTPS origin: %s", (host) => {
    vi.stubEnv("CK_LIVE_STRICT", "1");
    vi.stubEnv("CK_LIVE_ADDON_BASE_URL", host);
    expect(() => checkLiveDeployedHost()).toThrow(/HTTPS origin/);
  });

  it("accepts an exact LV-01B receipt and rejects a receipt for another candidate", () => {
    const receipt = {
      schemaVersion: 1,
      row: "LV-01B",
      target: "developer",
      workspaceId: "ws-1",
      addonId: "addon-1",
      addonKey: "restoretime",
      addonBaseUrl: "https://restoretime.example",
      candidateId: "commit-abc",
      observedAt: "2026-08-13T03:00:00.000Z",
      evidence: "operator screenshot and response-header capture",
      authenticatedComponentRendered: true,
      sidebarIconRendered: true,
      deletedEntryListLoaded: true,
      contentSecurityPolicyVerified: true,
      appConsoleErrorCount: 0,
      cspErrorCount: 0,
      frameAncestorsOrigin: "https://developer.clockify.me",
    };
    const expected = { row: "LV-01B" as const, env: receiptEnv, addonBaseUrl: "https://restoretime.example" };
    expect(validateLiveReceipt(receipt, expected)).toBeUndefined();
    expect(validateLiveReceipt({ ...receipt, candidateId: "another-commit" }, expected)).toMatch(/candidateId/);
    expect(validateLiveReceipt({ ...receipt, deletedEntryListLoaded: false }, expected)).toMatch(/deletedEntryListLoaded/);
    expect(validateLiveReceipt({ ...receipt, contentSecurityPolicyVerified: false }, expected)).toMatch(/contentSecurityPolicyVerified/);
    expect(validateLiveReceipt({ ...receipt, appConsoleErrorCount: 1 }, expected)).toMatch(/appConsoleErrorCount/);
    expect(validateLiveReceipt({ ...receipt, cspErrorCount: 1 }, expected)).toMatch(/cspErrorCount/);
  });

  it("requires LV-02B receipt evidence for one exact source entry", () => {
    const expected = { row: "LV-02B" as const, env: receiptEnv, addonBaseUrl: "https://restoretime.example" };
    const receipt = {
      schemaVersion: 1,
      row: "LV-02B",
      target: "developer",
      workspaceId: "ws-1",
      addonId: "addon-1",
      addonKey: "restoretime",
      addonBaseUrl: "https://restoretime.example",
      candidateId: "commit-abc",
      observedAt: "2026-08-13T03:00:00.000Z",
      evidence: "correlated service log export",
      sourceEntryId: "entry-1",
      railwayWebhookLogCorrelated: true,
      remoteSqliteRowPresent: true,
    };
    expect(validateLiveReceipt(receipt, expected)).toBeUndefined();
    expect(validateLiveReceipt({ ...receipt, sourceEntryId: "entry-2" }, expected)).toMatch(/sourceEntryId/);
    expect(validateLiveReceipt({ ...receipt, railwayWebhookLogCorrelated: false }, expected)).toMatch(/railwayWebhookLogCorrelated/);
    expect(validateLiveReceipt({ ...receipt, remoteSqliteRowPresent: false }, expected)).toMatch(/remoteSqliteRowPresent/);
  });

  it("fails the strict summary gate when Vitest reports a skipped test", () => {
    expect(() => assertNoSkippedLiveTests("Tests  12 passed | 1 skipped (13)\n")).toThrow(/skipped test/);
    expect(() => assertNoSkippedLiveTests("Tests  13 passed (13)\n")).not.toThrow();
    expect(() => assertNoSkippedLiveTests("LV-03 PARTIAL — missing field\nTests  13 passed (13)\n")).toThrow(/incomplete scenario/);
    expect(() => assertNoSkippedLiveTests("LV-08 blocked — workspace shape\nTests  13 passed (13)\n")).toThrow(/incomplete scenario/);
    expect(() => assertNoSkippedLiveTests("BLOCKED prerequisite was not proved\nTests  13 passed (13)\n")).toThrow(/incomplete scenario/);
    expect(() => assertNoSkippedLiveTests("LV-09 SKIP — no running entry\nTests  13 passed (13)\n")).toThrow(/incomplete scenario/);
  });

  it("verifies both live credentials and the exact manifest before a caller can mutate", async () => {
    const calls: string[] = [];
    const membership = [{ membershipType: "WORKSPACE", targetId: "ws-1", membershipStatus: "ACTIVE" }];
    const client = (credential: string) =>
      ({
        users: {
          getCurrentUser: vi.fn(async () => {
            calls.push(`${credential}:user`);
            return { id: `${credential}-user`, memberships: membership };
          }),
        },
        workspaces: {
          get: vi.fn(async () => {
            calls.push(`${credential}:workspace`);
            return { id: "ws-1", name: "Developer workspace" };
          }),
        },
      }) as unknown as ClockifyClient;
    const fetchImpl = vi.fn(async () => {
      calls.push("manifest");
      return new Response(JSON.stringify({ key: "restoretime", baseUrl: "https://candidate.example" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });

    await assertLiveMutationTarget(receiptEnv, "https://candidate.example", {
      apiKeyClient: client("api-key"),
      addonClient: client("addon-token"),
      fetchImpl,
    });

    expect(calls).toEqual([
      "api-key:user",
      "api-key:workspace",
      "manifest",
      "addon-token:user",
      "addon-token:workspace",
    ]);

    await expect(
      assertLiveMutationTarget({ ...receiptEnv, apiUserId: "another-user" }, "https://candidate.example", {
        apiKeyClient: client("api-key"),
        addonClient: client("addon-token"),
        fetchImpl,
      }),
    ).rejects.toThrow(/CK_LIVE_API_USER_ID/);

    await expect(
      assertLiveTargetIdentity({ ...receiptEnv, apiUserId: "another-user" }, client("api-key")),
    ).rejects.toThrow(/CK_LIVE_API_USER_ID/);
  });

  it("runs every cleanup step and fails strict mode after collecting cleanup errors", async () => {
    vi.stubEnv("CK_LIVE_STRICT", "1");
    const calls: string[] = [];
    await expect(
      runLiveCleanup([
        { label: "first", run: async () => { calls.push("first"); throw new Error("cleanup failed"); } },
        { label: "second", run: async () => { calls.push("second"); } },
      ]),
    ).rejects.toThrow(/first/);
    expect(calls).toEqual(["first", "second"]);
  });

  it("cleans probe entries across active and deactivated users and verifies a second unfiltered scan", async () => {
    const entries = new Map([
      ["user-1", [{ id: "probe-1", description: "RT-PROBE-LV03" }, { id: "ordinary-1", description: "work" }]],
      ["user-2", [{ id: "probe-2", description: "RT-PROBE-LV10" }]],
    ]);
    const listUsers = vi.fn(async () => [{ id: "user-1" }, { id: "user-2" }]);
    const listForUser = vi.fn(async (request: { userId: string; page?: number; description?: string }) =>
      request.page === 1 ? (entries.get(request.userId) ?? []) : [],
    );
    const deleteEntry = vi.fn(async (request: { timeEntryId: string }) => {
      for (const [userId, userEntries] of entries) {
        entries.set(userId, userEntries.filter((entry) => entry.id !== request.timeEntryId));
      }
    });
    const client = {
      users: { list: listUsers },
      timeEntries: { listForUser, delete: deleteEntry },
    } as unknown as ClockifyClient;

    await expect(cleanupAllWorkspaceProbes(receiptEnv, client)).resolves.toEqual({ deleted: 2 });
    expect(deleteEntry.mock.calls.map(([request]) => request.timeEntryId).sort()).toEqual(["probe-1", "probe-2"]);
    expect(listForUser).toHaveBeenCalledTimes(4);
    expect(listUsers).toHaveBeenCalledWith(expect.objectContaining({ status: "ALL" }));
    for (const [request] of listForUser.mock.calls) expect(request).not.toHaveProperty("description");
  });

  it("scans active and inactive tag and custom-field artifacts by the reserved prefix", async () => {
    const client = {
      tags: {
        list: vi.fn(async ({ archived, page }: { archived?: boolean; page?: number }) =>
          page === 1
            ? archived
              ? [{ id: "tag-archived", name: "RT-PROBE-old" }]
              : [{ id: "tag-active", name: "RT-PROBE-new" }, { id: "tag-real", name: "Real tag" }]
            : [],
        ),
      },
      customFields: {
        listForWorkspace: vi.fn(async ({ status, page }: { status?: string; page?: number }) =>
          page === 1 && status === "INACTIVE"
            ? [{ id: "field-inactive", name: "RT-PROBE-field" }]
            : [],
        ),
      },
    } as unknown as ClockifyClient;
    await expect(scanWorkspaceProbeArtifacts(client, "ws-1")).resolves.toEqual({
      tagIds: ["tag-active", "tag-archived"],
      customFieldIds: ["field-inactive"],
    });
  });

  it("attempts entry, tag, and custom-field cleanup before a strict aggregate failure", async () => {
    let tagDeleted = false;
    let fieldDeleted = false;
    const deleteTag = vi.fn(async () => { tagDeleted = true; });
    const deleteField = vi.fn(async () => { fieldDeleted = true; });
    const client = {
      users: { list: vi.fn(async ({ page }: { page?: number }) => page === 1 ? [{ id: "user-1" }] : []) },
      timeEntries: {
        listForUser: vi.fn(async ({ page }: { page?: number }) =>
          page === 1 ? [{ id: "entry-probe", description: "RT-PROBE-entry" }] : []),
        delete: vi.fn(async () => { throw new Error("entry delete failed"); }),
      },
      tags: {
        list: vi.fn(async ({ archived, page }: { archived?: boolean; page?: number }) =>
          page === 1 && archived === false && !tagDeleted ? [{ id: "tag-probe", name: "RT-PROBE-tag" }] : []),
        delete: deleteTag,
      },
      customFields: {
        listForWorkspace: vi.fn(async ({ status, page }: { status?: string; page?: number }) =>
          page === 1 && status === "VISIBLE" && !fieldDeleted
            ? [{ id: "field-probe", name: "RT-PROBE-field" }]
            : []),
        deleteForWorkspace: deleteField,
      },
    } as unknown as ClockifyClient;

    await expect(cleanupAllWorkspaceProbeArtifacts(receiptEnv, client)).rejects.toThrow(/1 delete request/);
    expect(deleteTag).toHaveBeenCalledOnce();
    expect(deleteField).toHaveBeenCalledOnce();
  });
});
