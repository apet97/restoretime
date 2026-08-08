// IT-15 (docs/13; N3 in docs/12 "Sensitive log leakage", docs/14 "Logging"). Captures every line written to
// process.stdout/stderr while a scripted run drives every logging call site this app has:
// lifecycle install, webhook ingest, list, detail, preflight (including a preflight failure whose
// underlying Clockify error body is adversarially crafted to *contain* a sentinel — proving the
// app never forwards a raw Clockify error body into a log line), a recreate FAILED outcome, and
// uninstall.
//
// The fixtures carry distinctive sentinel values (description, custom-field value, the
// installation's Clockify auth token, and the webhook's per-installation token) so the assertion
// is real: a regression that logged any of `src/log.ts`'s forbidden fields would fail this test,
// not just a decorative "logger exists" check.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildInstalledPayload,
  createTestComponentRequest,
  createTestLifecycleRequest,
  createTestWebhookRequest,
  generateTestKeys,
  signTestToken,
  type ClockifyTestKeys,
} from "@apet97/clockify-addon-sdk/testing";
import { createServer, type AppServer } from "../../src/server.js";
import type { AppConfig } from "../../src/config.js";

const ADDON_KEY = "restoretime-logaudit";
const WORKSPACE_ID = "ws-1";
const ADDON_ID = "addon-1";
const OWNER_ID = "user-1";

const SENTINEL_DESCRIPTION = "SENTINEL-DESC-9f3a1b7c-log-audit-marker";
const SENTINEL_CF_VALUE = "SENTINEL-CF-VALUE-2e88d4-log-audit-marker";
const SENTINEL_INSTALL_TOKEN = "SENTINEL-CLOCKIFY-AUTHTOKEN-55cc3-log-audit-marker";
const SENTINEL_ERROR_ECHO = "SENTINEL-ERROR-BODY-ECHO-77dd4-log-audit-marker";

let dir: string;
let keys: ClockifyTestKeys;
let lines: string[];
let stdoutSpy: ReturnType<typeof spyOnWrite>;
let stderrSpy: ReturnType<typeof spyOnWrite>;

function spyOnWrite(stream: NodeJS.WriteStream, sink: string[]) {
  return vi.spyOn(stream, "write").mockImplementation((chunk: unknown) => {
    sink.push(typeof chunk === "string" ? chunk : String(chunk));
    return true;
  });
}

function testConfig(): AppConfig {
  return {
    port: 0,
    publicBaseUrl: "https://addon.example.invalid",
    clockifyParentOrigin: "https://app.clockify.me",
    databasePath: join(dir, "restoretime.sqlite"),
    addonKey: ADDON_KEY,
    tokenEncryptionKeyHex: "00".repeat(32),
    logLevel: "debug",
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

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "restoretime-logaudit-"));
  keys = await generateTestKeys();
  lines = [];
  // Captured only for the duration of this one test (restored in afterEach), so the vitest
  // reporter's own output — which runs before/after this test body, not during it — is unaffected.
  stdoutSpy = spyOnWrite(process.stdout, lines);
  stderrSpy = spyOnWrite(process.stderr, lines);
});

afterEach(() => {
  stdoutSpy.mockRestore();
  stderrSpy.mockRestore();
  rmSync(dir, { recursive: true, force: true });
  vi.unstubAllGlobals();
});

async function boot(): Promise<AppServer> {
  return createServer(testConfig(), { publicKey: keys.publicKey });
}

async function componentToken(role = "admin") {
  return signTestToken(keys.privateKey, ADDON_KEY, { workspaceId: WORKSPACE_ID, addonId: ADDON_ID, user: OWNER_ID, workspaceRole: role });
}

