// @vitest-environment happy-dom
//
// UT-X01 extension (docs/12 "XSS via stored Clockify values", docs/13). `src/ui/dom.ts`'s `el()`
// is structurally safe (every string child becomes a `Text` node via `document.createTextNode`,
// never parsed as markup — there is no `innerHTML` anywhere in `src/ui/`), so this file exists to
// prove that guarantee empirically, end to end, against real `boot()` source path (the built bundle is booted by component-flow.test.ts)-boot code path: fixture
// entries carrying entity-encoded and markup-looking strings in the description, project name,
// task name, tag names, owner name, and a custom-field value, driven through every rendered view
// (list, detail, the resolution widgets, confirm, and the success/result view). The assertion is
// not "the text is escaped" (a string check would pass even if the payload were never rendered at
// all) — it is that no `<img>`/`<svg>`/`<script>` element exists anywhere in the mounted tree, and
// that the raw payload appears verbatim as `textContent`.
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
import type { ClockifyBrowserWindow } from "@apet97/clockify-addon-sdk/ui";
import { createServer, type AppServer } from "../../src/server.js";
import type { AppConfig } from "../../src/config.js";
import { boot } from "../../src/ui/app.js";
import { renderBulkReview, renderBulkResults } from "../../src/ui/views/bulk.js";
import { renderResult } from "../../src/ui/views/result.js";
import type { Ctx } from "../../src/ui/state.js";
import type { BulkPreflightRow, BulkRecreateRow, RecreationPlan } from "../../src/ui/types.js";

const ADDON_KEY = "restoretime-xss";
const WORKSPACE_ID = "ws-1";
const ADDON_ID = "addon-1";
const OWNER_ID = "user-1";
const PARENT_ORIGIN = "https://app.clockify.me";

// Markup-looking and entity-encoded payloads, one per attacker-controllable field. Each is
// distinctive enough to search for as a whole string.
const XSS_DESCRIPTION = '<img src=x onerror="window.__xss_description=1">';
const XSS_PROJECT_NAME = "<svg onload=alert('proj')>Legacy API";
const XSS_TASK_NAME = "</td><script>alert('task')</script>";
const XSS_TAG_NAME = '"><iframe src=javascript:alert(1)>';
const XSS_OWNER_NAME = "&lt;b&gt;Ana&lt;/b&gt; <img src=x onerror=alert('owner')>";
const XSS_REPLACEMENT_PROJECT_NAME = '<svg onload=alert("replacement")>Customer API';
const XSS_CF_VALUE = '<img src=x onerror="window.__xss_cf=1">';
const XSS_CF_VALUE_ACTUAL = '<svg onload="window.__xss_cf_actual=1">';

let dir: string;
let keys: ClockifyTestKeys;

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
  dir = mkdtempSync(join(tmpdir(), "restoretime-xss-"));
  keys = await generateTestKeys();
  document.body.innerHTML = "";
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  vi.unstubAllGlobals();
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

function hostileDeletedEntryBody(overrides: Record<string, unknown> = {}) {
  return {
    id: "entry-a",
    workspaceId: WORKSPACE_ID,
    userId: OWNER_ID,
    description: XSS_DESCRIPTION,
    billable: true,
    projectId: "gone-project",
    type: "REGULAR",
    currentlyRunning: false,
    timeInterval: { start: "2026-08-07T09:00:00Z", end: "2026-08-07T11:30:00Z", timeZone: "UTC" },
    project: { id: "gone-project", name: XSS_PROJECT_NAME, clientName: null },
    task: { id: "task-1", name: XSS_TASK_NAME },
    tags: [{ id: "tag-1", name: XSS_TAG_NAME }],
    user: { name: XSS_OWNER_NAME },
    customFieldValues: [{ customFieldId: "cf-1", name: "Ticket", value: XSS_CF_VALUE }],
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

function makeFetchImpl(server: AppServer, clockify: typeof fetch): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
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
  }) as typeof fetch;
}

function createTestWindow(authToken: string): {
  window: ClockifyBrowserWindow & { document: Document; location: { search: string } };
} {
  const listeners = new Set<(event: { origin: string; source: unknown; data: unknown }) => void>();
  const parent = { postMessage: () => undefined };
  const win = {
    document,
    location: { search: `?auth_token=${authToken}` },
    parent,
    addEventListener: (name: "message", listener: (event: { origin: string; source: unknown; data: unknown }) => void) => {
      if (name === "message") listeners.add(listener);
    },
    removeEventListener: () => undefined,
  };
  return { window: win };
}

