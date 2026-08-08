// Metrics (docs/14 "Metrics"). No metrics library (implementation/DEPENDENCIES.md is closed) —
// a `metric:`-prefixed structured log line, through the same logger every other log line uses, is
// the whole mechanism ("Counter/gauge log lines... any scraper can parse them"). Exactly the
// thirteen names docs/14 lists; nothing else — a test asserts the emitted name set equals this list.

import type { Logger } from "./log.js";

export const METRIC_NAMES = [
  "webhook_received",
  "webhook_rejected",
  "webhook_duplicate",
  "recoverable_created",
  "preflight_blockers",
  "preflight_action_required",
  "recreate_attempt",
  "recreate_success",
  "recreate_failed",
  "recreate_ambiguous",
  "ambiguous_adopted",
  "ambiguous_not_created",
  "authz_denied",
] as const;

export type MetricName = (typeof METRIC_NAMES)[number];

/** One structured log line per emission: `{msg: "metric:<name>", ...fields}`. `fields` follows the
 * same allowed-field rule every other log line does (docs/12/14): ids, states, error codes, counts
 * — never descriptions, custom-field values, or tokens. */
export function emitMetric(logger: Logger, name: MetricName, fields: Record<string, unknown> = {}): void {
  logger.info(`metric:${name}`, fields);
}
