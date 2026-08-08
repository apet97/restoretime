// RestoreTime install-capture server (dev tool, not the product).
//
// Purpose: serve the FINAL addon manifest over a public tunnel so the operator can install the
// addon once, verify lifecycle + webhook deliveries with the real addon platform, and record the
// installation (encrypted on disk) for evidence probes. PASS-01 builds the real server; this
// tool then becomes obsolete.
//
// Env: PUBLIC_BASE_URL (required, tunnel URL) · PORT (default 8791)
//      CLOCKIFY_PARENT_ORIGIN (default https://app.clockify.me) · VAR_DIR (default ./var)

import { appendFileSync } from "node:fs";
import { join } from "node:path";
import {
  ClockifyManifest,
  ClockifyComponent,
  ClockifyWebhook,
  ClockifyLifecycleEvent,
  ClockifyScope,
  createValidatedClockifyAddon,
  createClockifySignatureParser,
  withClockifyInstalledLifecycleRequest,
  withClockifyStatusChangedLifecycleRequest,
  withClockifyDeletedLifecycleRequest,
  withClockifyVerifiedWebhookRequest,
  withClockifyVerifiedComponentRequest,
  createClockifyHtmlResponse,
} from "@apet97/clockify-addon-sdk/clockify";
import { createNodeHttpAddonServer } from "@apet97/clockify-addon-sdk/adapters/node";
import { installations, VAR_DIR } from "./store.mjs";

export const ADDON_KEY = "restoretime";
export const WEBHOOK_PATH = "/webhooks/time-entry-deleted";
export const COMPONENT_PATH = "/component";
export const ICON_PATH = "/icon.svg";
export const LIFECYCLE_PATHS = {
  installed: "/lifecycle/installed",
  statusChanged: "/lifecycle/status-changed",
  deleted: "/lifecycle/deleted",
};

const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL;
if (!PUBLIC_BASE_URL) {
  console.error("PUBLIC_BASE_URL is required (the tunnel URL, e.g. https://x.trycloudflare.com)");
  process.exit(1);
}
const PORT = Number(process.env.PORT ?? 8791);
const PARENT_ORIGIN = process.env.CLOCKIFY_PARENT_ORIGIN ?? "https://app.clockify.me";

// 24x24 sidebar icon: circular arrow (recreation) on dark tile.
const ADDON_ICON_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">' +
  '<rect width="24" height="24" rx="5" fill="#0e1116"/>' +
  '<path d="M12 5a7 7 0 1 1-6.32 4" fill="none" stroke="#3fce8b" stroke-width="2" stroke-linecap="round"/>' +
  '<path d="M5 4v5h5" fill="none" stroke="#3fce8b" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>' +
  '<path d="M12 8.5V12l2.5 1.5" fill="none" stroke="#f7f9fc" stroke-width="2" stroke-linecap="round"/></svg>';

// Live finding (2026-08-08, developer environment): the INSTALLED payload can carry the webhook
// path as "//webhooks/time-entry-deleted" (Clockify joins baseUrl + "/" + path). Normalize both
// sides before comparing — collapse repeated slashes and reduce absolute URLs to their pathname.
export function normalizeWebhookPath(path) {
  let pathname = String(path ?? "");
  try {
    pathname = new URL(pathname).pathname;
  } catch {
    // already a relative path
  }
  return `/${pathname.replace(/^\/+/, "")}`.replace(/\/{2,}/g, "/");
}

// --- Encrypted JSON-file installation store (ClockifyInstallationStore contract) -------------
// Implementation shared with the probe script: store.mjs (exports `installations`, `VAR_DIR`).

// --- Manifest (FINAL shape — changes require a marketplace reinstall, so it is frozen here) ---

const manifest = ClockifyManifest.v1_5Builder()
  .key(ADDON_KEY)
  .name("RestoreTime — Time Entry Recovery")
  .baseUrl(PUBLIC_BASE_URL)
  .requireFreePlan()
  .description(
    "Recovers deleted time entries. Keeps a copy when you delete a time entry and recreates it as a new entry on your confirmation.",
  )
  .iconPath(ICON_PATH)
  .scopes([
    ClockifyScope.TIME_ENTRY_READ,
    ClockifyScope.TIME_ENTRY_WRITE,
    ClockifyScope.PROJECT_READ,
    ClockifyScope.TASK_READ,
    ClockifyScope.TAG_READ,
    ClockifyScope.USER_READ,
    ClockifyScope.CUSTOM_FIELDS_READ,
    ClockifyScope.WORKSPACE_READ,
  ])
  .build();

const parser = createClockifySignatureParser(ADDON_KEY);

