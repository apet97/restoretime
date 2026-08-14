// @vitest-environment happy-dom
//
// docs/13 §E2E: boot the iframe shell against a local server built with the SDK test-signing
// helpers, a stubbed Clockify transport, and drive list -> detail -> resolution -> confirm ->
// success, plus the unknown-result and blocked views. This runs the real esbuild-bundleable
// module (`src/ui/app.js`'s `boot()`), not a re-implementation of it: every assertion below reads
// `document` after real rendering code ran.
//
// The one fetch stub branches on path: `/api/*` is handled in-process by `server.addon.handle()`
// (no HTTP server, no sockets) — the same "stub fetch, real SDK" contract
// `tests/integration/api-walkthrough.test.ts` uses, just applied to the browser's own fetch calls
// instead of the server's. Everything else is the Clockify REST stub.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
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
import type { ClockifyBrowserWindow } from "@apet97/clockify-addon-sdk/ui";
import { createServer, type AppServer } from "../../src/server.js";
import type { AppConfig } from "../../src/config.js";
import { boot as bootApp, type BootOptions } from "../../src/ui/app.js";
import type { TokenAuthorityHandle } from "../../src/ui/bridge.js";

const ADDON_KEY = "restoretime-e2e";
const WORKSPACE_ID = "ws-1";
const ADDON_ID = "addon-1";
const OWNER_ID = "user-1";
const PARENT_ORIGIN = "https://app.clockify.me";

let dir: string;
let keys: ClockifyTestKeys;
let bootHandles: TokenAuthorityHandle[] = [];
let unexpectedResourceErrors: string[] = [];
let pendingFetches = new Set<Promise<Response>>();

function recordResourceError(event: Event): void {
  const target = event.target;
  if (target instanceof HTMLLinkElement) unexpectedResourceErrors.push(target.href);
  else if (target instanceof HTMLScriptElement || target instanceof HTMLImageElement || target instanceof HTMLIFrameElement) {
    unexpectedResourceErrors.push(target.src);
  }
}

function disableExternalResourceLoading(): void {
  const settings = (window as unknown as {
    happyDOM: { settings: { disableCSSFileLoading: boolean; disableJavaScriptFileLoading: boolean; disableIframePageLoading: boolean } };
  }).happyDOM.settings;
  settings.disableCSSFileLoading = true;
  settings.disableJavaScriptFileLoading = true;
  settings.disableIframePageLoading = true;
}

function boot(options: BootOptions): void {
  const handle = bootApp(options);
  if (handle) bootHandles.push(handle);
}

function testConfig(): AppConfig {
  return {
    port: 0,
    publicBaseUrl: "https://addon.example.invalid",
    clockifyParentOrigin: PARENT_ORIGIN,
    databasePath: join(dir, "restoretime.sqlite"),
    addonKey: ADDON_KEY,
    tokenEncryptionKeyHex: "00".repeat(32),
    logLevel: "error",
  };
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "restoretime-e2e-"));
  keys = await generateTestKeys();
  document.body.innerHTML = "";
  unexpectedResourceErrors = [];
  pendingFetches = new Set();
  disableExternalResourceLoading();
  window.addEventListener("error", recordResourceError, true);
});

afterEach(async () => {
  window.removeEventListener("error", recordResourceError, true);
  for (const handle of bootHandles) handle.dispose();
  bootHandles = [];
  while (pendingFetches.size > 0) await Promise.allSettled([...pendingFetches]);
  rmSync(dir, { recursive: true, force: true });
  vi.unstubAllGlobals();
  expect(unexpectedResourceErrors).toEqual([]);
});

async function bootServer(): Promise<AppServer> {
  return createServer(testConfig(), { publicKey: keys.publicKey });
}

async function install(server: AppServer, webhookToken: string): Promise<void> {
  const installToken = await signTestToken(keys.privateKey, ADDON_KEY, { workspaceId: WORKSPACE_ID, addonId: ADDON_ID });
  await server.addon.handle(
    createTestLifecycleRequest(
      installToken,
      buildInstalledPayload({
        workspaceId: WORKSPACE_ID,
        addonId: ADDON_ID,
        apiUrl: "https://developer.clockify.me/api",
        webhooks: [{ path: "/webhooks/time-entry-deleted", webhookType: "ADDON", authToken: webhookToken }],
      }),
      { path: "/lifecycle/installed" },
    ),
  );
}

function deletedEntryBody(overrides: Record<string, unknown> = {}) {
  return {
    id: "entry-a",
    workspaceId: WORKSPACE_ID,
    userId: OWNER_ID,
    description: "API investigation",
    billable: true,
    projectId: null,
    type: "REGULAR",
    currentlyRunning: false,
    timeInterval: { start: "2026-08-07T09:00:00Z", end: "2026-08-07T11:30:00Z", timeZone: "UTC" },
    project: null,
    task: null,
    tags: [],
    user: { name: "Ana Markovic" },
    customFieldValues: [],
    ...overrides,
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

/** The four workspace-level lookups every preflight makes (docs/07 §2), stubbed to the empty/no-op
 * shape a source entry with no project/task/tags/custom-fields needs. */
function baseClockifyStub(): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const path = pathOf(input);
    const method = methodOf(input, init);
    if (method === "GET" && /\/workspaces\/[^/]+$/.test(path)) return jsonResponse({ id: WORKSPACE_ID, workspaceSettings: {} });
    if (method === "GET" && path.endsWith("/users")) return jsonResponse([{ id: OWNER_ID, email: "a@b.com", name: "Ana Markovic", status: "ACTIVE" }]);
    if (method === "GET" && path.endsWith("/tags")) return jsonResponse([]);
    if (method === "GET" && path.endsWith("/custom-fields")) return jsonResponse([]);
    if (method === "GET" && path.endsWith("/projects")) return jsonResponse([]);
    if (method === "GET" && path.endsWith("/tasks")) return jsonResponse([]);
    return jsonResponse({ message: "unstubbed", code: 0 }, 404);
  }) as typeof fetch;
}

