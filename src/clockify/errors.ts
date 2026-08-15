// App-owned Clockify body-code normalizer (docs/03 §6, source verbatim). Clockify sends the body
// `code` as a JSON number, and some 4xx bodies carry none at all (R15, S6). This was written
// because the SDK's `getErrorCode` required a string code and so returned `undefined` for every
// code Clockify sends; clockify-sdk-ts-115@3.0.0 fixed that, and the two now agree on every shape
// (UT-M01). The normalizer stays because this app pins its own error classification: every
// user-facing failure reason and the P-TIMER/P-LOCK-REG blocker rules key off this string, and a
// silent change in a transitive dependency must not be able to reclassify a user-visible error.
// That is the one recorded exception to AGENTS.md rule 5 (docs/03 §6) — `getErrorCode` is never
// imported anywhere in src/ (docs/16 release gate).

import { ClockifyApiError } from "clockify-sdk-ts-115";

/** Clockify's body `code` as a string ("501", "4030", …), or undefined when absent. */
export function clockifyErrorCode(err: unknown): string | undefined {
  if (!(err instanceof ClockifyApiError)) return undefined;
  const body = err.body as { code?: unknown; error?: { code?: unknown } } | null | undefined;
  const raw = body?.code ?? body?.error?.code;
  if (typeof raw === "number" && Number.isFinite(raw)) return String(raw);
  if (typeof raw === "string" && raw.length > 0) return raw;
  return undefined;
}

/** 401 code "4017" — the installation's addon token was rejected (docs/03 §6, R11). */
export function isAddonTokenInvalid(err: unknown): boolean {
  return err instanceof ClockifyApiError && err.statusCode === 401 && clockifyErrorCode(err) === "4017";
}

/**
 * Log-safe summary of a caught error (docs/12 "Sensitive log leakage", docs/14 N3). This was
 * written because `ClockifyApiError.message` used to embed the full response body verbatim, so the
 * bare `String(error)` that every `onError` hook in `src/server.ts` once used printed whatever
 * Clockify's error response happened to contain — and Clockify echoes submitted values into its
 * error text. clockify-sdk-ts-115@4.0.0 removed the hazard at source: `.message` is now
 * `"<message>\nStatus code: <n>"`, and the body reaches a string only through the opt-in
 * `clockifyErrorDetail`, which this app does not import. The function stays as defence in depth
 * against that default changing back, and because it is also where the code is normalized.
 * Nothing here reads a webhook body or a Clockify response as "safe"; the rule is narrower and
 * unconditional: a `ClockifyApiError` is summarized as status + normalized code
 * only, never its `message` or `body`. Every other error's `.message` is developer-authored text
 * from this codebase's own `throw` sites (docs/12 review confirms none of them interpolate
 * descriptions, custom-field values, or tokens), so it is safe to log as-is.
 */
export function safeErrorSummary(err: unknown): Record<string, unknown> {
  if (err instanceof ClockifyApiError) {
    return { errorName: "ClockifyApiError", errorStatus: err.statusCode, errorCode: clockifyErrorCode(err) };
  }
  if (err instanceof Error) {
    return { errorName: err.name, errorMessage: err.message };
  }
  return { errorName: "unknown" };
}

/** User-facing reason for a 4xx create rejection (docs/03 §6, docs/07 §8). Message text from
 * Clockify is never parsed for classification (R6) — this maps only on the normalized code and
 * status. */
export function describeClockifyCreateFailure(status: number | undefined, code: string | undefined): string {
  if (code === "4030") {
    return "This workspace requires a timer for manual entries (force timer). An admin can recreate this entry.";
  }
  if (code === "1003") {
    return "The entry's date is in a locked period. An admin can recreate this entry, or unlock the period.";
  }
  if (code === "501") {
    return "Clockify rejected the request: a required field is missing, or the value is invalid. Open this entry again to review its current values.";
  }
  if (code === "4017") {
    return "The addon's Clockify connection was rejected. Reinstall the addon.";
  }
  if (code === "4005") {
    return "Clockify rejected the request: the entry would conflict with an approved time entry.";
  }
  if (code !== undefined) return `Clockify rejected the request (code ${code}).`;
  if (status === 404) return "Clockify does not have this workspace or route.";
  return status === undefined ? "Clockify rejected the request." : `Clockify rejected the request (status ${status}).`;
}
