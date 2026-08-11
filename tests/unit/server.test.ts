import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildInstalledPayload,
  createTestComponentRequest,
  createTestLifecycleRequest,
  createTestWebhookRequest,
  generateTestKeys,
  signTestToken,
  type ClockifyTestKeys,
} from "@apet97/clockify-addon-sdk/testing";
import { validateClockifyManifest } from "@apet97/clockify-addon-sdk/clockify";
import type { AppConfig } from "../../src/config.js";
import { createServer } from "../../src/server.js";

const ADDON_KEY = "restoretime-test";
const WORKSPACE_ID = "ws-1";
const ADDON_INSTALLATION_ID = "addon-install-1";

function testConfig(): AppConfig {
  return {
    port: 0,
    publicBaseUrl: "https://addon.example.invalid",
    clockifyParentOrigin: "https://app.clockify.me",
    databasePath: ":memory:",
    addonKey: ADDON_KEY,
    tokenEncryptionKeyHex: "00".repeat(32),
    logLevel: "error",
  };
}

let keys: ClockifyTestKeys;

beforeEach(async () => {
  keys = await generateTestKeys();
});

async function boot() {
  return createServer(testConfig(), { publicKey: keys.publicKey });
}

function expectBrowserSecurityHeaders(response: { headers?: Record<string, string | readonly string[]> }): void {
  expect(response.headers?.["cache-control"]).toBe("no-store");
  expect(response.headers?.["referrer-policy"]).toBe("no-referrer");
  expect(response.headers?.["x-content-type-options"]).toBe("nosniff");
  expect(response.headers?.["permissions-policy"]).toBe(
    "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
  );
}

function lifecycleToken(claims: Record<string, unknown> = {}) {
  return signTestToken(keys.privateKey, ADDON_KEY, {
    workspaceId: WORKSPACE_ID,
    addonId: ADDON_INSTALLATION_ID,
    ...claims,
  });
}

describe("GET /manifest", () => {
  it("is auto-registered and serves a schema-valid manifest", async () => {
    const server = await boot();
    const response = await server.addon.handle({ method: "GET", path: "/manifest", headers: {} });
    expect(response.status).toBe(200);
    const result = validateClockifyManifest(response.body);
    expect(result.ok).toBe(true);
  });
});

describe("GET /healthz", () => {
  it("responds 200 without authentication and reports the database", async () => {
    const server = await boot();
    const response = await server.addon.handle({ method: "GET", path: "/healthz", headers: {} });
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ status: "ok", db: "ok" });
  });

  it("responds 500 when the database is unusable", async () => {
    const server = await boot();
    server.db.close();
    const response = await server.addon.handle({ method: "GET", path: "/healthz", headers: {} });
    expect(response.status).toBe(500);
    expect(response.body).toEqual({ status: "error", db: "error" });
  });
});