async function mountShell(server: AppServer, token: string): Promise<void> {
  const response = await server.addon.handle(createTestComponentRequest(token, { path: "/component" }));
  expect(response.status).toBe(200);
  const html = String(response.body);
  const inner = /<html>([\s\S]*)<\/html>/.exec(html)?.[1] ?? "";
  document.documentElement.innerHTML = inner.replace(/<script[^>]*><\/script>/, "");
}

function appRoot(): HTMLElement {
  const root = document.getElementById("app");
  if (!root) throw new Error("no #app root mounted");
  return root;
}

function text(): string {
  return appRoot().textContent ?? "";
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

async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error(`waitFor timed out. Screen text: ${JSON.stringify(text())}`);
    await tick();
  }
}

/** The strong assertion (pass file wording: "no element was created from it"): none of the tag
 * names a successful injection would have produced exist anywhere in the whole document, not just
 * inside `#app` — a payload that broke out of its container would still be caught here. */
function assertNoInjectedElements(): void {
  for (const selector of ["img", "svg", "script", "iframe"]) {
    // The app never legitimately renders any of these tags, so a zero count is unconditional, not
    // fixture-dependent — a real injection would create exactly the element its markup names.
    expect(document.querySelectorAll(selector)).toHaveLength(0);
  }
}