/** Bridges `/api/*` calls to the in-process addon router; everything else goes to `clockify`. This
 * is what the real browser's `fetch` resolves to inside the test — the UI code never knows it is
 * not talking to a real HTTP server.
 *
 * The app-call test is on `input` being a bare relative string, not just the path containing
 * `/api/` — Clockify's own REST base URL is `https://…/api/v1/…` (an *absolute* URL the SDK always
 * builds), which also contains the substring `/api/`. `src/ui/api.ts` only ever calls `fetch` with
 * a relative path (`/api/entries…`); the Clockify SDK only ever calls it with an absolute URL or a
 * `Request`. That distinction, not the path text, is what separates the two kinds of traffic. */
function makeFetchImpl(server: AppServer, clockify: typeof fetch): typeof fetch {
  return ((input: string | URL | Request, init?: RequestInit) => {
    const request = (async () => {
      const isAppCall = typeof input === "string" && input.startsWith("/api/");
      if (isAppCall) {
        const url = new URL(input, "http://localhost/");
        const method = methodOf(input, init);
        const rawHeaders = (init?.headers ?? {}) as Record<string, string>;
        const headers: Record<string, string> = {};
        for (const [k, v] of Object.entries(rawHeaders)) headers[k.toLowerCase()] = v;
        const rawBody = init?.body;
        const body = typeof rawBody === "string" && rawBody.length > 0 ? (JSON.parse(rawBody) as unknown) : undefined;
        const result = await server.addon.handle({
          method,
          path: url.pathname,
          query: url.searchParams,
          headers,
          ...(body !== undefined ? { body } : {}),
        });
        return new Response(result.body === undefined ? undefined : JSON.stringify(result.body), {
          status: result.status ?? 200,
          headers: { "content-type": "application/json" },
        });
      }
      return clockify(input, init);
    })();
    pendingFetches.add(request);
    void request.then(
      () => pendingFetches.delete(request),
      () => pendingFetches.delete(request),
    );
    return request;
  }) as typeof fetch;
}

/** Mirrors the SDK's own `tests/ui.test.ts` pattern: a hand-built `ClockifyBrowserWindow` whose
 * message plumbing is under the test's control, using the real happy-dom `document` so `src/ui/`'s
 * `document.createElement` calls land in the same tree `boot()` mounted into. */
function createTestWindow(authToken: string): {
  window: ClockifyBrowserWindow & { document: Document; location: { search: string } };
  postedMessages: { action: string; payload?: unknown }[];
  deliverToken(newToken: string): void;
} {
  const listeners = new Set<(event: { origin: string; source: unknown; data: unknown }) => void>();
  const postedMessages: { action: string; payload?: unknown }[] = [];
  const parent = {
    postMessage: (data: string) => {
      postedMessages.push(JSON.parse(data) as { action: string; payload?: unknown });
    },
  };
  const win = {
    document,
    location: { search: `?auth_token=${authToken}` },
    parent,
    addEventListener: (name: "message", listener: (event: { origin: string; source: unknown; data: unknown }) => void) => {
      if (name === "message") listeners.add(listener);
    },
    removeEventListener: (name: "message", listener: (event: { origin: string; source: unknown; data: unknown }) => void) => {
      if (name === "message") listeners.delete(listener);
    },
  };
  return {
    window: win,
    postedMessages,
    deliverToken(newToken) {
      for (const l of listeners) l({ origin: PARENT_ORIGIN, source: parent, data: { title: "refreshAddonToken", body: newToken } });
    },
  };
}

/** Fetches the real component shell, strips external assets (the test calls `boot()` directly and
 * does not exercise CSS), and mounts the real markup — proving the actual component-route output
 * is what `boot()` runs against, not a hand-rolled stand-in.
 *
 * The `innerHTML` assignment below is test-harness scaffolding only: the string comes from this
 * same test's own in-process server (`componentShellHtml()`, built from the fixed test config and
 * a JWT this test itself signed) — not from Clockify, a network response, or any Clockify-
 * controlled data. Production `src/ui/` code never uses `innerHTML` (`src/ui/dom.ts`'s
 * `el()`/`mount()` are the only escaping mechanism, text-node-only — AGENTS.md rule 12); this is
 * the one and only exception, confined to test setup. */
async function mountShell(server: AppServer, token: string): Promise<void> {
  const response = await server.addon.handle(createTestComponentRequest(token, { path: "/component" }));
  expect(response.status).toBe(200);
  const html = String(response.body);
  const inner = /<html>([\s\S]*)<\/html>/.exec(html)?.[1] ?? "";
  document.documentElement.innerHTML = inner
    .replace(/<script[^>]*><\/script>/, "")
    .replace(/<link[^>]*rel="stylesheet"[^>]*>/, "");
  expect(document.querySelector('link[rel="stylesheet"], script[src], iframe[src], img[src]')).toBeNull();
}

function text(): string {
  return document.getElementById("app")?.textContent ?? "";
}

function findButton(label: string): HTMLButtonElement {
  const buttons = Array.from(document.querySelectorAll("button"));
  const match = buttons.find((b) => b.textContent?.trim().startsWith(label));
  if (!match) throw new Error(`no button found starting with ${JSON.stringify(label)} (screen text: ${text()})`);
  return match as HTMLButtonElement;
}

function findSelect(): HTMLSelectElement {
  const select = document.querySelector("select");
  if (!select) throw new Error(`no <select> found (screen text: ${text()})`);
  return select as HTMLSelectElement;
}

async function tick(): Promise<void> {
  await Promise.resolve().then(() => new Promise((r) => setTimeout(r, 0)));
}

/** A DOM-driving action (click, change event) can kick off several sequential `await`s inside a
 * route handler (loadClient -> fetchSharedWorkspaceData -> preflight -> re-render); a fixed number
 * of ticks is a guess that is sometimes wrong. This polls the real screen text until it matches, or
 * fails with the current text so a mismatch is diagnosable instead of a bare timeout. */
async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error(`waitFor timed out. Screen text: ${JSON.stringify(text())}`);
    await tick();
  }
}

