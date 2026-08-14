// Presentation-only formatting (docs/10). Every function here maps server-supplied data onto the
// exact docs/10 vocabulary — it never decides eligibility, permission, or what is actionable
// (AGENTS.md rule: "the UI holds no business rules"). A blocker, a warning, an actionable state:
// all of it comes from `plan`/`entry` fields already computed server-side; this module only
// chooses which fixed English string represents a given fact.

import { formatClockifyDate } from "@apet97/clockify-addon-sdk/ui";
import type { Fidelity, ListRow } from "./types.js";

export type StatusTone = "success" | "warning" | "danger" | "progress" | "neutral";

export interface StatusPresentation {
  readonly label: string;
  readonly tone: StatusTone;
}

/** docs/10 §1: the exact status vocabulary, derived from the entry's stored lifecycle state (never
 * a client-side eligibility decision) plus the server's own preflight summary counts. */
export function statusPresentation(row: Pick<ListRow, "lifecycleState" | "preflightSummary">): StatusPresentation {
  switch (row.lifecycleState) {
    case "RECREATING":
      return { label: "Recreating", tone: "progress" };
    case "RECREATED":
      return { label: "Recreated", tone: "success" };
    case "FAILED":
      return { label: "Failed", tone: "danger" };
    case "AMBIGUOUS":
      return { label: "Result uncertain", tone: "warning" };
    case "DISMISSED":
      return { label: "Dismissed", tone: "neutral" };
    case "IDLE": {
      const summary = row.preflightSummary;
      if (summary === null) return { label: "Status unknown", tone: "neutral" };
      if (summary.blockerCount > 0) return { label: "Blocked", tone: "danger" };
      if (summary.actionRequiredCount > 0) return { label: "Needs your input", tone: "warning" };
      return { label: "Ready to recreate", tone: "success" };
    }
  }
}

export function statusLabel(row: Pick<ListRow, "lifecycleState" | "preflightSummary">): string {
  return statusPresentation(row).label;
}

/** docs/10 §5: Complete / Adjusted / Partial. IMPOSSIBLE never reaches the confirm view (a plan
 * with blockers has no confirm action), so it renders defensively rather than throwing. */
export function fidelityLabel(fidelity: Fidelity): string {
  switch (fidelity) {
    case "FULL":
      return "Complete";
    case "ADJUSTED":
      return "Adjusted";
    case "PARTIAL":
      return "Partial";
    case "IMPOSSIBLE":
      return "Impossible";
  }
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

/** Returns one locale that every formatter can use. Invalid, empty, and unsupported claims use the
 * same English fallback, so the date and time can never format in different zones. */
export function normalizeLocale(raw: string | undefined): string {
  const candidate = raw?.trim().replaceAll("_", "-") || "en";
  try {
    return Intl.DateTimeFormat.supportedLocalesOf([candidate])[0] ?? "en";
  } catch {
    return "en";
  }
}

/** "09:00" in the viewer's locale/timezone-naive wall-clock reading of the ISO instant (the source
 * stores UTC instants; docs/10 does not specify per-viewer timezone conversion for the row display,
 * so this reads the same clock fields the detail view's two columns compare). */
export function formatTime(iso: string, locale: string, includeSeconds = false): string {
  const d = new Date(iso);
  try {
    return new Intl.DateTimeFormat(locale, {
      hour: "2-digit",
      minute: "2-digit",
      ...(includeSeconds ? { second: "2-digit" } : {}),
      hourCycle: "h23",
    }).format(d);
  } catch {
    const seconds = includeSeconds ? `:${pad2(d.getSeconds())}` : "";
    return `${pad2(d.getHours())}:${pad2(d.getMinutes())}${seconds}`;
  }
}

/** "2h 30m" / "45m" / "3h". Never shown for a still-running source (docs/10 shows no duration for
 * an entry that had no end at deletion). */
export function formatDuration(startIso: string, endIso: string): string {
  const totalSeconds = Math.max(0, Math.round((new Date(endIso).getTime() - new Date(startIso).getTime()) / 1_000));
  const h = Math.floor(totalSeconds / 3_600);
  const m = Math.floor((totalSeconds % 3_600) / 60);
  const s = totalSeconds % 60;
  const parts = [h > 0 ? `${h}h` : "", m > 0 ? `${m}m` : "", s > 0 || totalSeconds === 0 ? `${s}s` : ""].filter(Boolean);
  return parts.join(" ");
}

/** docs/10 §1 row header, e.g. "7 Aug 2026 · 09:00–11:30 (2h 30m)", or "…09:00– (still running
 * when deleted)" when the source had no end. Date via the SDK's `formatClockifyDate` — its style is
 * fixed (`dateStyle: "medium"`); ECMA-402 forbids combining `dateStyle` with field options like
 * `weekday`, so this never passes any (that combination throws, not just gets ignored). */
export function formatEntryHeader(
  start: string,
  end: string | null,
  locale: string,
  /** What an absent end time means. On the deleted entry it is history; on the planned entry it is
   * an intention, and saying "still running when deleted" there would describe the wrong entry. */
  openEnded: "deleted" | "planned" = "deleted",
): string {
  const date = formatClockifyDate(new Date(start), locale);
  const showSeconds = new Date(start).getSeconds() !== 0 || (end !== null && new Date(end).getSeconds() !== 0);
  const startTime = formatTime(start, locale, showSeconds);
  if (end === null) {
    const suffix = openEnded === "deleted" ? "(still running when deleted)" : "(runs until you stop it)";
    return `${date} · ${startTime}– ${suffix}`;
  }
  const endTime = formatTime(end, locale, showSeconds);
  const endDate = formatClockifyDate(new Date(end), locale);
  const endPoint = endDate === date ? endTime : `${endDate} · ${endTime}`;
  return `${date} · ${startTime}–${endPoint} (${formatDuration(start, end)})`;
}

/** docs/10 §1 "Detected: 7 Aug 2026, 15:42". */
export function formatDetected(iso: string, locale: string): string {
  return `${formatClockifyDate(new Date(iso), locale)}, ${formatTime(iso, locale)}`;
}