describe("XSS proof: hostile fixture through every rendered view", () => {
  it("list -> detail -> resolution widget -> confirm -> success never creates an element from Clockify-controlled text", async () => {
    const server = await bootServer();
    const webhookToken = await signTestToken(keys.privateKey, ADDON_KEY, { workspaceId: WORKSPACE_ID, addonId: ADDON_ID });
    await install(server, webhookToken);
    await server.addon.handle(
      createTestWebhookRequest(webhookToken, "TIME_ENTRY_DELETED", hostileDeletedEntryBody(), { path: "/webhooks/time-entry-deleted" }),
    );

    const clockify: typeof fetch = (async (input, init) => {
      const path = pathOf(input);
      const method = methodOf(input, init);
      if (method === "GET" && /\/workspaces\/[^/]+$/.test(path)) return jsonResponse({ id: WORKSPACE_ID, workspaceSettings: {} });
      if (method === "GET" && path.endsWith("/users")) return jsonResponse([{ id: OWNER_ID, email: "a@b.com", name: XSS_OWNER_NAME, status: "ACTIVE" }]);
      if (method === "GET" && path.endsWith("/tags")) return jsonResponse([]);
      if (method === "GET" && path.endsWith("/custom-fields")) {
        // Kept active (not P-CF-GONE) so the hostile value is actually planned and sent, and can be
        // asserted on the success view's verification-diff line below.
        return jsonResponse([{ id: "cf-1", name: "Ticket", status: "VISIBLE", type: "TXT", required: false, workspaceDefaultValue: "unrelated-default" }]);
      }
      if (method === "GET" && path.endsWith("/tasks")) return jsonResponse([]);
      if (method === "GET" && path.endsWith("/projects/gone-project")) return jsonResponse({ message: "Project doesn't belong to Workspace", code: 501 }, 400);
      if (method === "GET" && path.endsWith("/projects/proj-2")) return jsonResponse({ id: "proj-2", name: XSS_REPLACEMENT_PROJECT_NAME, archived: false });
      if (method === "GET" && path.endsWith("/projects")) return jsonResponse([{ id: "proj-2", name: XSS_REPLACEMENT_PROJECT_NAME, archived: false }]);
      if (method === "GET" && path.endsWith("/time-entries") && path.includes("/user/")) return jsonResponse([]); // baseline: empty
      if (method === "POST" && path.endsWith("/time-entries")) {
        return jsonResponse(
          {
            id: "new-entry-1",
            workspaceId: WORKSPACE_ID,
            userId: OWNER_ID,
            description: XSS_DESCRIPTION,
            billable: true,
            projectId: "proj-2",
            tagIds: [],
            type: "REGULAR",
            timeInterval: { start: "2026-08-07T09:00:00Z", end: "2026-08-07T11:30:00Z" },
            customFieldValues: [{ customFieldId: "cf-1", value: XSS_CF_VALUE }],
          },
          201,
        );
      }
      if (method === "GET" && path.includes("/time-entries/new-entry-1")) {
        // Deliberately different from the planned value (`XSS_CF_VALUE_ACTUAL`, not
        // `XSS_CF_VALUE`) so `diffPlannedVsActual` records a mismatch line and the success view
        // actually renders it — proving the "Clockify applied these changes" list is safe too.
        return jsonResponse({
          id: "new-entry-1",
          workspaceId: WORKSPACE_ID,
          userId: OWNER_ID,
          description: XSS_DESCRIPTION,
          billable: true,
          projectId: "proj-2",
          tagIds: [],
          type: "REGULAR",
          timeInterval: { start: "2026-08-07T09:00:00Z", end: "2026-08-07T11:30:00Z" },
          customFieldValues: [{ customFieldId: "cf-1", value: XSS_CF_VALUE_ACTUAL }],
        });
      }
      return jsonResponse({ message: "unstubbed", code: 0 }, 404);
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

    // --- List view (src/ui/views/list.ts): description + project/task line + tag names.
    assertNoInjectedElements();
    expect(text()).toContain(XSS_DESCRIPTION);
    expect(text()).toContain(XSS_PROJECT_NAME);
    expect(text()).toContain(XSS_TASK_NAME);
    expect(text()).toContain(XSS_TAG_NAME);

    findButton("Recreate").click();
    await waitFor(() => text().includes("Deleted time entry"));

    // --- Detail view (src/ui/views/detail.ts): the facts table (description, project, tags kept
    // as-is before any resolution; owner name).
    assertNoInjectedElements();
    expect(text()).toContain(XSS_DESCRIPTION);
    expect(text()).toContain(XSS_PROJECT_NAME);
    expect(text()).toContain(XSS_TAG_NAME);
    expect(text()).toContain(XSS_OWNER_NAME);

    // --- Resolution widget (src/ui/views/resolution-widgets.ts): the P-PROJ-GONE picker's
    // <option> text comes straight from `/api/options?kind=projects` — a hostile project name here
    // is exactly the "markup-looking value in a picker" case UT-X01 calls out.
    await waitFor(() => findSelect().options.length > 2);
    assertNoInjectedElements();
    expect(text()).toContain(XSS_REPLACEMENT_PROJECT_NAME);
    const select = findSelect();
    select.value = "proj-2";
    select.dispatchEvent(new Event("change"));
    await waitFor(() => !text().includes("Project no longer exists") && text().includes("Continue to confirm"));

    // The fixture's tag is also gone from the current workspace (P-TAG-GONE): confirm its removal
    // so the plan clears its own separate ACTION_REQUIRED item — a second, independent view of the
    // same hostile tag name (docs/10 §4's per-tag checkbox).
    assertNoInjectedElements();
    expect(text()).toContain(XSS_TAG_NAME);
    const tagCheckbox = document.querySelector('fieldset input[type="checkbox"]') as HTMLInputElement | null;
    if (tagCheckbox) {
      tagCheckbox.checked = true;
      tagCheckbox.dispatchEvent(new Event("change"));
    }
    await waitFor(() => {
      const buttons = Array.from(document.querySelectorAll("button"));
      const btn = buttons.find((b) => b.textContent?.trim().startsWith("Continue to confirm"));
      return btn !== undefined && !btn.hasAttribute("disabled");
    });

    const continueButton = findButton("Continue to confirm");
    expect(continueButton.hasAttribute("disabled")).toBe(false);
    continueButton.click();
    await waitFor(() => text().includes("Confirm recreation"));

    // --- Confirm view (src/ui/views/confirm.ts + shared.ts renderDifferences): owner name and any
    // kept tag names appear verbatim.
    assertNoInjectedElements();
    expect(text()).toContain(XSS_OWNER_NAME);

    findButton("Recreate entry").click();
    await waitFor(() => text().includes("Time entry recreated.") || text().includes("did not create"));

    // --- Result/success view (src/ui/views/result.ts): the verification-diff list renders the
    // actual custom-field value Clockify returned, via a template-string child — still one text
    // node, never parsed.
    assertNoInjectedElements();
    expect(text()).toContain("Time entry recreated.");
    // result.ts renders this line via `JSON.stringify(d.actual)` inside one template-string text
    // node, so the payload's quotes come through JSON-escaped (`\"`) rather than byte-identical —
    // still just text, never markup. `assertNoInjectedElements()` above is the proof that matters;
    // this checks the payload actually reached the screen rather than being silently dropped.
    expect(text()).toContain(JSON.stringify(XSS_CF_VALUE_ACTUAL));
  });
});

// --- Direct-render coverage for the two views the flow above cannot reach in one pass: bulk.ts
// (admin-only, a separate navigation branch) and result.ts's FAILED/AMBIGUOUS outcomes (the
// RECREATED branch is already covered above). Same pattern PASS-03's tests/e2e/views.test.ts uses:
// render against a stub `Ctx` instead of driving the whole app, since the defect class under test
// (an element created from Clockify-controlled text) lives entirely in what the view puts on
// screen.

const XSS_MESSAGE = '<img src=x onerror="window.__xss_bulk=1">';
const XSS_CANDIDATE_ID = '"><svg onload=alert(1)>cand-1';

function stubCtx(): Ctx {
  const root = document.createElement("main");
  document.body.appendChild(root);
  return {
    root,
    api: { get: vi.fn(), post: vi.fn() } as unknown as Ctx["api"],
    bridge: { subscribe: vi.fn(), refreshAddonToken: vi.fn(), navigate: vi.fn(), showToast: vi.fn() } as unknown as Ctx["bridge"],
    locale: "en-GB",
    isAdminRole: true,
    navigate: vi.fn(),
  };
}

describe("XSS proof: bulk views and the FAILED/AMBIGUOUS result views (direct render)", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it("renderBulkReview never creates an element from a hostile plan blocker/action-required message", () => {
    const ctx = stubCtx();
    const rows: BulkPreflightRow[] = [
      { entryId: "e-1", status: "error", message: XSS_MESSAGE },
      { entryId: "e-2", status: "blocked", plan: { blockers: [{ ruleId: "P-TYPE", message: XSS_MESSAGE }] } as unknown as RecreationPlan },
    ];
    renderBulkReview(ctx, rows);
    assertNoInjectedElements();
    expect(ctx.root.textContent ?? "").toContain(XSS_MESSAGE);
  });

  it("renderBulkResults never creates an element from a hostile FAILED/ERROR message", () => {
    const ctx = stubCtx();
    const rows: BulkRecreateRow[] = [
      { entryId: "e-1", planId: "p-1", outcome: "FAILED", status: 400, code: "501", message: XSS_MESSAGE },
      { entryId: null, planId: "p-2", outcome: "ERROR", message: XSS_MESSAGE },
    ];
    renderBulkResults(ctx, rows);
    assertNoInjectedElements();
    expect(ctx.root.textContent ?? "").toContain(XSS_MESSAGE);
  });

  it("renderResult FAILED never creates an element from a hostile reason string", () => {
    const ctx = stubCtx();
    const plan = { fidelity: "FULL", warnings: [], blockers: [], actionRequired: [] } as unknown as RecreationPlan;
    renderResult(ctx, "re-1", plan, { outcome: "FAILED", status: 400, code: "501", message: XSS_MESSAGE });
    assertNoInjectedElements();
    expect(ctx.root.textContent ?? "").toContain(XSS_MESSAGE);
  });

  it("renderResult AMBIGUOUS candidate list never creates an element from a hostile candidate id", async () => {
    const ctx = stubCtx();
    (ctx.api.get as ReturnType<typeof vi.fn>).mockResolvedValue({
      entry: { id: "re-1", lifecycleState: "AMBIGUOUS" },
      plan: { fidelity: "FULL", warnings: [], blockers: [], actionRequired: [] },
      attempts: [
        {
          outcome: null,
          finishedAt: null,
          reconcile: { checkedAt: new Date().toISOString(), checks: 1, candidateIds: [XSS_CANDIDATE_ID, "cand-2"] },
        },
      ],
      lineage: { parent: null, child: null },
      disabled: false,
      canMarkNotCreated: false,
    });
    const plan = { fidelity: "FULL", warnings: [], blockers: [], actionRequired: [] } as unknown as RecreationPlan;
    renderResult(ctx, "re-1", plan, { outcome: "AMBIGUOUS", baseline: [] });
    await waitFor(() => (ctx.root.textContent ?? "").includes(XSS_CANDIDATE_ID));
    assertNoInjectedElements();
  });
});