describe("component E2E: list -> detail -> resolution -> confirm -> success", () => {
  it("recreates an entry whose project is gone, after the user picks a replacement", async () => {
    const server = await bootServer();
    const webhookToken = await signTestToken(keys.privateKey, ADDON_KEY, { workspaceId: WORKSPACE_ID, addonId: ADDON_ID });
    await install(server, webhookToken);
    await server.addon.handle(
      createTestWebhookRequest(
        webhookToken,
        "TIME_ENTRY_DELETED",
        deletedEntryBody({ projectId: "gone-project", project: { id: "gone-project", name: "Legacy API" } }),
        { path: "/webhooks/time-entry-deleted" },
      ),
    );

    const clockify: typeof fetch = (async (input, init) => {
      const path = pathOf(input);
      const method = methodOf(input, init);
      if (method === "GET" && path.endsWith("/projects/gone-project")) return jsonResponse({ message: "Project doesn't belong to Workspace", code: 501 }, 400);
      if (method === "GET" && path.endsWith("/projects/proj-2")) return jsonResponse({ id: "proj-2", name: "Customer API", archived: false });
      if (method === "GET" && path.endsWith("/projects")) return jsonResponse([{ id: "proj-2", name: "Customer API", archived: false }]);
      if (method === "GET" && path.endsWith("/time-entries") && path.includes("/user/")) return jsonResponse([]); // baseline: empty
      if (method === "POST" && path.endsWith("/time-entries")) {
        return jsonResponse(
          {
            id: "new-entry-1",
            workspaceId: WORKSPACE_ID,
            userId: OWNER_ID,
            description: "API investigation",
            billable: true,
            projectId: "proj-2",
            tagIds: [],
            type: "REGULAR",
            timeInterval: { start: "2026-08-07T09:00:00Z", end: "2026-08-07T11:30:00Z" },
          },
          201,
        );
      }
      if (method === "GET" && path.includes("/time-entries/new-entry-1")) {
        return jsonResponse({
          id: "new-entry-1",
          workspaceId: WORKSPACE_ID,
          userId: OWNER_ID,
          description: "API investigation",
          billable: true,
          projectId: "proj-2",
          tagIds: [],
          type: "REGULAR",
          timeInterval: { start: "2026-08-07T09:00:00Z", end: "2026-08-07T11:30:00Z" },
        });
      }
      return baseClockifyStub()(input, init);
    }) as typeof fetch;

    vi.stubGlobal("fetch", makeFetchImpl(server, clockify));

    const token = await signTestToken(keys.privateKey, ADDON_KEY, {
      workspaceId: WORKSPACE_ID,
      addonId: ADDON_ID,
      user: OWNER_ID,
      workspaceRole: "member",
    });
    await mountShell(server, token);
    const { window, postedMessages } = createTestWindow(token);
    boot({ window, fetchImpl: makeFetchImpl(server, clockify) });
    await waitFor(() => text().includes("Deleted time entries"));

    // List view (docs/10 §1): the row, its status, and no console errors along the way.
    expect(text()).toContain("Deleted time entries");
    expect(text()).toContain("Needs your input");
    findButton("Recreate").click();
    await waitFor(() => text().includes("no longer exists"));

    // Detail view (docs/10 §3-§4): the P-PROJ-GONE resolution widget.
    expect(text()).toContain("no longer exists");
    const continueButton = findButton("Continue to confirm");
    expect(continueButton.hasAttribute("disabled")).toBe(true);

    // Resolution: pick the replacement project (docs/10 §4).
    await waitFor(() => findSelect().options.length > 2); // let the options fetch populate the <select>
    const select = findSelect();
    select.value = "proj-2";
    select.dispatchEvent(new Event("change"));
    await waitFor(() => {
      const button = Array.from(document.querySelectorAll("button")).find((candidate) => candidate.textContent === "Continue to confirm");
      return button !== undefined && !button.hasAttribute("disabled");
    });

    const continueButton2 = findButton("Continue to confirm");
    expect(continueButton2.hasAttribute("disabled")).toBe(false);
    continueButton2.click();
    await waitFor(() => text().includes("Confirm recreation"));

    // Confirm view (docs/10 §5).
    expect(text()).toContain("Fidelity: Adjusted");
    findButton("Recreate entry").click();
    await waitFor(() => text().includes("Time entry recreated.") || text().includes("did not create"));

    // Success view (docs/10 §6).
    expect(text()).toContain("Time entry recreated.");
    expect(text()).toContain("Fidelity: Adjusted");
    // Bridge integration (pass file scope): showToast alongside navigate("tracker").
    expect(postedMessages).toContainEqual({ action: "toastrPop", payload: { type: "success", message: "Time entry recreated." } });
    const openButton = findButton("Open in Clockify tracker");
    openButton.click();
    expect(postedMessages).toContainEqual({ action: "navigate", payload: { type: "tracker" } });
    findButton("Back to deleted entries").click();
    await waitFor(() => text().includes("Deleted time entries"));
  });
});

describe("component E2E: member dismissal", () => {
  it("lets a member show and undismiss their own dismissed entry", async () => {
    const server = await bootServer();
    const webhookToken = await signTestToken(keys.privateKey, ADDON_KEY, { workspaceId: WORKSPACE_ID, addonId: ADDON_ID });
    await install(server, webhookToken);
    await server.addon.handle(
      createTestWebhookRequest(webhookToken, "TIME_ENTRY_DELETED", deletedEntryBody(), {
        path: "/webhooks/time-entry-deleted",
      }),
    );

    const clockify = baseClockifyStub();
    const fetchImpl = makeFetchImpl(server, clockify);
    vi.stubGlobal("fetch", fetchImpl);
    const token = await signTestToken(keys.privateKey, ADDON_KEY, {
      workspaceId: WORKSPACE_ID,
      addonId: ADDON_ID,
      user: OWNER_ID,
      workspaceRole: "member",
    });
    await mountShell(server, token);
    const { window } = createTestWindow(token);
    boot({ window, fetchImpl });
    await waitFor(() => text().includes("API investigation"));

    findButton("Recreate").click();
    await waitFor(() => Array.from(document.querySelectorAll("button")).some((button) => button.textContent?.trim() === "Dismiss"));
    findButton("Dismiss").click();
    await waitFor(() => text().includes("No deleted time entries"));

    const showDismissed = Array.from(document.querySelectorAll('input[type="checkbox"]')).find((input) =>
      input.closest("label")?.textContent?.includes("Show dismissed"),
    ) as HTMLInputElement | undefined;
    expect(showDismissed).toBeDefined();
    showDismissed!.checked = true;
    showDismissed!.dispatchEvent(new Event("change"));
    await waitFor(() => text().includes("Status: Dismissed"));

    const title = document.querySelector("button.rt-title") as HTMLButtonElement | null;
    expect(title).not.toBeNull();
    title!.click();
    await waitFor(() => text().includes("This entry is hidden from the default list"));
    findButton("Undismiss").click();
    await waitFor(() => text().includes("Deleted time entry") && text().includes("Continue to confirm"));

    findButton("Back to deleted entries").click();
    await waitFor(() => text().includes("API investigation") && text().includes("Show dismissed"));
  });
});

