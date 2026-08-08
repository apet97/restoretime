// Shared value-comparison helper (R5: "the API normalizes numeric strings to numbers"). Used by
// preflight's default-equality check (P-CF-KEEP/WRITE) and the post-create verification diff
// (docs/07 §9) — one function, not duplicated business logic.

export function looselyEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a === "object" || typeof b === "object") return JSON.stringify(a) === JSON.stringify(b);
  const na = typeof a === "number" ? a : typeof a === "string" && a.trim() !== "" ? Number(a) : NaN;
  const nb = typeof b === "number" ? b : typeof b === "string" && b.trim() !== "" ? Number(b) : NaN;
  if (Number.isFinite(na) && Number.isFinite(nb)) return na === nb;
  return String(a) === String(b);
}
