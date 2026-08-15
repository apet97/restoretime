// UTC timestamp validation shared by inbound webhooks and list query bounds. The shape check
// prevents Date from accepting browser-specific or normalized date forms at an API boundary.

const UTC_ISO_TIMESTAMP = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?Z$/;

function isUtcIsoTimestampWithFractionLimit(value: unknown, maximumFractionDigits: number): value is string {
  if (typeof value !== "string") return false;
  const match = UTC_ISO_TIMESTAMP.exec(value);
  if (!match) return false;

  const [, yearText, monthText, dayText, hourText, minuteText, secondText, fraction] = match;
  if (fraction !== undefined && fraction.length > maximumFractionDigits) return false;

  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  if (month < 1 || month > 12 || day < 1 || hour > 23 || minute > 59 || second > 59) return false;

  const instant = new Date(value);
  return (
    Number.isFinite(instant.getTime()) &&
    instant.getUTCFullYear() === year &&
    instant.getUTCMonth() === month - 1 &&
    instant.getUTCDate() === day &&
    instant.getUTCHours() === hour &&
    instant.getUTCMinutes() === minute &&
    instant.getUTCSeconds() === second
  );
}

/** Accepts only a real UTC ISO instant with seconds and an optional 1–9 digit fraction. */
export function isUtcIsoTimestamp(value: unknown): value is string {
  return isUtcIsoTimestampWithFractionLimit(value, 9);
}

/** Accepts a list bound with seconds and at most millisecond precision. */
export function isUtcIsoListBound(value: unknown): value is string {
  return isUtcIsoTimestampWithFractionLimit(value, 3);
}

/** Canonicalizes a timestamp only after the strict UTC guard accepts it. */
export function canonicalizeUtcIsoTimestamp(value: string): string {
  if (!isUtcIsoTimestamp(value)) throw new TypeError("value must be a UTC ISO timestamp");
  return new Date(value).toISOString();
}