describe("GET /component", () => {
  it("serves the shell for a valid, non-expired component token", async () => {
    const server = await boot();
    const token = await signTestToken(keys.privateKey, ADDON_KEY, {
      workspaceId: WORKSPACE_ID,
      addonId: ADDON_INSTALLATION_ID,
      user: "user-1",
      workspaceRole: "admin",
    });
    const response = await server.addon.handle(
      createTestComponentRequest(token, { path: "/component" }),
    );
    expect(response.status).toBe(200);
    expect(String(response.body)).toContain("RestoreTime");
    // fact 12: CLOCKIFY_PARENT_ORIGIN feeds both the CSP frame-ancestors *and* the bridge's
    // parentOrigin. The shell carries the origin to the browser via this data attribute — cover
    // both sides, not just the CSP header, so a renamed/dropped attribute fails a test instead of
    // silently rendering "RestoreTime could not verify its parent frame" in a real iframe.
    expect(String(response.body)).toContain('data-parent-origin="https://app.clockify.me"');
    const csp = response.headers?.["content-security-policy"];
    expect(csp).toContain("frame-ancestors https://app.clockify.me");
    expect(csp).toContain("script-src 'self'");
    // `src/ui/api.ts` reaches /api/* with `fetch`; without an explicit connect-src the browser
    // falls back to default-src 'none' and blocks every call, so the component renders but never
    // loads data. No offline test can observe this — tests/e2e injects a stub fetch and happy-dom
    // does not enforce CSP — which is exactly how it reached a real browser. This asserts the
    // served policy instead; the live violation event is in evidence/live-release-run.md.
    expect(csp).toContain("connect-src 'self'");
    // Third directive with the same story: the stylesheet is an external resource, so without
    // style-src `default-src 'none'` blocks it and the component renders unstyled.
    expect(csp).toContain("style-src 'self'");
    expect(String(response.body)).toContain('<link rel="stylesheet" href="/static/app.css">');
    expectBrowserSecurityHeaders(response);
  });

  it("serves the stylesheet the shell links, as CSS", async () => {
    const server = await boot();
    const response = await server.addon.handle({ method: "GET", path: "/static/app.css", headers: {} });
    // Built from src/ in this suite (no dist/), so the loader reports missing rather than 200 —
    // what matters here is that the route exists and is not a 404, which would leave the <link>
    // above pointing at nothing.
    expect(response.status).not.toBe(404);
  });

  it("rejects an invalid token with 401", async () => {
    const server = await boot();
    const response = await server.addon.handle(
      createTestComponentRequest("not-a-real-token", { path: "/component" }),
    );
    expect(response.status).toBe(401);
  });

  it("rejects an expired token with 401", async () => {
    const server = await boot();
    const token = await signTestToken(
      keys.privateKey,
      ADDON_KEY,
      { workspaceId: WORKSPACE_ID, addonId: ADDON_INSTALLATION_ID, user: "user-1", workspaceRole: "admin" },
      "-10s",
    );
    const response = await server.addon.handle(
      createTestComponentRequest(token, { path: "/component" }),
    );
    expect(response.status).toBe(401);
  });
});