describe("component E2E: blocked entry", () => {
  it("shows the blocker and never enables the confirm action", async () => {
    const server = await bootServer();
    const webhookToken = await signTestToken(keys.privateKey, ADDON_KEY, { workspaceId: WORKSPACE_ID, addonId: ADDON_ID });
    await install(server, webhookToken);
    await server.addon.handle(
      createTestWebhookRequest(webhookToken, "TIME_ENTRY_DELETED", deletedEntryBody({ type: "BREAK" }), {
        path: "/webhooks/time-entry-deleted",
      }),
    );

    const clockify = baseClockifyStub();
    vi.stubGlobal("fetch", makeFetchImpl(server, clockify));
    const token = await signTestToken(keys.privateKey, ADDON_KEY, {
      workspaceId: WORKSPACE_ID,
      addonId: ADDON_ID,
      user: OWNER_ID,
      workspaceRole: "member",
    });
    await mountShell(server, token);
    const { window } = createTestWindow(token);
    boot({ window, fetchImpl: makeFetchImpl(server, clockify) });
    await waitFor(() => text().includes("Deleted time entries"));

    expect(text()).toContain("Blocked");
    findButton("Recreate").click();
    await waitFor(() => text().includes("cannot be recreated"));

    expect(text()).toContain("RestoreTime recreates regular time entries only.");
    const continueButton = findButton("Continue to confirm");
    expect(continueButton.hasAttribute("disabled")).toBe(true);
  });
});

describe("component E2E: unknown result (AMBIGUOUS)", () => {
  it("never implies the entry was not created, and offers Check now", async () => {
    const server = await bootServer();
    const webhookToken = await signTestToken(keys.privateKey, ADDON_KEY, { workspaceId: WORKSPACE_ID, addonId: ADDON_ID });
    await install(server, webhookToken);
    await server.addon.handle(
      createTestWebhookRequest(webhookToken, "TIME_ENTRY_DELETED", deletedEntryBody(), { path: "/webhooks/time-entry-deleted" }),
    );

    const clockify: typeof fetch = (async (input, init) => {
      const path = pathOf(input);
      const method = methodOf(input, init);
      if (method === "GET" && path.endsWith("/time-entries") && path.includes("/user/")) return jsonResponse([]);
      if (method === "POST" && path.endsWith("/time-entries")) throw new TypeError("simulated connection reset");
      return baseClockifyStub()(input, init);
    }) as typeof fetch;
    vi.stubGlobal("fetch", makeFetchImpl(server, clockify));

    const token = await signTestToken(keys.privateKey, ADDON_KEY, {
      workspaceId: WORKSPACE_ID,
      addonId: ADDON_ID,
      user: OWNER_ID,
      workspaceRole: "member",
    });
    await mountShell(server, token);
    const { window } = createTestWindow(token);
    boot({ window, fetchImpl: makeFetchImpl(server, clockify) });
    await waitFor(() => text().includes("Deleted time entries"));

    findButton("Recreate").click();
    await waitFor(() => text().includes("Continue to confirm"));
    findButton("Continue to confirm").click();
    await waitFor(() => text().includes("Confirm recreation"));
    findButton("Recreate entry").click();
    await waitFor(() => text().includes("We do not know") || text().includes("Time entry recreated"));

    expect(text()).toContain("We do not know whether Clockify created this entry.");
    expect(text()).toContain("Do not create the entry by hand yet.");
    expect(text()).not.toMatch(/was not created|not created/i);
    findButton("Check now"); // present — never auto-polled, always an explicit user action
  });
});

describe("component E2E: failed (nothing created)", () => {
  it("shows the mapped reason and lets the user review a new plan", async () => {
    const server = await bootServer();
    const webhookToken = await signTestToken(keys.privateKey, ADDON_KEY, { workspaceId: WORKSPACE_ID, addonId: ADDON_ID });
    await install(server, webhookToken);
    await server.addon.handle(
      createTestWebhookRequest(webhookToken, "TIME_ENTRY_DELETED", deletedEntryBody(), { path: "/webhooks/time-entry-deleted" }),
    );

    const clockify: typeof fetch = (async (input, init) => {
      const path = pathOf(input);
      const method = methodOf(input, init);
      if (method === "GET" && path.endsWith("/time-entries") && path.includes("/user/")) return jsonResponse([]);
      // A real 4xx rejection (docs/03 §6): body code 501, mapped by clockifyErrorCode/
      // describeClockifyCreateFailure to a fixed reason — nothing is created, atomically (R3).
      if (method === "POST" && path.endsWith("/time-entries")) return jsonResponse({ message: "Missing required field", code: 501 }, 400);
      return baseClockifyStub()(input, init);
    }) as typeof fetch;
    vi.stubGlobal("fetch", makeFetchImpl(server, clockify));

    const token = await signTestToken(keys.privateKey, ADDON_KEY, {
      workspaceId: WORKSPACE_ID,
      addonId: ADDON_ID,
      user: OWNER_ID,
      workspaceRole: "member",
    });
    await mountShell(server, token);
    const { window } = createTestWindow(token);
    boot({ window, fetchImpl: makeFetchImpl(server, clockify) });
    await waitFor(() => text().includes("Deleted time entries"));

    findButton("Recreate").click();
    await waitFor(() => text().includes("Continue to confirm"));
    findButton("Continue to confirm").click();
    await waitFor(() => text().includes("Confirm recreation"));
    findButton("Recreate entry").click();
    await waitFor(() => text().includes("did not create"));

    // docs/10 §6 Failed: what happened, nothing was created, what to do next.
    expect(text()).toContain("Clockify did not create the entry.");
    expect(text()).toContain("Reason:");
    expect(text()).toContain("Nothing was created. Review a new plan before you recreate the entry.");

    // "Review a new plan" re-enters the resolve flow (forceResolve) rather than redisplaying the same
    // failure — the row is still IDLE-equivalent (FAILED, but claimable again) server-side.
    findButton("Review a new plan").click();
    await waitFor(() => text().includes("Continue to confirm"));
    expect(text()).not.toContain("Clockify did not create the entry.");
  });
});

