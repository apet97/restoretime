// Iframe bridge + token authority (docs/10 §8, fact 13). `createClockifyBridge` is the SDK's
// fail-closed messaging boundary (origin- and source-checked). This module adds exactly the two
// behaviors docs/10 §8 specifies on top of it: a proactive refresh every 25 minutes, and an
// on-demand refresh-and-wait for the API client's 401 path. It holds the token; nothing else does.

import {
  createClockifyBridge,
  type ClockifyBridge,
  type ClockifyBrowserWindow,
} from "@apet97/clockify-addon-sdk/ui";

const REFRESH_TIMEOUT_MS = 5_000;
const PROACTIVE_REFRESH_INTERVAL_MS = 25 * 60 * 1000; // tokens live 30 minutes (docs/10 §8)

export interface TokenAuthority {
  /** The current token. Never persisted, never rendered — read only to build the Authorization
   * header. */
  getToken(): string;
  /** Dispatches `refreshAddonToken` and waits up to 5 s for the reply. Resolves the new token, or
   * `undefined` on timeout or a malformed reply (docs/10 §8). */
  refresh(): Promise<string | undefined>;
}

export interface TokenAuthorityHandle extends TokenAuthority {
  dispose(): void;
}

/**
 * `body` is typed `unknown` by the SDK; docs/10 §8 says the refresh reply's body *is* the token
 * string. A reply that is not a non-empty string is never coerced into "success" — it falls through
 * exactly like a timeout, so a malformed message can never look like a working refresh.
 */
function isTokenBody(body: unknown): body is string {
  return typeof body === "string" && body.length > 0;
}

export function createTokenAuthority(bridge: ClockifyBridge, initialToken: string): TokenAuthorityHandle {
  let current = initialToken;
  let waiters: ((token: string | undefined) => void)[] = [];

  const unsubscribe = bridge.subscribe("refreshAddonToken", (body) => {
    if (!isTokenBody(body)) return;
    current = body;
    const settle = waiters;
    waiters = [];
    for (const resolve of settle) resolve(body);
  });

  function refresh(): Promise<string | undefined> {
    return new Promise((resolve) => {
      let settled = false;
      const finish = (token: string | undefined) => {
        if (settled) return;
        settled = true;
        waiters = waiters.filter((w) => w !== finish);
        resolve(token);
      };
      const timer = setTimeout(() => finish(undefined), REFRESH_TIMEOUT_MS);
      waiters.push((token) => {
        clearTimeout(timer);
        finish(token);
      });
      bridge.refreshAddonToken();
    });
  }

  const interval = setInterval(() => bridge.refreshAddonToken(), PROACTIVE_REFRESH_INTERVAL_MS);

  return {
    getToken: () => current,
    refresh,
    dispose() {
      clearInterval(interval);
      unsubscribe();
    },
  };
}

export interface AppBridge {
  readonly bridge: ClockifyBridge;
  readonly auth: TokenAuthorityHandle;
}

/** Wires the bridge and the token authority together (the two things every view needs: navigation
 * / toasts, and an authorized API client). */
export function setupBridge(window: ClockifyBrowserWindow, parentOrigin: string, initialToken: string): AppBridge {
  const bridge = createClockifyBridge({ window, parentOrigin });
  const auth = createTokenAuthority(bridge, initialToken);
  return { bridge, auth };
}
