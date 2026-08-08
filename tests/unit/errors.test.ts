// UT-M01 (docs/13, docs/03 §6). Clockify error mapping through the app-owned normalizer.
import { describe, expect, it } from "vitest";
import { getErrorCode } from "clockify-sdk-ts-115";
import { ClockifyApiError } from "clockify-sdk-ts-115";
import { clockifyErrorCode, describeClockifyCreateFailure, isAddonTokenInvalid, safeErrorSummary } from "../../src/clockify/errors.js";

function apiError(statusCode: number | undefined, body: unknown): ClockifyApiError {
  return new ClockifyApiError({ statusCode, body, message: "generic Clockify error" });
}

describe("UT-M01 clockifyErrorCode", () => {
  it("a JSON number body code (400 {code:501}) normalizes to the string '501'", () => {
    const err = apiError(400, { message: "…", code: 501 });
    expect(clockifyErrorCode(err)).toBe("501");
  });

  it("401 code 4017 (addon token invalid)", () => {
    const err = apiError(401, { message: "…", code: 4017 });
    expect(clockifyErrorCode(err)).toBe("4017");
  });

  it("403 code 4030 (force-timer rejection)", () => {
    const err = apiError(403, { message: "Manual time tracking disabled…", code: 4030 });
    expect(clockifyErrorCode(err)).toBe("4030");
  });

  it("403 code 1003 (locked time entry)", () => {
    const err = apiError(403, { message: "Can't edit locked time entry.", code: 1003 });
    expect(clockifyErrorCode(err)).toBe("1003");
  });

  it("a code-absent 404 body returns undefined", () => {
    const err = apiError(404, { message: "not found" });
    expect(clockifyErrorCode(err)).toBeUndefined();
  });

  it("a non-ClockifyApiError value returns undefined", () => {
    expect(clockifyErrorCode(new Error("plain error"))).toBeUndefined();
    expect(clockifyErrorCode("a string")).toBeUndefined();
    expect(clockifyErrorCode(undefined)).toBeUndefined();
  });

  it("a string body code is also normalized (server drift tolerance)", () => {
    const err = apiError(400, { message: "…", code: "501" });
    expect(clockifyErrorCode(err)).toBe("501");
  });

  it("the SDK's own getErrorCode returns undefined for the same numeric codes — the reason the app owns its own normalizer", () => {
    const err = apiError(400, { message: "…", code: 501 });
    expect(getErrorCode(err)).toBeUndefined();
    // The app's normalizer succeeds where the SDK helper does not — this asymmetry is the whole
    // point of clockifyErrorCode existing (docs/03 §6, R15).
    expect(clockifyErrorCode(err)).toBe("501");
  });
});

describe("UT-M01 describeClockifyCreateFailure — user-facing reasons", () => {
  it("4030 -> force-timer explanation with admin handoff", () => {
    expect(describeClockifyCreateFailure(403, "4030")).toMatch(/timer/i);
    expect(describeClockifyCreateFailure(403, "4030")).toMatch(/admin/i);
  });

  it("1003 -> locked-period explanation with admin handoff", () => {
    expect(describeClockifyCreateFailure(403, "1003")).toMatch(/locked/i);
    expect(describeClockifyCreateFailure(403, "1003")).toMatch(/admin/i);
  });

  it("501 -> domain validation reason", () => {
    expect(describeClockifyCreateFailure(400, "501")).toMatch(/rejected/i);
  });

  it("code-absent 404 -> status-only reason naming the route problem", () => {
    expect(describeClockifyCreateFailure(404, undefined)).toMatch(/workspace or route/i);
  });

  it("code-absent, non-404 4xx -> generic status-based reason", () => {
    expect(describeClockifyCreateFailure(422, undefined)).toContain("422");
  });
});

describe("UT-M02 safeErrorSummary — the log-safe error field set (N3, docs/12, docs/14)", () => {
  it("a ClockifyApiError never surfaces its message or body — status + normalized code only", () => {
    const err = apiError(400, { message: "rejected", code: 501, echoedDescription: "sensitive-source-text" });
    const summary = safeErrorSummary(err);
    expect(summary).toEqual({ errorName: "ClockifyApiError", errorStatus: 400, errorCode: "501" });
    expect(JSON.stringify(summary)).not.toContain("sensitive-source-text");
    expect(JSON.stringify(summary)).not.toContain("rejected");
  });

  it("a plain Error logs name + message (this codebase's own thrown messages are static, non-interpolated text)", () => {
    const summary = safeErrorSummary(new Error("workspace too large to verify; try again"));
    expect(summary).toEqual({ errorName: "Error", errorMessage: "workspace too large to verify; try again" });
  });

  it("a non-Error thrown value degrades to a bare marker, never a raw dump", () => {
    expect(safeErrorSummary("a thrown string")).toEqual({ errorName: "unknown" });
    expect(safeErrorSummary({ some: "object" })).toEqual({ errorName: "unknown" });
  });
});

describe("UT-M01 isAddonTokenInvalid", () => {
  it("true only for 401 + code 4017", () => {
    expect(isAddonTokenInvalid(apiError(401, { code: 4017 }))).toBe(true);
    expect(isAddonTokenInvalid(apiError(401, { code: 1000 }))).toBe(false);
    expect(isAddonTokenInvalid(apiError(403, { code: 4017 }))).toBe(false);
    expect(isAddonTokenInvalid(new Error("nope"))).toBe(false);
  });
});