// UT-X01 extension (docs/13): src/ui/dom.ts's el()/mount() — text-node-only construction — is the
// UI's whole escaping mechanism (there is no string-built HTML anywhere in src/ui/). This proves it
// against a hostile description and a hostile tag name: both render as visible text, and neither
// produces a real element the browser would execute or that could hijack the page's styling/DOM.
describe("component E2E: escaping — hostile Clockify content never becomes markup", () => {
  it("renders a hostile description and tag name as text, not elements", async () => {
    const server = await bootServer();
    const webhookToken = await signTestToken(keys.privateKey, ADDON_KEY, { workspaceId: WORKSPACE_ID, addonId: ADDON_ID });
    await install(server, webhookToken);
    const hostileDescription = '<img src=x onerror="alert(1)">';
    const hostileTagName = '"><script>alert(document.cookie)</script>';
    await server.addon.handle(
      createTestWebhookRequest(
        webhookToken,
        "TIME_ENTRY_DELETED",
        deletedEntryBody({
          description: hostileDescription,
          tags: [{ id: "tag-hostile", name: hostileTagName }],
        }),
        { path: "/webhooks/time-entry-deleted" },
      ),
    );

    const clockify = baseClockifyStub();
    vi.stubGlobal("fetch", makeFetchImpl(server, clockify));
    const token = await signTestToken(keys.privateKey, ADDON_KEY, {
      workspaceId: WORKSPACE_ID,
      addonId: ADDON_ID,
      user: OWNER_ID,
      workspaceRole: "member",
    });
    await mountShell(server, token);
    const { window } = createTestWindow(token);
    boot({ window, fetchImpl: makeFetchImpl(server, clockify) });
    await waitFor(() => text().includes("Deleted time entries"));

    const app = document.getElementById("app");
    if (!app) throw new Error("no #app root");

    // The hostile strings are visible as literal text…
    expect(app.textContent).toContain(hostileDescription);
    expect(app.textContent).toContain(hostileTagName);
    // …but never became real elements or attributes the browser would act on.
    expect(app.querySelector("img")).toBeNull();
    expect(app.querySelector("script")).toBeNull();
    expect(app.querySelector("svg")).toBeNull();
    expect(app.querySelector("[onerror]")).toBeNull();
    expect(app.querySelector("[onload]")).toBeNull();
    // The DOM's own serialization of what actually got inserted never contains an open tag drawn
    // from the hostile text — every `<` from the source became a text node's literal character.
    expect(app.innerHTML).not.toMatch(/<img\b/i);
    expect(app.innerHTML).not.toMatch(/<script\b/i);
    expect(app.innerHTML).not.toMatch(/<svg\b/i);
  });
});

describe("component E2E: disabled installation (docs/10 §8)", () => {
  it("shows the disabled notice and hides the Recreate action, but the list stays readable", async () => {
    const server = await bootServer();
    const webhookToken = await signTestToken(keys.privateKey, ADDON_KEY, { workspaceId: WORKSPACE_ID, addonId: ADDON_ID });
    await install(server, webhookToken);
    await server.addon.handle(
      createTestWebhookRequest(webhookToken, "TIME_ENTRY_DELETED", deletedEntryBody(), { path: "/webhooks/time-entry-deleted" }),
    );
    // STATUS_CHANGED -> INACTIVE (docs/14): data is kept, only the notice and actions change.
    server.db.prepare("UPDATE installations SET status='INACTIVE' WHERE workspace_id=? AND addon_id=?").run(WORKSPACE_ID, ADDON_ID);

    const clockify = baseClockifyStub();
    vi.stubGlobal("fetch", makeFetchImpl(server, clockify));
    const token = await signTestToken(keys.privateKey, ADDON_KEY, {
      workspaceId: WORKSPACE_ID,
      addonId: ADDON_ID,
      user: OWNER_ID,
      workspaceRole: "member",
    });
    await mountShell(server, token);
    const { window } = createTestWindow(token);
    boot({ window, fetchImpl: makeFetchImpl(server, clockify) });
    await waitFor(() => text().includes("Deleted time entries"));

    expect(text()).toContain("RestoreTime is disabled for this workspace.");
    // The list itself stays readable (docs/10 §8 "lists stay readable") …
    expect(text()).toContain("API investigation");
    // … but the row's Recreate action is gone.
    expect(() => findButton("Recreate")).toThrow();
  });
});

describe("component E2E: broken installation (docs/11, docs/14 reinstall notice)", () => {
  it("shows the reinstall notice on the list when the addon token was rejected", async () => {
    const server = await bootServer();
    const webhookToken = await signTestToken(keys.privateKey, ADDON_KEY, { workspaceId: WORKSPACE_ID, addonId: ADDON_ID });
    await install(server, webhookToken);
    await server.addon.handle(
      createTestWebhookRequest(webhookToken, "TIME_ENTRY_DELETED", deletedEntryBody(), { path: "/webhooks/time-entry-deleted" }),
    );
    // The state a 401 code 4017 leaves behind (IT-08): `broken_at` set, `status` untouched.
    server.db
      .prepare("UPDATE installations SET broken_at=? WHERE workspace_id=? AND addon_id=?")
      .run("2026-08-08T09:02:00Z", WORKSPACE_ID, ADDON_ID);

    const clockify = baseClockifyStub();
    vi.stubGlobal("fetch", makeFetchImpl(server, clockify));
    const token = await signTestToken(keys.privateKey, ADDON_KEY, {
      workspaceId: WORKSPACE_ID,
      addonId: ADDON_ID,
      user: OWNER_ID,
      workspaceRole: "member",
    });
    await mountShell(server, token);
    const { window } = createTestWindow(token);
    boot({ window, fetchImpl: makeFetchImpl(server, clockify) });
    await waitFor(() => text().includes("Deleted time entries"));

    expect(text()).toContain("Ask a workspace admin to reinstall this add-on, then reload RestoreTime.");
    // The list itself stays readable — a broken token blocks Clockify calls, not stored rows.
    expect(text()).toContain("API investigation");
  });
});