const addon = createValidatedClockifyAddon(manifest, undefined, {
  onError(error, context) {
    console.error(JSON.stringify({ level: "error", msg: "addon error", source: context?.source, error: String(error) }));
  },
});

// Lifecycle: INSTALLED persists the encrypted context incl. per-webhook tokens.
addon.registerLifecycleEvent(
  ClockifyLifecycleEvent.v1_5Builder().path(LIFECYCLE_PATHS.installed).onInstalled().build(),
  withClockifyInstalledLifecycleRequest(parser, async (_request, payload, claims) => {
    await installations.save({ ...payload, installedAt: Date.now() });
    console.log(
      JSON.stringify({
        level: "info",
        msg: "INSTALLATION_CAPTURED",
        workspaceId: claims.workspaceId,
        addonId: claims.addonId,
        webhooks: (payload.webhooks ?? []).map((w) => w.path),
      }),
    );
    return { status: 204 };
  }),
);

addon.registerLifecycleEvent(
  ClockifyLifecycleEvent.v1_5Builder().path(LIFECYCLE_PATHS.statusChanged).onStatusChanged().build(),
  withClockifyStatusChangedLifecycleRequest(parser, async (_request, payload, claims) => {
    // The context contract has no status field; the capture tool logs the change only.
    console.log(JSON.stringify({ level: "info", msg: "STATUS_CHANGED", workspaceId: claims.workspaceId, status: payload.status }));
    return { status: 204 };
  }),
);

addon.registerLifecycleEvent(
  ClockifyLifecycleEvent.v1_5Builder().path(LIFECYCLE_PATHS.deleted).onDeleted().build(),
  withClockifyDeletedLifecycleRequest(parser, async (_request, _payload, claims) => {
    // The DELETED payload carries no generation: unconditional delete (SDK recipe).
    const result = await installations.delete({ workspaceId: claims.workspaceId, addonId: claims.addonId });
    console.log(JSON.stringify({ level: "info", msg: "INSTALLATION_DELETED", workspaceId: claims.workspaceId, result }));
    return { status: 204 };
  }),
);

// Webhook: verify (JWT + per-installation token), capture raw delivery to gitignored file, 204.
addon.registerWebhook(
  ClockifyWebhook.v1_5Builder().onTimeEntryDeleted().path(WEBHOOK_PATH).build(),
  withClockifyVerifiedWebhookRequest(
    parser,
    {
      expectedEventType: "TIME_ENTRY_DELETED",
      async getExpectedWebhookAuthToken({ workspaceId, addonId }) {
        const context = await installations.load(workspaceId, addonId);
        return context?.webhooks?.find(
          (w) => normalizeWebhookPath(w.path) === WEBHOOK_PATH,
        )?.authToken;
      },
    },
    async (request, claims) => {
      appendFileSync(
        join(VAR_DIR, "webhooks.jsonl"),
        JSON.stringify({
          receivedAt: new Date().toISOString(),
          claimsWorkspaceId: claims.workspaceId,
          claimsAddonId: claims.addonId,
          body: request.body,
        }) + "\n",
      );
      console.log(JSON.stringify({ level: "info", msg: "WEBHOOK_CAPTURED", workspaceId: claims.workspaceId, entryId: request.body?.id }));
      return { status: 204 };
    },
  ),
);

// Component: verified shell. The real UI is PASS-03; this proves the component boundary live.
addon.registerComponent(
  ClockifyComponent.v1_5Builder()
    .sidebar()
    .allowEveryone()
    .path(COMPONENT_PATH)
    .label("Time Entry Recovery")
    .iconPath(ICON_PATH)
    .build(),
  withClockifyVerifiedComponentRequest(parser, async (_request, claims) =>
    createClockifyHtmlResponse(
      "<!doctype html><html><head><meta charset=\"utf-8\"><title>Time Entry Recovery</title></head>" +
        "<body><main><h1>RestoreTime</h1><p>RestoreTime is installed. Deleted time entries will appear here.</p></main></body></html>",
      { frameAncestors: [PARENT_ORIGIN] },
    ),
  ),
);

// Static utility routes (exact paths — the SDK router does no path parameters).
addon.registerHandler(ICON_PATH, "GET", async () => ({
  status: 200,
  headers: { "content-type": "image/svg+xml", "cache-control": "public, max-age=86400" },
  body: ADDON_ICON_SVG,
}));
addon.registerHandler("/healthz", "GET", async () => ({ status: 200, body: { status: "ok" } }));

createNodeHttpAddonServer(addon, {
  onError(error, context) {
    console.error(JSON.stringify({ level: "error", msg: "http error", source: context?.source, error: String(error) }));
  },
}).listen(PORT, () => {
  console.log(JSON.stringify({ level: "info", msg: "listening", port: PORT, baseUrl: PUBLIC_BASE_URL }));
});
