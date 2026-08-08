// App-API auth guard (docs/05, docs/09). The viewer boundary: every /api/* route derives its
// identity from a verified component JWT, never from the request body, path, or query.

import type { AddonRequest, RequestHandler } from "@apet97/clockify-addon-sdk";
import {
  getClockifyHeaderValues,
  verifyClockifyToken,
  type ClockifySignatureParser,
} from "@apet97/clockify-addon-sdk/clockify";

export interface Viewer {
  readonly userId: string;
  readonly workspaceId: string;
  readonly workspaceRole: string;
  /** Needed to load the right installation row for every Clockify call the route makes
   * (docs/08 installations PK is `(workspace_id, addon_id)`). */
  readonly addonId: string;
}

export type ViewerRequestHandler = (
  request: AddonRequest,
  viewer: Viewer,
) => ReturnType<RequestHandler>;

const AUTHORIZATION_HEADER = "authorization";
const BEARER_PREFIX = "Bearer ";

function extractBearerToken(headers: AddonRequest["headers"]): string | undefined {
  const values = getClockifyHeaderValues(headers, AUTHORIZATION_HEADER);
  if (values.length !== 1) return undefined; // missing, or ambiguous (repeated header)
  const value = values[0];
  if (value === undefined || !value.startsWith(BEARER_PREFIX)) return undefined;
  const token = value.slice(BEARER_PREFIX.length).trim();
  return token === "" ? undefined : token;
}

function unauthorized(): ReturnType<RequestHandler> {
  return { status: 401, body: "Unauthorized" };
}

/**
 * `requireExpiration: true` is passed explicitly and is not optional to omit: `verifyClockifyToken`
 * defaults it to `false` (only the component-request verifier forces it), and the app API must
 * never accept a non-expiring bearer token here (fact 5, AGENTS.md rule 1).
 */
export function requireViewer(
  parser: ClockifySignatureParser,
  handler: ViewerRequestHandler,
): RequestHandler {
  return async (request) => {
    const token = extractBearerToken(request.headers);
    const result = await verifyClockifyToken(parser, token, { requireExpiration: true });
    if (!result.ok) return unauthorized();

    const { user, workspaceId, workspaceRole, addonId } = result.claims;
    if (!user || !workspaceId || !workspaceRole || !addonId) return unauthorized();

    return handler(request, { userId: user, workspaceId, workspaceRole, addonId });
  };
}
