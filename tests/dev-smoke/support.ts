// Shared support for tests/dev-smoke/* (docs/13 "Developer-environment smoke"). REST-only checks
// against Clockify's real developer environment with an already-captured installation. With any
// of the three required env vars missing, or the token rejected 401 code "4017", every DS test
// reports "blocked — no valid developer installation" and passes — it never fails the pass
// (ROADMAP rule 4) and it is never silently skipped (`--passWithNoTests` is off for this suite).

import { ClockifyApiError } from "clockify-sdk-ts-115";
import { buildClockifyClient } from "../../src/clockify/client.js";
import { clockifyErrorCode } from "../../src/clockify/errors.js";

const REQUIRED_VARS = ["CK_DEV_WORKSPACE_ID", "CK_DEV_ADDON_ID", "CK_DEV_ADDON_TOKEN"] as const;

export interface DevEnv {
  readonly workspaceId: string;
  readonly addonId: string;
  readonly token: string;
}

export type EnvCheck = { readonly blocked: false; readonly env: DevEnv } | { readonly blocked: true; readonly reason: string };

export function checkDevEnv(): EnvCheck {
  for (const name of REQUIRED_VARS) {
    const value = process.env[name];
    if (value === undefined || value.trim() === "") {
      return { blocked: true, reason: `blocked — no valid developer installation (missing ${name})` };
    }
  }
  return {
    blocked: false,
    env: {
      workspaceId: process.env.CK_DEV_WORKSPACE_ID!,
      addonId: process.env.CK_DEV_ADDON_ID!,
      token: process.env.CK_DEV_ADDON_TOKEN!,
    },
  };
}

/** Known developer-environment API base — dev-smoke targets one fixed environment by design
 * (unlike app code, which always derives `baseUrl` from the installation's stored `apiUrl` via
 * `resolveClockifyApiBaseUrl`; this test has no stored installation row, only operator env vars). */
export function buildDevClient(env: DevEnv) {
  return buildClockifyClient({ apiUrl: "https://developer.clockify.me/api", authToken: env.token });
}

export function isAddonTokenRejected(err: unknown): boolean {
  return err instanceof ClockifyApiError && err.statusCode === 401 && clockifyErrorCode(err) === "4017";
}

export const RT_PROBE_PREFIX = "RT-PROBE-";
