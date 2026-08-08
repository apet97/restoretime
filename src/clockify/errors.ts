// App-owned Clockify body-code normalizer (docs/03 §6, source verbatim). Clockify sends the body
// `code` as a JSON number, and some 4xx bodies carry none at all; the SDK's `getErrorCode` only
// returns string codes, so it returns `undefined` for every Clockify code (R15, S6). This is the
// one recorded exception to AGENTS.md rule 5 (docs/03 §6) — `getErrorCode` is never imported
// anywhere in src/ (docs/16 release gate).

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
    return "Clockify rejected the request: a required field is missing, or the value is invalid.";
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
