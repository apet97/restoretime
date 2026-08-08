// Composition root (docs/05). Wires config, db, installation store, manifest, and every platform
// boundary. No recovery behavior lives here — that starts in PASS-02.

import { readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL, URL as NodeURL } from "node:url";
import type Database from "better-sqlite3";
import {
  buildClockifySecurityHeaders,
  createClockifyAesGcmTokenCodec,
  createClockifySignatureParser,
  createClockifyHtmlResponse,
  createValidatedClockifyAddon,
  wrapClockifyInstallationStoreWithEncryption,
  withClockifyDeletedLifecycleRequest,
  withClockifyInstalledLifecycleRequest,
  withClockifyStatusChangedLifecycleRequest,
  withClockifyVerifiedComponentRequest,
  withClockifyVerifiedWebhookRequest,
  type ClockifyAddon,
  type ClockifyInstallationStore,
  type ClockifyPublicKeyInput,
} from "@apet97/clockify-addon-sdk/clockify";
import { createNodeHttpAddonServer } from "@apet97/clockify-addon-sdk/adapters/node";
import { loadConfig, type AppConfig } from "./config.js";
import { createLogger, type Logger } from "./log.js";
import { openDatabase } from "./store/db.js";
import { uninstallWorkspace } from "./store/cascade.js";
import {
  createSqliteInstallationStore,
  importTokenEncryptionKey,
  normalizeWebhookPath,
  updateInstallationStatus,
} from "./platform/installations.js";
import { handleDeletedEntryWebhook } from "./ingest/webhook.js";
import { registerApiRoutes } from "./api/routes.js";
import { componentShellHtml } from "./api/views.js";
import {
  buildManifest,
  componentDescriptor,
  ICON_PATH,
  lifecycleDescriptors,
  STATIC_APP_JS_PATH,
  WEBHOOK_PATH,
  webhookDescriptor,
} from "./manifest.js";

// 24x24 sidebar icon: circular arrow (recreation) on dark tile.
const ADDON_ICON_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">' +
  '<rect width="24" height="24" rx="5" fill="#0e1116"/>' +
  '<path d="M12 5a7 7 0 1 1-6.32 4" fill="none" stroke="#3fce8b" stroke-width="2" stroke-linecap="round"/>' +
  '<path d="M5 4v5h5" fill="none" stroke="#3fce8b" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>' +
  '<path d="M12 8.5V12l2.5 1.5" fill="none" stroke="#f7f9fc" stroke-width="2" stroke-linecap="round"/></svg>';

/** Reads the esbuild-bundled shell script relative to the running module (dist/static/app.js in
 * production). Read per-request, not cached at createServer() time: this function is also invoked
 * by tests that build the server straight from src/ (no dist/), which never hit this route. */
function loadAppBundle(): string | undefined {
  // `NodeURL`, not the ambient global — see the comment on the equivalent line in store/db.ts.
  const bundlePath = fileURLToPath(new NodeURL("./static/app.js", import.meta.url));
  try {
    return readFileSync(bundlePath, "utf8");
  } catch {
    return undefined;
  }
}

export interface AppServer {
  readonly addon: ClockifyAddon<ReturnType<typeof buildManifest>>;
  readonly config: AppConfig;
  readonly logger: Logger;
  readonly db: Database.Database;
  /** The encrypted-at-rest installation store (exposed for tests and future modules —
   * server.ts is the one place both the raw store and the codec are wired together). */
  readonly installations: ClockifyInstallationStore;
}

export interface CreateServerOptions {
  /** Test-only: verifies against a non-platform key (e.g. SDK testing/generateTestKeys()).
   * Omitted in production — the parser then uses Clockify's pinned platform key (S5). */
  readonly publicKey?: ClockifyPublicKeyInput;
}

