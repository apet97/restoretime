import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { formatEntryHeader, normalizeLocale, statusLabel, statusPresentation } from "../../src/ui/format.js";

const originalTimeZone = process.env.TZ;

beforeAll(() => {
  process.env.TZ = "Europe/Belgrade";
});

afterAll(() => {
  if (originalTimeZone === undefined) delete process.env.TZ;
  else process.env.TZ = originalTimeZone;
});

describe("statusLabel", () => {
  it("does not claim readiness when the server has no preflight summary", () => {
    expect(statusLabel({ lifecycleState: "IDLE", preflightSummary: null })).toBe("Status unknown");
  });

  it("reports readiness after a successful preflight with no open issues", () => {
    expect(statusLabel({
      lifecycleState: "IDLE",
      preflightSummary: { blockerCount: 0, actionRequiredCount: 0, fidelity: "FULL" },
    })).toBe("Ready to recreate");
  });

  it.each([
    [{ lifecycleState: "IDLE", preflightSummary: { blockerCount: 1, actionRequiredCount: 0, fidelity: "IMPOSSIBLE" } }, { label: "Blocked", tone: "danger" }],
    [{ lifecycleState: "IDLE", preflightSummary: { blockerCount: 0, actionRequiredCount: 1, fidelity: "ADJUSTED" } }, { label: "Needs your input", tone: "warning" }],
    [{ lifecycleState: "RECREATING", preflightSummary: null }, { label: "Recreating", tone: "progress" }],
    [{ lifecycleState: "RECREATED", preflightSummary: null }, { label: "Recreated", tone: "success" }],
    [{ lifecycleState: "FAILED", preflightSummary: null }, { label: "Failed", tone: "danger" }],
    [{ lifecycleState: "AMBIGUOUS", preflightSummary: null }, { label: "Result uncertain", tone: "warning" }],
    [{ lifecycleState: "DISMISSED", preflightSummary: null }, { label: "Dismissed", tone: "neutral" }],
  ] as const)("maps %o to a visible semantic status", (row, expected) => {
    expect(statusPresentation(row)).toEqual(expected);
  });
});

describe("date and time formatting", () => {
  it("normalizes empty, underscore-form, and malformed language claims", () => {
    expect(normalizeLocale("")).toBe("en");
    expect(normalizeLocale("sr_Latn_RS")).toBe("sr-Latn-RS");
    expect(normalizeLocale("not_a_locale_@" )).toBe("en");
  });

  it("keeps seconds for a short exact interval", () => {
    expect(formatEntryHeader("2026-08-07T22:36:11Z", "2026-08-07T22:36:14Z", "en-GB")).toContain("00:36:11–00:36:14 (3s)");
  });

  it("uses one valid fallback locale across a local-midnight boundary", () => {
    const locale = normalizeLocale("not_a_locale_@");
    const shown = formatEntryHeader("2026-08-07T22:36:11Z", "2026-08-07T22:36:14Z", locale);
    expect(shown).toMatch(/Aug 8, 2026.*00:36:11–00:36:14/);
  });

  it("shows both dates when an entry crosses a local calendar day", () => {
    const shown = formatEntryHeader("2026-08-07T21:30:00Z", "2026-08-07T22:30:00Z", "en-GB");
    expect(shown).toMatch(/7 Aug 2026.*23:30–8 Aug 2026.*00:30/);
  });
});
