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