export async function createServer(
  configOverride?: AppConfig,
  options: CreateServerOptions = {},
): Promise<AppServer> {
  const config = configOverride ?? loadConfig();
  // Fail fast at boot on a bad CLOCKIFY_PARENT_ORIGIN (non-HTTPS, or a value with a path) instead
  // of on the first component request. Reuses the SDK's own frame-ancestors validator
  // (buildClockifySecurityHeaders -> assertFrameAncestor) rather than duplicating it.
  buildClockifySecurityHeaders({ frameAncestors: [config.clockifyParentOrigin] });

  const logger = createLogger(config.logLevel);
  const db = openDatabase(config.databasePath);

  const key = await importTokenEncryptionKey(config.tokenEncryptionKeyHex);
  const codec = createClockifyAesGcmTokenCodec(key);
  const rawInstallations = createSqliteInstallationStore(db);
  const installations = wrapClockifyInstallationStoreWithEncryption(
    rawInstallations,
    codec,
    (error, workspaceId, addonId) => {
      logger.error("installation decode failed", { workspaceId, addonId, error: String(error) });
    },
  );

  const manifest = buildManifest({ addonKey: config.addonKey, publicBaseUrl: config.publicBaseUrl });
  const parser = createClockifySignatureParser(
    config.addonKey,
    options.publicKey !== undefined ? { publicKey: options.publicKey } : {},
  );

  const addon = createValidatedClockifyAddon(manifest, undefined, {
    onError(error, context) {
      logger.error("addon error", { source: context.source, error: String(error) });
    },
  });

  const lifecycle = lifecycleDescriptors();

  addon.registerLifecycleEvent(
    lifecycle.installed,
    withClockifyInstalledLifecycleRequest(parser, async (_request, payload, claims) => {
      await installations.save({ ...payload, installedAt: Date.now() });
      logger.info("installation installed", {
        workspaceId: claims.workspaceId,
        addonId: claims.addonId,
      });
      return { status: 204 };
    }),
  );

  addon.registerLifecycleEvent(
    lifecycle.statusChanged,
    withClockifyStatusChangedLifecycleRequest(parser, async (_request, payload, claims) => {
      const updated = updateInstallationStatus(
        db,
        claims.workspaceId,
        claims.addonId,
        payload.status,
      );
      const fields = {
        workspaceId: claims.workspaceId,
        addonId: claims.addonId,
        status: payload.status,
      };
      if (updated) logger.info("installation status changed", fields);
      // Still 204: Clockify has nothing to retry, and the status of an installation this app
      // does not hold is not actionable. Say so rather than logging a change that did not happen.
      else logger.warn("status changed for an unknown installation", fields);
      return { status: 204 };
    }),
  );

  addon.registerLifecycleEvent(
    lifecycle.deleted,
    withClockifyDeletedLifecycleRequest(parser, async (_request, _payload, claims) => {
      // The DELETED payload carries no generation: unconditional delete (docs/08). One
      // synchronous transaction removes the installation row and every domain-table row for the
      // workspace (store/cascade.ts) — IT-11.
      const result = uninstallWorkspace(db, claims.workspaceId, claims.addonId);
      logger.info("installation deleted", {
        workspaceId: claims.workspaceId,
        addonId: claims.addonId,
        result,
      });
      return { status: 204 };
    }),
  );

  addon.registerWebhook(
    webhookDescriptor(),
    withClockifyVerifiedWebhookRequest(
      parser,
      {
        expectedEventType: "TIME_ENTRY_DELETED",
        async getExpectedWebhookAuthToken({ workspaceId, addonId }) {
          const installation = await installations.load(workspaceId, addonId);
          return installation?.webhooks?.find(
            (webhook) => normalizeWebhookPath(webhook.path) === WEBHOOK_PATH,
          )?.authToken;
        },
        // A lookup that finds no stored token is a wiring failure, not an attack: the
        // installation is missing, or Clockify delivered a path this app stores under a
        // different key. Without this reporter the SDK's own error goes nowhere (it is passed
        // to `reportAddonError`, which is a no-op when the reporter is undefined), so every
        // delivery would 401 in silence until Clockify's retry budget ran out. The SDK redacts
        // the request before calling this.
        onError(error) {
          logger.error("webhook token lookup failed", { error: String(error) });
        },
      },
      async (request, claims) => {
        if (claims.workspaceId === undefined) {
          logger.error("webhook claims missing workspaceId", {});
          return { status: 400, body: "missing workspaceId claim" };
        }
        const result = handleDeletedEntryWebhook(db, request.body, {
          workspaceId: claims.workspaceId,
        });
        if (result.status >= 400) {
          logger.warn("webhook rejected", {
            workspaceId: claims.workspaceId,
            status: result.status,
          });
        }
        return result.body === undefined
          ? { status: result.status }
          : { status: result.status, body: result.body };
      },
    ),
  );

  addon.registerComponent(
    componentDescriptor(),
    withClockifyVerifiedComponentRequest(parser, async (_request, claims) =>
      createClockifyHtmlResponse(
        componentShellHtml(config.clockifyParentOrigin, STATIC_APP_JS_PATH, {
          ...(claims.theme !== undefined ? { theme: claims.theme } : {}),
          ...(claims.language !== undefined ? { language: claims.language } : {}),
          ...(claims.workspaceRole !== undefined ? { workspaceRole: claims.workspaceRole } : {}),
        }),
        {
          frameAncestors: [config.clockifyParentOrigin],
          // default-src 'none' blocks the external /static/app.js script; script-src is not a
          // managed directive, so this is the correct (and only) way to allow it.
          contentSecurityPolicy: { "script-src": ["'self'"] },
        },
      ),
    ),
  );

  addon.registerHandler(ICON_PATH, "GET", async () => ({
    status: 200,
    headers: { "content-type": "image/svg+xml", "cache-control": "public, max-age=86400" },
    body: ADDON_ICON_SVG,
  }));

  addon.registerHandler(STATIC_APP_JS_PATH, "GET", async () => {
    const bundle = loadAppBundle();
    if (bundle === undefined) {
      logger.error("static bundle missing", { path: STATIC_APP_JS_PATH });
      return { status: 500, body: "Static bundle not built. Run npm run build." };
    }
    return {
      status: 200,
      headers: {
        "content-type": "text/javascript; charset=utf-8",
        "cache-control": "public, max-age=300",
      },
      body: bundle,
    };
  });

  // docs/14: /healthz needs no auth and reports whether the process can serve requests, which
  // includes reaching its own database — a readable process with an unreadable database is not
  // healthy.
  addon.registerHandler("/healthz", "GET", async () => {
    try {
      db.prepare("SELECT 1").get();
      return { status: 200, body: { status: "ok", db: "ok" } };
    } catch {
      return { status: 500, body: { status: "error", db: "error" } };
    }
  });

  registerApiRoutes(addon, parser, {
    db,
    installations,
    onError(error, context) {
      logger.error("api route error", { route: context.route, error: String(error) });
    },
  });

  return { addon, config, logger, db, installations };
}

async function main(): Promise<void> {
  const { addon, config, logger } = await createServer();
  createNodeHttpAddonServer(addon, {
    onError(error, context) {
      logger.error("http error", { source: context.source, error: String(error) });
    },
  }).listen(config.port, () => {
    logger.info("listening", { port: config.port, baseUrl: config.publicBaseUrl });
  });
}

const isMainModule =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMainModule) {
  main().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