describe("GET /api/entries", () => {
  it("proves the requireViewer guard end-to-end for a valid token (PASS-02 replaces /api/ping)", async () => {
    const server = await boot();
    const token = await signTestToken(keys.privateKey, ADDON_KEY, {
      workspaceId: WORKSPACE_ID,
      addonId: ADDON_INSTALLATION_ID,
      user: "user-1",
      workspaceRole: "admin",
    });
    const response = await server.addon.handle({
      method: "GET",
      path: "/api/entries",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.status).toBe(200);
    // `truncated`/`limit` are part of the list contract: the server bounds the page, so the UI can
    // say "showing the N most recent" instead of letting a full page read as "everything".
    expect(response.body).toEqual({ entries: [], clockifyUnavailable: true, disabled: false, broken: false, truncated: false, limit: 50 });
  });

  it("rejects a request with no Authorization header", async () => {
    const server = await boot();
    const response = await server.addon.handle({ method: "GET", path: "/api/entries", headers: {} });
    expect(response.status).toBe(401);
  });
});

describe("GET /api/ping (removed in PASS-02)", () => {
  it("no longer exists", async () => {
    const server = await boot();
    const response = await server.addon.handle({ method: "GET", path: "/api/ping", headers: {} });
    expect(response.status).toBe(404);
  });
});

describe("lifecycle: INSTALLED", () => {
  it("persists an encrypted installation that decrypts back to the original token", async () => {
    const server = await boot();
    const payload = buildInstalledPayload({
      workspaceId: WORKSPACE_ID,
      addonId: ADDON_INSTALLATION_ID,
      authToken: "the-real-installation-secret",
      webhooks: [
        { path: "/webhooks/time-entry-deleted", webhookType: "ADDON", authToken: "the-webhook-secret" },
      ],
    });
    const token = await lifecycleToken();
    const response = await server.addon.handle(
      createTestLifecycleRequest(token, payload, { path: "/lifecycle/installed" }),
    );
    expect(response.status).toBe(204);

    // The row on disk must be ciphertext, not the plaintext token (docs/12 encryption at rest).
    const raw = server.db
      .prepare("SELECT auth_token FROM installations WHERE workspace_id = ? AND addon_id = ?")
      .get(WORKSPACE_ID, ADDON_INSTALLATION_ID) as { auth_token: string };
    expect(raw.auth_token).not.toBe("the-real-installation-secret");

    // The store's own decode path round-trips it back to the original.
    const loaded = await server.installations.load(WORKSPACE_ID, ADDON_INSTALLATION_ID);
    expect(loaded?.authToken).toBe("the-real-installation-secret");
    expect(loaded?.webhooks?.[0]?.authToken).toBe("the-webhook-secret");
  });
});

describe("lifecycle: STATUS_CHANGED", () => {
  it("flips the stored status", async () => {
    const server = await boot();
    const installToken = await lifecycleToken();
    await server.addon.handle(
      createTestLifecycleRequest(
        installToken,
        buildInstalledPayload({ workspaceId: WORKSPACE_ID, addonId: ADDON_INSTALLATION_ID }),
        { path: "/lifecycle/installed" },
      ),
    );

    const statusToken = await lifecycleToken();
    const response = await server.addon.handle(
      createTestLifecycleRequest(
        statusToken,
        { workspaceId: WORKSPACE_ID, addonId: ADDON_INSTALLATION_ID, status: "INACTIVE" },
        { path: "/lifecycle/status-changed" },
      ),
    );
    expect(response.status).toBe(204);

    const row = server.db
      .prepare("SELECT status FROM installations WHERE workspace_id = ? AND addon_id = ?")
      .get(WORKSPACE_ID, ADDON_INSTALLATION_ID) as { status: string };
    expect(row.status).toBe("INACTIVE");
  });
});

describe("lifecycle: DELETED", () => {
  it("removes the installation row and every domain-table row for the workspace, in one transaction", async () => {
    const server = await boot();
    const installToken = await lifecycleToken();
    await server.addon.handle(
      createTestLifecycleRequest(
        installToken,
        buildInstalledPayload({ workspaceId: WORKSPACE_ID, addonId: ADDON_INSTALLATION_ID }),
        { path: "/lifecycle/installed" },
      ),
    );
    server.db
      .prepare(
        `INSERT INTO recoverable_entries
           (id, workspace_id, source_entry_id, owner_id, detected_at, source_json, lifecycle_state)
         VALUES ('re-1', ?, 'entry-1', 'user-1', '2026-08-08T00:00:00.000Z', '{}', 'IDLE')`,
      )
      .run(WORKSPACE_ID);

    const deleteToken = await lifecycleToken();
    const response = await server.addon.handle(
      createTestLifecycleRequest(
        deleteToken,
        { workspaceId: WORKSPACE_ID, addonId: ADDON_INSTALLATION_ID, asUser: "user-1" },
        { path: "/lifecycle/deleted" },
      ),
    );
    expect(response.status).toBe(204);
    expect(await server.installations.load(WORKSPACE_ID, ADDON_INSTALLATION_ID)).toBeNull();
    const remaining = server.db
      .prepare("SELECT COUNT(*) AS n FROM recoverable_entries WHERE workspace_id = ?")
      .get(WORKSPACE_ID) as { n: number };
    expect(remaining.n).toBe(0);
  });
});

describe("POST /webhooks/time-entry-deleted", () => {
  async function installWithWebhookToken(server: Awaited<ReturnType<typeof boot>>, webhookToken: string) {
    const installToken = await lifecycleToken();
    await server.addon.handle(
      createTestLifecycleRequest(
        installToken,
        buildInstalledPayload({
          workspaceId: WORKSPACE_ID,
          addonId: ADDON_INSTALLATION_ID,
          webhooks: [{ path: "/webhooks/time-entry-deleted", webhookType: "ADDON", authToken: webhookToken }],
        }),
        { path: "/lifecycle/installed" },
      ),
    );
  }

  it("returns 204 and persists the row for a correctly verified delivery", async () => {
    const server = await boot();
    const webhookToken = await signTestToken(keys.privateKey, ADDON_KEY, {
      workspaceId: WORKSPACE_ID,
      addonId: ADDON_INSTALLATION_ID,
    });
    await installWithWebhookToken(server, webhookToken);

    const response = await server.addon.handle(
      createTestWebhookRequest(
        webhookToken,
        "TIME_ENTRY_DELETED",
        {
          id: "entry-1",
          workspaceId: WORKSPACE_ID,
          userId: "user-1",
          description: "hello",
          billable: true,
          projectId: null,
          type: "REGULAR",
          currentlyRunning: false,
          timeInterval: { start: "2026-08-08T10:00:00Z", end: "2026-08-08T11:00:00Z", timeZone: "UTC" },
          project: null,
          task: null,
          tags: [],
          user: { name: "User One" },
          customFieldValues: [],
        },
        { path: "/webhooks/time-entry-deleted" },
      ),
    );
    expect(response.status).toBe(204);
    const row = server.db
      .prepare("SELECT * FROM recoverable_entries WHERE workspace_id = ? AND source_entry_id = ?")
      .get(WORKSPACE_ID, "entry-1");
    expect(row).toBeDefined();
  });

  it("returns 400 for a malformed delivery (missing required fields)", async () => {
    const server = await boot();
    const webhookToken = await signTestToken(keys.privateKey, ADDON_KEY, {
      workspaceId: WORKSPACE_ID,
      addonId: ADDON_INSTALLATION_ID,
    });
    await installWithWebhookToken(server, webhookToken);

    const response = await server.addon.handle(
      createTestWebhookRequest(
        webhookToken,
        "TIME_ENTRY_DELETED",
        { id: "entry-1", workspaceId: WORKSPACE_ID },
        { path: "/webhooks/time-entry-deleted" },
      ),
    );
    expect(response.status).toBe(400);
  });

  it("returns 401 when the delivered token does not match the stored one", async () => {
    const server = await boot();
    const storedToken = await signTestToken(keys.privateKey, ADDON_KEY, {
      workspaceId: WORKSPACE_ID,
      addonId: ADDON_INSTALLATION_ID,
    });
    await installWithWebhookToken(server, storedToken);

    const otherToken = await signTestToken(keys.privateKey, ADDON_KEY, {
      workspaceId: WORKSPACE_ID,
      addonId: ADDON_INSTALLATION_ID,
      nonce: "different",
    });
    const response = await server.addon.handle(
      createTestWebhookRequest(
        otherToken,
        "TIME_ENTRY_DELETED",
        { id: "entry-1", workspaceId: WORKSPACE_ID },
        { path: "/webhooks/time-entry-deleted" },
      ),
    );
    expect(response.status).toBe(401);
  });

  it("returns 401 for an unknown installation and says so in the log", async () => {
    // A token lookup that finds nothing is a wiring failure, not an attack. The SDK only reports
    // it through the webhook options' own `onError`; without that reporter every delivery would
    // be rejected in silence until Clockify stopped retrying.
    const lines: string[] = [];
    const write = vi
      .spyOn(process.stdout, "write")
      .mockImplementation((chunk: string | Uint8Array) => {
        lines.push(String(chunk));
        return true;
      });
    try {
      const server = await boot();
      const token = await signTestToken(keys.privateKey, ADDON_KEY, {
        workspaceId: WORKSPACE_ID,
        addonId: ADDON_INSTALLATION_ID,
      });
      const response = await server.addon.handle(
        createTestWebhookRequest(
          token,
          "TIME_ENTRY_DELETED",
          { id: "entry-1", workspaceId: WORKSPACE_ID },
          { path: "/webhooks/time-entry-deleted" },
        ),
      );
      expect(response.status).toBe(401);
    } finally {
      write.mockRestore();
    }
    expect(lines.join("")).toContain("webhook token lookup failed");
  });
});

describe("lifecycle: STATUS_CHANGED for an installation this app does not hold", () => {
  it("acks with 204 without claiming a status change happened", async () => {
    const server = await boot();
    const token = await lifecycleToken();
    const response = await server.addon.handle(
      createTestLifecycleRequest(
        token,
        { workspaceId: WORKSPACE_ID, addonId: ADDON_INSTALLATION_ID, status: "INACTIVE" },
        { path: "/lifecycle/status-changed" },
      ),
    );
    expect(response.status).toBe(204);
    expect(
      server.db
        .prepare("SELECT COUNT(*) AS n FROM installations")
        .get() as { n: number },
    ).toEqual({ n: 0 });
  });
});
