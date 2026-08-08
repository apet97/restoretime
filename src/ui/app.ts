// Component shell bootstrap (docs/10, docs/05). Bundled by esbuild into one IIFE
// (implementation/DEPENDENCIES.md — esbuild is the only UI bundler, no framework). Reads the
// verified claims the shell embedded as data attributes (never the token — docs/10 §8), reads the
// token itself from `?auth_token`, wires the SDK bridge, and renders the first view.

import { applyClockifyLanguage, applyClockifyTheme, type ClockifyBrowserWindow } from "@apet97/clockify-addon-sdk/ui";
import { createApiClient } from "./api.js";
import { setupBridge } from "./bridge.js";
import { el, mount } from "./dom.js";
import type { Ctx, ViewState } from "./state.js";
import { renderList } from "./views/list.js";
import { renderDetail } from "./views/detail.js";
import { renderConfirm } from "./views/confirm.js";
import { renderResult } from "./views/result.js";
import { renderBulkReview, renderBulkResults } from "./views/bulk.js";
import { renderSessionExpired } from "./views/shared.js";

/** Same predicate as the SDK's `isClockifyAdminRole` (owner/admin, case-insensitive) — reimplemented
 * locally rather than importing `@apet97/clockify-addon-sdk/clockify` into the browser bundle,
 * which pulls in JWT/node-oriented modules this cosmetic check does not need. This never gates a
 * server decision (bulk endpoints re-check `isAdmin` from verified claims — docs/09); it only
 * decides whether to render the admin-only list controls. */
function isAdminRole(role: string): boolean {
  const normalized = role.trim().toLowerCase();
  return normalized === "owner" || normalized === "admin";
}

function readAuthToken(location: { readonly search: string }): string | undefined {
  const token = new URLSearchParams(location.search).get("auth_token");
  return token && token.length > 0 ? token : undefined;
}

function dispatch(ctx: Ctx, state: ViewState): void {
  switch (state.kind) {
    case "list":
      renderList(ctx);
      return;
    case "detail":
      renderDetail(ctx, state.entryId, state.forceResolve ?? false);
      return;
    case "confirm":
      renderConfirm(ctx, state.entryId, state.plan);
      return;
    case "result":
      renderResult(ctx, state.entryId, state.plan, state.result);
      return;
    case "bulk-review":
      renderBulkReview(ctx, state.rows);
      return;
    case "bulk-results":
      renderBulkResults(ctx, state.rows);
      return;
    case "session-expired":
      renderSessionExpired(ctx.root);
      return;
  }
}

export interface BootOptions {
  readonly window: ClockifyBrowserWindow & {
    readonly document: Document;
    readonly location: { readonly search: string };
  };
  readonly fetchImpl?: typeof fetch;
}

/** The real entry point, exported so `tests/e2e/` can boot the shell against an injected window and
 * a stubbed `fetch` (docs/13 §E2E) instead of re-implementing the bundle. */
export function boot(options: BootOptions): void {
  const { window } = options;
  const body = window.document.body;
  const root = window.document.getElementById("app");
  const parentOrigin = body.dataset.parentOrigin;
  const token = readAuthToken(window.location);

  if (!root) return; // the shell markup always has #app; nothing to mount into otherwise.
  if (!parentOrigin || !token) {
    mount(root, el("p", {}, "RestoreTime could not verify its parent frame."));
    return;
  }

  // `DOMStringMap`'s index signature is `string | undefined`, which `exactOptionalPropertyTypes`
  // treats as incompatible with the SDK's `Record<string, string>` — casting only changes the
  // static type; `dataset` stays the same live object, so the SDK's write still lands on the
  // real element.
  const docRoot = window.document.documentElement as unknown as { dataset: Record<string, string>; lang: string };
  applyClockifyTheme(body.dataset.theme, docRoot);
  applyClockifyLanguage(body.dataset.language, docRoot);

  const { bridge, auth } = setupBridge(window, parentOrigin, token);
  const api = createApiClient(auth, options.fetchImpl ?? fetch);
  const locale = (body.dataset.language ?? "en").replaceAll("_", "-");

  const ctx: Ctx = {
    root,
    api,
    bridge,
    locale,
    isAdminRole: isAdminRole(body.dataset.role ?? ""),
    navigate: (state) => dispatch(ctx, state),
  };

  ctx.navigate({ kind: "list" });
}

function main(): void {
  boot({ window: window as unknown as BootOptions["window"] });
}

main();
