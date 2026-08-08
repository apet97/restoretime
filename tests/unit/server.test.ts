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

const { mockDeleteWorkspaceDomainData } = vi.hoisted(() => ({
  mockDeleteWorkspaceDomainData: vi.fn(),
}));
vi.mock("../../src/store/cascade.js", () => ({
  deleteWorkspaceDomainData: mockDeleteWorkspaceDomainData,
}));

// `import` bindings are hoisted, but vi.mock() above is additionally hoisted by Vitest's
// transform to run before the module graph loads, so createServer picks up the mocked cascade.
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
  mockDeleteWorkspaceDomainData.mockClear();
});

async function boot() {
  return createServer(testConfig(), { publicKey: keys.publicKey });
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

describe("GET /api/ping", () => {
  it("proves the requireViewer guard end-to-end for a valid token", async () => {
    const server = await boot();
    const token = await signTestToken(keys.privateKey, ADDON_KEY, {
      workspaceId: WORKSPACE_ID,
      addonId: ADDON_INSTALLATION_ID,
      user: "user-1",
      workspaceRole: "admin",
    });
    const response = await server.addon.handle({
      method: "GET",
      path: "/api/ping",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      ok: true,
      userId: "user-1",
      workspaceId: WORKSPACE_ID,
      workspaceRole: "admin",
    });
  });

  it("rejects a request with no Authorization header", async () => {
    const server = await boot();
    const response = await server.addon.handle({ method: "GET", path: "/api/ping", headers: {} });
    expect(response.status).toBe(401);
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
  it("removes the row unconditionally and calls the domain-data cascade", async () => {
    const server = await boot();
    const installToken = await lifecycleToken();
    await server.addon.handle(
      createTestLifecycleRequest(
        installToken,
        buildInstalledPayload({ workspaceId: WORKSPACE_ID, addonId: ADDON_INSTALLATION_ID }),
        { path: "/lifecycle/installed" },
      ),
    );

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
    expect(mockDeleteWorkspaceDomainData).toHaveBeenCalledTimes(1);
    expect(mockDeleteWorkspaceDomainData).toHaveBeenCalledWith(server.db, WORKSPACE_ID);
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

  it("returns 500 for a correctly verified delivery (stub — ingestion is PASS-02)", async () => {
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
    expect(response.status).toBe(500);
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
