// The /api/* client (docs/10 §8). The token lives in memory only — inside the closure created by
// `createTokenAuthority` (src/ui/bridge.ts) — never in `localStorage`, the DOM, an API URL, or a log.
// On a 401 this dispatches one refresh, waits up to 5 s, and retries the call exactly once with the
// new token; a timeout or a second 401 is a session-expired condition, not a retry loop.

import type { TokenAuthority } from "./bridge.js";

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly body: unknown,
  ) {
    super(`API error ${status}`);
  }
}

/** The 401-retry gave up (refresh timed out, or the retried call is still a 401). docs/10 §8:
 * "on timeout shows a session-expired notice" — the caller never distinguishes why, only that the
 * session is gone. */
export class SessionExpiredError extends Error {}

export interface ApiClient {
  get(path: string, query?: Record<string, string>): Promise<unknown>;
  post(path: string, body?: unknown): Promise<unknown>;
}

async function readBody(res: Response): Promise<unknown> {
  if (res.status === 204) return undefined;
  const raw = await res.text();
  if (raw.length === 0) return undefined;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return raw;
  }
}

export function createApiClient(auth: TokenAuthority, fetchImpl: typeof fetch = fetch): ApiClient {
  async function send(path: string, init: RequestInit, token: string): Promise<Response> {
    return fetchImpl(path, {
      ...init,
      headers: { ...(init.headers as Record<string, string> | undefined), authorization: `Bearer ${token}` },
    });
  }

  async function call(path: string, init: RequestInit): Promise<unknown> {
    let res = await send(path, init, auth.getToken());
    if (res.status === 401) {
      const refreshed = await auth.refresh();
      if (refreshed === undefined) throw new SessionExpiredError();
      res = await send(path, init, refreshed);
      if (res.status === 401) throw new SessionExpiredError();
    }
    const body = await readBody(res);
    if (!res.ok) throw new ApiError(res.status, body);
    return body;
  }

  return {
    get(path, query) {
      const qs = query ? `?${new URLSearchParams(query).toString()}` : "";
      return call(`${path}${qs}`, { method: "GET" });
    },
    post(path, body) {
      return call(path, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: body === undefined ? null : JSON.stringify(body),
      });
    },
  };
}
