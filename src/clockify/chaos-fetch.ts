// Test-only chaos hook for the LV-10 mandatory ambiguity drill (docs/13 LV-10). Mirrors the guard
// pattern already established by `RT_TEST_CRASH_MID_ATTEMPT` (src/clockify/recreate.ts
// `shouldCrashMidAttempt`): a flag read from the environment, active only when
// `NODE_ENV === "test"`, so it can never fire in production regardless of how the env var is set
// there — the guard is `NODE_ENV`, not the flag alone (proved by the negative test in
// `tests/integration/chaos-fetch-drill.test.ts`, matching
// `tests/integration/lease-fencing-drill.test.ts`'s equivalent negative case).
//
// Only the `createForUser` POST (`POST /workspaces/{workspaceId}/user/{userId}/time-entries`,
// clockify-sdk-ts-115 `timeEntries.createForUser`) is ever intercepted. Every other request —
// including the baseline and reconcile `listForUser` reads `attemptRecreation`/`runReconcile`
// perform around it — passes through untouched, so the ambiguity protocol's baseline-delta
// reconcile is exercised for real, not faked.
//
// Two modes (docs/13 LV-10 (a)/(b)):
//
// - `lose-response`: the real request is sent to Clockify and awaited to completion — the entry
//   really is created — but the response is never handed back to the SDK. The caller sees a
//   `ClockifyApiTimeoutError`, the same class a real 30s stall produces (docs/03 §3 classification
//   1), so `executeCreate` (src/clockify/recreate.ts) takes the AMBIGUOUS branch exactly as it
//   would for a genuine timeout. Models "lose-after-commit": Clockify received and applied the
//   write; the reply was lost in transit.
// - `fail-before-send`: the wrapped fetch throws before calling the real fetch at all — nothing is
//   ever sent, so nothing is ever created. Models "fail-before-send": the request never left the
//   process. The SDK's request layer (clockify-sdk-ts-115, not this module) re-wraps whatever a
//   custom `fetch` throws that is not already a `ClockifyApiError`/`ClockifyApiTimeoutError` as
//   `new ClockifyApiError({message, cause})` with `statusCode` left `undefined` — the same shape a
//   genuine DNS/connection failure produces — so `executeCreate` still lands on AMBIGUOUS
//   (classification 2, "statusCode === undefined"), just a different branch than `lose-response`.
//
// Both classify as AMBIGUOUS (docs/03 §3), which is the point: the app cannot and must not tell
// these two situations apart from the create call's outcome alone — that is exactly why the
// ambiguity protocol (baseline-delta reconcile) exists, and exactly what LV-10 proves live.

import { ClockifyApiTimeoutError } from "clockify-sdk-ts-115";

const CREATE_FOR_USER_PATH = /\/workspaces\/[^/]+\/user\/[^/]+\/time-entries$/;

export type ChaosMode = "lose-response" | "fail-before-send";

const CHAOS_MODES: readonly ChaosMode[] = ["lose-response", "fail-before-send"];

/** Thrown by the wrapped fetch itself — never a `ClockifyApiTimeoutError`/`ClockifyApiError`, so
 * it is unambiguous in test assertions and logs which failure was injected versus real. */
export class ChaosFetchInjectedError extends Error {}

/** The active chaos mode, or `undefined` when the hook must be inert — including whenever
 * `NODE_ENV !== "test"`, regardless of `RT_CHAOS_FETCH`'s value (the same non-negotiable guard
 * `RT_TEST_CRASH_MID_ATTEMPT` uses). Exported so `client.ts` can decide, without this module ever
 * having to fabricate a "no-op wrapper" — the caller passes `options.fetch` straight through when
 * this returns `undefined`. */
export function activeChaosMode(env: NodeJS.ProcessEnv = process.env): ChaosMode | undefined {
  if (env.NODE_ENV !== "test") return undefined;
  const raw = env.RT_CHAOS_FETCH;
  return (CHAOS_MODES as readonly string[]).includes(raw ?? "") ? (raw as ChaosMode) : undefined;
}

function isCreateForUserRequest(request: Request): boolean {
  if (request.method !== "POST") return false;
  let pathname: string;
  try {
    pathname = new URL(request.url).pathname;
  } catch {
    return false;
  }
  return CREATE_FOR_USER_PATH.test(pathname);
}

/** Drains the response body so the real socket the `lose-response` request opened is released
 * before the caller ever sees the injected failure — an un-drained undici response keeps the
 * connection alive and would hang the process. */
async function drain(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // The response is being discarded either way; a failure to cancel is not this function's
    // problem to report.
  }
}

/**
 * Wraps `fetchImpl` with the given (already-active) chaos `mode`. Callers check
 * {@link activeChaosMode} first — this function always wraps, so production code paths never call
 * it: `buildClockifyClient` (src/clockify/client.ts) only calls this when `activeChaosMode()` is
 * defined, and passes `options.fetch` straight through unmodified otherwise.
 */
export function wrapChaosFetch(fetchImpl: typeof globalThis.fetch, mode: ChaosMode): typeof globalThis.fetch {
  return (async (input, init) => {
    const request = input instanceof Request ? input : new Request(input, init);
    if (!isCreateForUserRequest(request)) return fetchImpl(input, init);

    if (mode === "fail-before-send") {
      throw new ChaosFetchInjectedError(
        "RT_CHAOS_FETCH=fail-before-send: simulated failure before the request left the process; nothing was sent to Clockify",
      );
    }

    // lose-response: perform the real request (Clockify may commit it), then report the response
    // as lost. `request.clone()` because the original `request` object still belongs to the
    // caller's retry/inspection logic upstream in the SDK.
    const response = await fetchImpl(request.clone());
    await drain(response);
    throw new ClockifyApiTimeoutError(
      "RT_CHAOS_FETCH=lose-response: simulated transport timeout after the request committed; the response was never delivered to the caller",
    );
  }) as typeof globalThis.fetch;
}
