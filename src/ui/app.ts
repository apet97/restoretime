// Component shell bootstrap (docs/10, docs/05). Bundled by esbuild into one IIFE
// (implementation/DEPENDENCIES.md — esbuild is the only UI bundler, no framework). Reads the
// verified claims the shell embedded as data attributes (never the token — docs/10 §8), reads the
// token itself from `?auth_token`, wires the SDK bridge, and renders the first view.

import {
  applyClockifyLanguage,
  applyClockifyTheme,
  isClockifyAdminRole,
  type ClockifyBrowserWindow,
} from "@apet97/clockify-addon-sdk/ui";
import { createApiClient } from "./api.js";
import { setupBridge, type TokenAuthorityHandle } from "./bridge.js";
import { el, mount } from "./dom.js";
import { normalizeLocale } from "./format.js";
import { createUiSessionState, type Ctx, type ViewState } from "./state.js";
import { renderList } from "./views/list.js";
import { renderDetail } from "./views/detail.js";
import { renderConfirm } from "./views/confirm.js";
import { renderResult } from "./views/result.js";
import { renderBulkReview, renderBulkResults } from "./views/bulk.js";
import { renderSessionExpired } from "./views/shared.js";

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
      renderDetail(ctx, state.entryId, state.forceResolve ?? false, state.draft, state.returnTo);
      return;
    case "confirm":
      renderConfirm(ctx, state.entryId, state.plan, state.source, state.disabled ?? false, state.draft, state.returnTo);
      return;
    case "result":
      renderResult(ctx, state.entryId, state.plan, state.result, undefined, state.returnTo);
      return;
    case "bulk-review":
      renderBulkReview(ctx, state.rows, state.refresh ?? false);
      return;
    case "bulk-results":
      renderBulkResults(ctx, state.rows, state.reviewRows);
      return;
    case "session-expired":
      renderSessionExpired(ctx);
      return;
  }
}

export interface BootOptions {
  readonly window: ClockifyBrowserWindow & {
    readonly document: Document;
    readonly location: { readonly search: string; reload?(): void };
  };
  readonly fetchImpl?: typeof fetch;
}

/** The real entry point, exported so `tests/e2e/` can boot the shell against an injected window and
 * a stubbed `fetch` (docs/13 §E2E) instead of re-implementing the bundle. */
export function boot(options: BootOptions): TokenAuthorityHandle | undefined {
  const { window } = options;
  const body = window.document.body;
  const root = window.document.getElementById("app");
  const parentOrigin = body.dataset.parentOrigin;
  const token = readAuthToken(window.location);

  if (!root) return undefined; // the shell markup always has #app; nothing to mount into otherwise.
  if (!parentOrigin || !token) {
    mount(root, el("p", {}, "RestoreTime could not verify its parent frame."));
    return undefined;
  }

  const docRoot = window.document.documentElement;
  const locale = normalizeLocale(body.dataset.language);
  applyClockifyTheme(body.dataset.theme, docRoot);
  applyClockifyLanguage(locale, docRoot);

  const { bridge, auth } = setupBridge(window, parentOrigin, token);
  const api = createApiClient(auth, options.fetchImpl ?? fetch);

  let navigationVersion = 0;
  const announcer = window.document.getElementById("rt-announcer");
  const ctx: Ctx = {
    root,
    api,
    bridge,
    locale,
    isAdminRole: isClockifyAdminRole(body.dataset.role ?? ""),
    session: createUiSessionState(),
    getNavigationVersion: () => navigationVersion,
    navigate: (state) => {
      navigationVersion += 1;
      dispatch(ctx, state);
    },
    announce: (message) => {
      if (announcer) announcer.textContent = message;
    },
    reload: () => window.location.reload?.(),
  };

  ctx.navigate({ kind: "list" });
  return auth;
}

function main(): void {
  const auth = boot({ window: window as unknown as BootOptions["window"] });
  if (auth) window.addEventListener("pagehide", () => auth.dispose(), { once: true });
}

main();