describe("component E2E: bulk flow (docs/10 §7, admin)", () => {
  it("reviews two ready entries and recreates both", async () => {
    const server = await bootServer();
    const webhookToken = await signTestToken(keys.privateKey, ADDON_KEY, { workspaceId: WORKSPACE_ID, addonId: ADDON_ID });
    await install(server, webhookToken);
    await server.addon.handle(
      createTestWebhookRequest(webhookToken, "TIME_ENTRY_DELETED", deletedEntryBody({ id: "entry-a" }), {
        path: "/webhooks/time-entry-deleted",
      }),
    );
    await server.addon.handle(
      createTestWebhookRequest(
        webhookToken,
        "TIME_ENTRY_DELETED",
        deletedEntryBody({ id: "entry-b", description: "Second entry" }),
        { path: "/webhooks/time-entry-deleted" },
      ),
    );

    let creates = 0;
    const clockify: typeof fetch = (async (input, init) => {
      const path = pathOf(input);
      const method = methodOf(input, init);
      if (method === "GET" && path.endsWith("/time-entries") && path.includes("/user/")) return jsonResponse([]);
      if (method === "POST" && path.endsWith("/time-entries")) {
        creates += 1;
        return jsonResponse(
          {
            id: `new-entry-${creates}`,
            workspaceId: WORKSPACE_ID,
            userId: OWNER_ID,
            description: creates === 1 ? "API investigation" : "Second entry",
            billable: true,
            tagIds: [],
            type: "REGULAR",
            timeInterval: { start: "2026-08-07T09:00:00Z", end: "2026-08-07T11:30:00Z" },
          },
          201,
        );
      }
      if (method === "GET" && path.includes("/time-entries/new-entry-")) {
        const id = path.split("/").pop();
        return jsonResponse({
          id,
          workspaceId: WORKSPACE_ID,
          userId: OWNER_ID,
          description: id === "new-entry-1" ? "API investigation" : "Second entry",
          billable: true,
          tagIds: [],
          type: "REGULAR",
          timeInterval: { start: "2026-08-07T09:00:00Z", end: "2026-08-07T11:30:00Z" },
        });
      }
      return baseClockifyStub()(input, init);
    }) as typeof fetch;
    vi.stubGlobal("fetch", makeFetchImpl(server, clockify));

    const token = await signTestToken(keys.privateKey, ADDON_KEY, {
      workspaceId: WORKSPACE_ID,
      addonId: ADDON_ID,
      user: "admin-1",
      workspaceRole: "admin",
    });
    await mountShell(server, token);
    const { window } = createTestWindow(token);
    boot({ window, fetchImpl: makeFetchImpl(server, clockify) });
    await waitFor(() => text().includes("Deleted time entries"));

    // Admin-only controls (docs/10 §2): bulk mode, then select both rows.
    const bulkToggle = Array.from(document.querySelectorAll('input[type="checkbox"]')).find((el) =>
      el.closest("label")?.textContent?.includes("Bulk mode"),
    ) as HTMLInputElement | undefined;
    if (!bulkToggle) throw new Error(`no Bulk mode toggle found (screen text: ${text()})`);
    bulkToggle.checked = true;
    bulkToggle.dispatchEvent(new Event("change"));
    await waitFor(() => document.querySelectorAll('li input[type="checkbox"]').length === 2);

    for (const checkbox of Array.from(document.querySelectorAll('li input[type="checkbox"]'))) {
      (checkbox as HTMLInputElement).checked = true;
      checkbox.dispatchEvent(new Event("change"));
    }
    // The button's label/disabled state updates from each checkbox change without a full reflow.
    const reviewButton = findButton("Review selected");
    expect(reviewButton.textContent).toBe("Review selected (2)");
    expect(reviewButton.hasAttribute("disabled")).toBe(false);
    reviewButton.click();
    await waitFor(() => text().includes("Review selected entries"));

    expect(text()).toContain("Ready");
    findButton("Recreate 2 entries").click();
    await waitFor(() => text().includes("Bulk recreation results"));

    expect(text()).toContain("Recreated");
    expect(creates).toBe(2);
  });
});

