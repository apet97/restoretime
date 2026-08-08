// Presentation-only formatting (docs/10). Every function here maps server-supplied data onto the
// exact docs/10 vocabulary — it never decides eligibility, permission, or what is actionable
// (AGENTS.md rule: "the UI holds no business rules"). A blocker, a warning, an actionable state:
// all of it comes from `plan`/`entry` fields already computed server-side; this module only
// chooses which fixed English string represents a given fact.

import { formatClockifyDate } from "@apet97/clockify-addon-sdk/ui";
import type { Fidelity, ListRow } from "./types.js";

/** docs/10 §1: the exact status vocabulary, derived from the entry's stored lifecycle state (never
 * a client-side eligibility decision) plus the server's own preflight summary counts. */
export function statusLabel(row: Pick<ListRow, "lifecycleState" | "preflightSummary">): string {
  switch (row.lifecycleState) {
    case "RECREATING":
      return "Recreating…";
    case "RECREATED":
      return "Recreated";
    case "FAILED":
      return "Failed";
    case "AMBIGUOUS":
      return "Unknown result";
    case "DISMISSED":
      return "Dismissed";
    case "IDLE": {
      const summary = row.preflightSummary;
      if (summary === null) return "Ready to recreate";
      if (summary.blockerCount > 0) return "Blocked";
      if (summary.actionRequiredCount > 0) return "Needs your input";
      return "Ready to recreate";
    }
  }
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

/** "09:00" in the viewer's locale/timezone-naive wall-clock reading of the ISO instant (the source
 * stores UTC instants; docs/10 does not specify per-viewer timezone conversion for the row display,
 * so this reads the same clock fields the detail view's two columns compare). */
export function formatTime(iso: string, locale: string): string {
  const d = new Date(iso);
  try {
    return new Intl.DateTimeFormat(locale, { hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(d);
  } catch {
    return `${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}`;
  }
}

/** "2h 30m" / "45m" / "3h". Never shown for a still-running source (docs/10 shows no duration for
 * an entry that had no end at deletion). */
export function formatDuration(startIso: string, endIso: string): string {
  const totalMinutes = Math.max(0, Math.round((new Date(endIso).getTime() - new Date(startIso).getTime()) / 60_000));
  const h = Math.floor(totalMinutes / 60);
  const m = totalMinutes % 60;
  if (h === 0) return `${m}m`;
  if (m === 0) return `${h}h`;
  return `${h}h ${m}m`;
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
  const startTime = formatTime(start, locale);
  if (end === null) {
    const suffix = openEnded === "deleted" ? "(still running when deleted)" : "(runs until you stop it)";
    return `${date} · ${startTime}– ${suffix}`;
  }
  const endTime = formatTime(end, locale);
  return `${date} · ${startTime}–${endTime} (${formatDuration(start, end)})`;
}

/** docs/10 §1 "Detected: 7 Aug 2026, 15:42". */
export function formatDetected(iso: string, locale: string): string {
  return `${formatClockifyDate(new Date(iso), locale)}, ${formatTime(iso, locale)}`;
}
