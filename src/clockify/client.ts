// Builds the app's one Clockify REST client (docs/03 §2-§3, docs/04). `baseUrl` always comes from
// the installation's `apiUrl` via the addon SDK's `resolveClockifyApiBaseUrl` — never hardcoded
// (IMPLEMENTER.md critical invariant, AGENTS.md). `fetch` and `factory` are injectable so tests
// can assert on the exact options passed to the SDK factory, including `timeoutInSeconds` (fact
// 7): a mocked transport alone cannot prove the option was set, because a mock never times out
// either way.

import {
  createClockifyClient as sdkCreateClockifyClient,
  type ClockifyClient,
  type CreateClockifyClientOptions,
} from "clockify-sdk-ts-115";
import { resolveClockifyApiBaseUrl } from "@apet97/clockify-addon-sdk/clockify";

export interface InstallationLike {
  readonly apiUrl?: string;
  readonly authToken: string;
}

export type ClockifyClientFactory = (options: CreateClockifyClientOptions) => ClockifyClient;

/** The SDK has no default request timeout; without this the AMBIGUOUS outcome class
 * (`ClockifyApiTimeoutError`) is unreachable in production (fact 7, docs/03 §3). */
export const CLOCKIFY_CLIENT_TIMEOUT_SECONDS = 30;

export function buildClockifyClient(
  installation: InstallationLike,
  options: { readonly fetch?: typeof globalThis.fetch; readonly factory?: ClockifyClientFactory } = {},
): ClockifyClient {
  const baseUrl = resolveClockifyApiBaseUrl(
    installation.apiUrl !== undefined ? { apiUrl: installation.apiUrl } : {},
  );
  const factory = options.factory ?? sdkCreateClockifyClient;
  const clientOptions: CreateClockifyClientOptions = {
    addonToken: installation.authToken,
    timeoutInSeconds: CLOCKIFY_CLIENT_TIMEOUT_SECONDS,
    ...(baseUrl !== undefined ? { baseUrl } : {}),
    ...(options.fetch !== undefined ? { fetch: options.fetch } : {}),
  };
  return factory(clientOptions);
}