// Everything above imports `boot()` from source, which proves the UI logic but not the artifact
// the browser actually receives. esbuild is a second compiler with its own target, tree-shaking,
// and module resolution, so a bundle can fail where the source succeeds. This one drives the real
// `dist/static/app.js` the server serves, evaluated as the browser would evaluate it.
describe("the shipped bundle", () => {
  it("boots from dist/static/app.js and renders the list", async () => {
    const bundlePath = join(process.cwd(), "dist", "static", "app.js");
    if (!existsSync(bundlePath)) {
      throw new Error(
        `${bundlePath} is missing. This test asserts the built artifact, so run \`npm run build\` first ` +
          "(CI runs build after test; run both locally).",
      );
    }
    const bundle = readFileSync(bundlePath, "utf8");

    const webhookToken = await signTestToken(keys.privateKey, ADDON_KEY, { workspaceId: WORKSPACE_ID, addonId: ADDON_ID });
    const server = await bootServer();
    await install(server, webhookToken);
    await server.addon.handle(
      createTestWebhookRequest(webhookToken, "TIME_ENTRY_DELETED", deletedEntryBody(), { path: "/webhooks/time-entry-deleted" }),
    );

    const token = await signTestToken(keys.privateKey, ADDON_KEY, {
      workspaceId: WORKSPACE_ID,
      addonId: ADDON_ID,
      user: OWNER_ID,
      workspaceRole: "admin",
    });
    await mountShell(server, token);

    vi.stubGlobal("fetch", makeFetchImpl(server, baseClockifyStub()));
    // The bundle is an IIFE that reads `document`, `window.location`, and `window.parent` — the
    // same globals happy-dom provides here. The shell it was just mounted into carries the
    // `data-parent-origin` attribute and the `#app` root, so this is the production boot path.
    const originalSearch = window.location.search;
    window.history.replaceState({}, "", `/component?auth_token=${token}`);
    try {
      new Function(bundle)();
      await waitFor(() => text().includes("API investigation"));
    } finally {
      window.dispatchEvent(new Event("pagehide"));
      window.history.replaceState({}, "", `/component${originalSearch}`);
    }

    expect(text()).toContain("Deleted time entries");
    expect(text()).toContain("API investigation");
  });
  it("carries the verified theme claim through to the attribute the stylesheet keys off", async () => {
    // src/ui/app.css styles dark via `:root[data-clockify-theme="dark"]`. That selector is only
    // correct if the claim really reaches `documentElement` in that normalized form, and nothing
    // else asserted the chain JWT claim -> shell `data-theme` -> SDK `applyClockifyTheme`.
    // NOTE: `DARK` has never been observed arriving from Clockify — the developer environment
    // exposes no dark-mode setting (evidence "Live run 9"). This pins our half of the contract:
    // whatever Clockify sends, `applyClockifyTheme` lowercases it onto the root.
    const server = await bootServer();
    const webhookToken = await signTestToken(keys.privateKey, ADDON_KEY, { workspaceId: WORKSPACE_ID, addonId: ADDON_ID });
    await install(server, webhookToken);

    const token = await signTestToken(keys.privateKey, ADDON_KEY, {
      workspaceId: WORKSPACE_ID,
      addonId: ADDON_ID,
      user: OWNER_ID,
      workspaceRole: "member",
      theme: "DARK",
      language: "not_a_locale_@",
    });
    await mountShell(server, token);
    expect(document.body.dataset.theme).toBe("DARK");

    vi.stubGlobal("fetch", makeFetchImpl(server, baseClockifyStub()));
    const { window } = createTestWindow(token);
    boot({ window, fetchImpl: makeFetchImpl(server, baseClockifyStub()) });
    await waitFor(() => text().includes("Deleted time entries"));

    expect(document.documentElement.dataset.clockifyTheme).toBe("dark");
    expect(document.documentElement.lang).toBe("en");
  });
});

