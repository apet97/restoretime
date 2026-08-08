// /api/* mount point (docs/05). PASS-01 registers one placeholder route that proves the
// requireViewer guard end-to-end; PASS-02 replaces it with the real list/detail/preflight/
// recreate/reconcile/dismiss/options routes and removes /api/ping.

import type { RequestHandler } from "@apet97/clockify-addon-sdk";
import {
  createClockifyJsonResponse,
  type ClockifySignatureParser,
} from "@apet97/clockify-addon-sdk/clockify";
import { requireViewer } from "../platform/verify.js";

export const PING_PATH = "/api/ping";

interface HandlerRegistrar {
  registerHandler(path: string, method: string, handler: RequestHandler): void;
}

export function registerApiRoutes(addon: HandlerRegistrar, parser: ClockifySignatureParser): void {
  addon.registerHandler(
    PING_PATH,
    "GET",
    requireViewer(parser, async (_request, viewer) =>
      createClockifyJsonResponse({
        ok: true,
        userId: viewer.userId,
        workspaceId: viewer.workspaceId,
        workspaceRole: viewer.workspaceRole,
      }),
    ),
  );
}