describe("N3 log audit: sentinel values never appear in any captured log line", () => {
  it("webhook ingest, list, detail, a preflight failure with an echoing error body, a recreate FAILED outcome, and uninstall", async () => {
    const server = await boot();

    // 1. Install with a sentinel Clockify auth token (never logged; also proves the auth headers
    // never leak). The webhook's per-installation token has to be a real signed JWT for the SDK's
    // verifier to accept it (docs/13's own fixtures follow this pattern) — it is not a
    // human-authored sentinel, but it is unique per test run, so its presence in a log line would
    // still be conclusive proof of a leak.
    const installToken = await signTestToken(keys.privateKey, ADDON_KEY, { workspaceId: WORKSPACE_ID, addonId: ADDON_ID });
    const webhookToken = await signTestToken(keys.privateKey, ADDON_KEY, { workspaceId: WORKSPACE_ID, addonId: ADDON_ID });
    await server.addon.handle(
      createTestLifecycleRequest(
        installToken,
        buildInstalledPayload({
          workspaceId: WORKSPACE_ID,
          addonId: ADDON_ID,
          apiUrl: "https://developer.clockify.me/api",
          authToken: SENTINEL_INSTALL_TOKEN,
          webhooks: [{ path: "/webhooks/time-entry-deleted", webhookType: "ADDON", authToken: webhookToken }],
        }),
        { path: "/lifecycle/installed" },
      ),
    );

    // 2. Webhook ingest carrying the description and custom-field sentinels.
    const webhookResponse = await server.addon.handle(
      createTestWebhookRequest(
        webhookToken,
        "TIME_ENTRY_DELETED",
        {
          id: "entry-a",
          workspaceId: WORKSPACE_ID,
          userId: OWNER_ID,
          description: SENTINEL_DESCRIPTION,
          billable: true,
          projectId: null,
          type: "REGULAR",
          currentlyRunning: false,
          timeInterval: { start: "2026-08-08T10:00:00Z", end: "2026-08-08T11:00:00Z", timeZone: "UTC" },
          project: null,
          task: null,
          tags: [],
          user: { name: "User One" },
          customFieldValues: [{ customFieldId: "cf-1", name: "Ticket", value: SENTINEL_CF_VALUE }],
        },
        { path: "/webhooks/time-entry-deleted" },
      ),
    );
    expect(webhookResponse.status).toBe(204);

    const token = await componentToken("member");

    // 3. List (renders no Clockify sentinel data through the app's own logs — the route only
    // logs route/status).
    const listResponse = await server.addon.handle({
      method: "GET",
      path: "/api/entries",
      query: new URLSearchParams(),
      headers: { authorization: `Bearer ${token}` },
    });
    expect(listResponse.status).toBe(200);

    // 4. Detail.
    const detailResponse = await server.addon.handle({
      method: "GET",
      path: "/api/entries/detail",
      query: new URLSearchParams({ id: (listResponse.body as { entries: { id: string }[] }).entries[0]!.id }),
      headers: { authorization: `Bearer ${token}` },
    });
    expect(detailResponse.status).toBe(200);
    const entryId = (detailResponse.body as { entry: { id: string } }).entry.id;

    // 5. A preflight call whose underlying Clockify error body is adversarially crafted to
    // *contain* a sentinel — modeling a Clockify response that echoes request data back in an
    // error. `ClockifyApiError.message` embeds the whole body (clockify-sdk-ts-115), so this is
    // exactly the vector `src/clockify/errors.ts` `safeErrorSummary` exists to close. If the app
    // ever regresses to `String(error)`, this assertion catches it.
    // Every OTHER preflight lookup succeeds so the `users.list` rejection below is guaranteed to be
    // the one `Promise.all` in `fetchSharedWorkspaceData` rejects with — otherwise an unrelated
    // "unstubbed 404" from a parallel lookup could win the race and the sentinel would never
    // actually reach the code path under test, making the assertion decorative.
    vi.stubGlobal(
      "fetch",
      (async (input: string | URL | Request, init?: RequestInit) => {
        const path = pathOf(input);
        const method = methodOf(input, init);
        if (method === "GET" && /\/workspaces\/[^/]+$/.test(path)) return jsonResponse({ id: WORKSPACE_ID, workspaceSettings: {} });
        if (method === "GET" && path.endsWith("/tags")) return jsonResponse([]);
        if (method === "GET" && path.endsWith("/custom-fields")) return jsonResponse([]);
        if (method === "GET" && path.endsWith("/users")) {
          return jsonResponse({ message: "internal error", code: 999, echo: SENTINEL_ERROR_ECHO }, 500);
        }
        return jsonResponse({ message: "unstubbed" }, 404);
      }) as typeof fetch,
    );
    const preflightResponse = await server.addon.handle({
      method: "POST",
      path: "/api/entries/preflight",
      query: new URLSearchParams(),
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: { entryId, choices: {} },
    });
    expect(preflightResponse.status).toBe(502);

    // 6. A recreate FAILED outcome, again with an echoing error body on the create call.
    vi.stubGlobal(
      "fetch",
      (async (input: string | URL | Request, init?: RequestInit) => {
        const path = pathOf(input);
        const method = methodOf(input, init);
        if (method === "GET" && /\/workspaces\/[^/]+$/.test(path)) return jsonResponse({ id: WORKSPACE_ID, workspaceSettings: {} });
        if (method === "GET" && path.endsWith("/users")) return jsonResponse([{ id: OWNER_ID, email: "a@b.com", name: "User One", status: "ACTIVE" }]);
        if (method === "GET" && path.endsWith("/tags")) return jsonResponse([]);
        if (method === "GET" && path.endsWith("/custom-fields")) return jsonResponse([]);
        if (method === "GET" && path.endsWith("/time-entries") && path.includes("/user/")) return jsonResponse([]);
        if (method === "POST" && path.endsWith("/time-entries")) {
          return jsonResponse({ message: "Validation failed", code: 501, echo: SENTINEL_ERROR_ECHO }, 400);
        }
        return jsonResponse({ message: "unstubbed" }, 404);
      }) as typeof fetch,
    );
    const preflight2 = await server.addon.handle({
      method: "POST",
      path: "/api/entries/preflight",
      query: new URLSearchParams(),
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: { entryId, choices: {} },
    });
    expect(preflight2.status).toBe(200);
    const planId = (preflight2.body as { plan: { id: string } }).plan.id;
    const recreateResponse = await server.addon.handle({
      method: "POST",
      path: "/api/entries/recreate",
      query: new URLSearchParams(),
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: { entryId, planId },
    });
    expect(recreateResponse.status).toBe(200);
    expect((recreateResponse.body as { result: { outcome: string } }).result.outcome).toBe("FAILED");

    // 7. Uninstall.
    const deleteToken = await signTestToken(keys.privateKey, ADDON_KEY, { workspaceId: WORKSPACE_ID, addonId: ADDON_ID });
    await server.addon.handle(
      createTestLifecycleRequest(deleteToken, { workspaceId: WORKSPACE_ID, addonId: ADDON_ID, asUser: OWNER_ID }, { path: "/lifecycle/deleted" }),
    );

    // --- The assertion: every captured stdout/stderr line, across the whole run, is free of every
    // sentinel. Also touch the component route (never logs claims content) to widen coverage.
    await server.addon.handle(createTestComponentRequest(token, { path: "/component" }));

    expect(lines.length).toBeGreaterThan(0); // the audit method must actually have captured something
    const joined = lines.join("\n");
    for (const sentinel of [
      SENTINEL_DESCRIPTION,
      SENTINEL_CF_VALUE,
      SENTINEL_INSTALL_TOKEN,
      SENTINEL_ERROR_ECHO,
      webhookToken,
      installToken,
      token,
    ]) {
      expect(joined).not.toContain(sentinel);
    }
  });
});