// The admin filters name people and projects, not ids (docs/10 §2). The value being typed is the
// name stored on the row at deletion time, which is why a project Clockify no longer has is still
// findable — the case an id-resolving filter would silently miss.
describe("admin list filters by name", () => {
  function findFilterInput(labelText: string): HTMLInputElement {
    const label = Array.from(document.querySelectorAll('section[aria-label="Filters"] label')).find(
      (l) => l.textContent?.trim().startsWith(labelText),
    );
    const input = label?.querySelector("input");
    if (!input) throw new Error(`no ${labelText} filter input found (screen text: ${text()})`);
    return input as HTMLInputElement;
  }

  it("filters on a deleted project's stored name, and suggests current names without requiring one", async () => {
    const server = await bootServer();
    const webhookToken = await signTestToken(keys.privateKey, ADDON_KEY, { workspaceId: WORKSPACE_ID, addonId: ADDON_ID });
    await install(server, webhookToken);
    // One entry on a project that has since been deleted, one on a project that still exists.
    await server.addon.handle(
      createTestWebhookRequest(
        webhookToken,
        "TIME_ENTRY_DELETED",
        deletedEntryBody({
          id: "entry-gone",
          description: "legacy work",
          projectId: "proj-gone",
          project: { id: "proj-gone", name: "Legacy API" },
        }),
        { path: "/webhooks/time-entry-deleted" },
      ),
    );
    await server.addon.handle(
      createTestWebhookRequest(
        webhookToken,
        "TIME_ENTRY_DELETED",
        deletedEntryBody({
          id: "entry-live",
          description: "current work",
          projectId: "proj-live",
          project: { id: "proj-live", name: "Billing" },
        }),
        { path: "/webhooks/time-entry-deleted" },
      ),
    );

    // Counted, not just stubbed: each options kind is a `collectPaged` walk, and
    // `renderAdminControls` runs on every list render. Without the per-session cache in
    // `list.ts`, one Apply-filters click would re-walk both.
    let userListCalls = 0;
    let projectListCalls = 0;
    const clockify = (async (input: string | URL | Request, init?: RequestInit) => {
      const path = pathOf(input);
      if (path.endsWith("/users")) userListCalls++;
      if (path.endsWith("/projects")) projectListCalls++;
      // Clockify as it is now: only "Billing" survives, so "Legacy API" cannot come from here.
      if (path.endsWith("/projects")) return jsonResponse([{ id: "proj-live", name: "Billing", archived: false }]);
      if (path.includes("/projects/proj-gone")) return jsonResponse({ message: "Project doesn't belong to Workspace", code: 501 }, 400);
      if (path.includes("/projects/proj-live")) return jsonResponse({ id: "proj-live", name: "Billing", archived: false });
      return baseClockifyStub()(input, init);
    }) as typeof fetch;
    vi.stubGlobal("fetch", makeFetchImpl(server, clockify));

    const token = await signTestToken(keys.privateKey, ADDON_KEY, {
      workspaceId: WORKSPACE_ID,
      addonId: ADDON_ID,
      user: "admin-1",
      workspaceRole: "admin",
    });
    await mountShell(server, token);
    const { window } = createTestWindow(token);
    boot({ window, fetchImpl: makeFetchImpl(server, clockify) });
    await waitFor(() => text().includes("legacy work") && text().includes("current work"));

    // Suggestions arrive after the rows, and never gate them: the list rendered above already.
    // Both datalists are awaited — they are two independent fetches, and waiting on one then
    // reading the other is a race that only shows up on a slower machine.
    await waitFor(
      () =>
        document.querySelectorAll("#rt-user-names option").length > 0 &&
        document.querySelectorAll("#rt-project-names option").length > 0,
    );
    const userOptions = Array.from(document.querySelectorAll("#rt-user-names option")).map((o) => o.getAttribute("value"));
    const projectOptions = Array.from(document.querySelectorAll("#rt-project-names option")).map((o) => o.getAttribute("value"));
    expect(userOptions).toEqual(["Ana Markovic"]);
    // "Legacy API" is deliberately absent — Clockify no longer has it. Free text must still reach it.
    expect(projectOptions).toEqual(["Billing"]);

    expect(findFilterInput("User").getAttribute("list")).toBe("rt-user-names");
    const projectInput = findFilterInput("Project");
    expect(projectInput.getAttribute("list")).toBe("rt-project-names");
    // One options walk per kind so far — the suggestions, not the rows. `/api/entries` reads
    // users itself for the preflight, so `projectListCalls` is the clean signal here.
    const projectListAfterFirstRender = projectListCalls;
    projectInput.value = "legacy";
    findButton("Apply filters").click();

    await waitFor(() => text().includes("legacy work") && !text().includes("current work"));

    // And the filter clears back to both rows, rather than sticking.
    findFilterInput("Project").value = "";
    findButton("Apply filters").click();
    await waitFor(() => text().includes("current work") && text().includes("legacy work"));

    // Two more renders, and not one extra options walk: the cache is keyed per session, so a
    // checkbox click can never turn into a pagination sweep of the workspace.
    expect(projectListCalls).toBe(projectListAfterFirstRender);
    expect(Array.from(document.querySelectorAll("#rt-project-names option"))).toHaveLength(1);
    expect(userListCalls).toBeGreaterThan(0);
  });

  it("sends date-filter bounds for the viewer's local day", async () => {
    const previousTz = process.env.TZ;
    process.env.TZ = "Europe/Belgrade";
    try {
      const server = await bootServer();
      const webhookToken = await signTestToken(keys.privateKey, ADDON_KEY, { workspaceId: WORKSPACE_ID, addonId: ADDON_ID });
      await install(server, webhookToken);
      await server.addon.handle(
        createTestWebhookRequest(webhookToken, "TIME_ENTRY_DELETED", deletedEntryBody(), { path: "/webhooks/time-entry-deleted" }),
      );
      const requests: string[] = [];
      const routed = makeFetchImpl(server, baseClockifyStub());
      const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
        if (typeof input === "string" && input.startsWith("/api/entries")) requests.push(input);
        return routed(input, init);
      }) as typeof fetch;
      vi.stubGlobal("fetch", fetchImpl);

      const token = await signTestToken(keys.privateKey, ADDON_KEY, {
        workspaceId: WORKSPACE_ID,
        addonId: ADDON_ID,
        user: "admin-1",
        workspaceRole: "admin",
      });
      await mountShell(server, token);
      expect(document.querySelector('link[rel="stylesheet"]')).toBeNull();
      const { window } = createTestWindow(token);
      boot({ window, fetchImpl });
      await waitFor(() => text().includes("Deleted time entries"));

      findFilterInput("From").value = "2026-08-08";
      findFilterInput("To").value = "2026-08-08";
      findButton("Apply filters").click();
      await waitFor(() => requests.some((request) => request.includes("from=")));

      const filtered = new URL(requests.findLast((request) => request.includes("from="))!, "http://localhost/");
      expect(filtered.searchParams.get("from")).toBe(new Date("2026-08-08T00:00:00.000").toISOString());
      expect(filtered.searchParams.get("to")).toBe(new Date("2026-08-08T23:59:59.999").toISOString());
    } finally {
      if (previousTz === undefined) delete process.env.TZ;
      else process.env.TZ = previousTz;
    }
  });

  // "Show dismissed" and the status dropdown both select a `lifecycle_state`, so they answer the
  // same question. The UI says so by disabling one while the other is on — a user who can send
  // both is a user who can ask for an empty list without knowing it (docs/10 §2).
  it("the status dropdown and Show dismissed are alternatives, not filters that stack", async () => {
    const server = await bootServer();
    const webhookToken = await signTestToken(keys.privateKey, ADDON_KEY, { workspaceId: WORKSPACE_ID, addonId: ADDON_ID });
    await install(server, webhookToken);
    await server.addon.handle(
      createTestWebhookRequest(webhookToken, "TIME_ENTRY_DELETED", deletedEntryBody(), { path: "/webhooks/time-entry-deleted" }),
    );
    vi.stubGlobal("fetch", makeFetchImpl(server, baseClockifyStub()));

    const token = await signTestToken(keys.privateKey, ADDON_KEY, {
      workspaceId: WORKSPACE_ID,
      addonId: ADDON_ID,
      user: "admin-1",
      workspaceRole: "admin",
    });
    await mountShell(server, token);
    const { window } = createTestWindow(token);
    boot({ window, fetchImpl: makeFetchImpl(server, baseClockifyStub()) });
    await waitFor(() => text().includes("Deleted time entries"));

    // Nullable on purpose: the filter bar is absent during the intermediate "Loading…" render, so
    // a predicate that assumes the element is there fails on timing rather than on behaviour.
    const status = () => document.querySelector("select");
    const dismissedToggle = () =>
      Array.from(document.querySelectorAll('input[type="checkbox"]')).find((el) =>
        el.closest("label")?.textContent?.includes("Show dismissed"),
      ) as HTMLInputElement;

    // Choose a status, then reveal dismissed entries.
    status()!.value = "FAILED";
    findButton("Apply filters").click();
    await waitFor(() => status()?.value === "FAILED");

    dismissedToggle().checked = true;
    dismissedToggle().dispatchEvent(new Event("change"));
    // The chosen status is dropped and the control is disabled, so the pair cannot be sent.
    await waitFor(() => status()?.disabled === true);
    expect(status()!.value).toBe("");

    // Applying again while disabled must not resurrect a stale value from the dropdown.
    findButton("Apply filters").click();
    await waitFor(() => status()?.disabled === true);
    expect(status()!.value).toBe("");

    // Turning the toggle off gives the dropdown back.
    dismissedToggle().checked = false;
    dismissedToggle().dispatchEvent(new Event("change"));
    await waitFor(() => status()?.disabled === false);
  });
});
