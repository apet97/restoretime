// Plan hash + staleness compare (docs/06 "RecreationPlan", docs/07 §5/§7, ADR-006). Pure.

import { createHash } from "node:crypto";
import type {
  ActionRequiredItem,
  DeletedTimeEntry,
  PlanBlocker,
  PlannedRequest,
  PlanResolution,
  PlanWarning,
  RecreationPlan,
} from "./entry.js";

/** sha256 of the normalized source (docs/06 "sourceHash: tamper/staleness check"). Deterministic:
 * `DeletedTimeEntry` always round-trips through the exact key order `normalizeDeletedEntry`
 * builds, so hashing the same source content always produces the same digest. */
export function sourceHash(source: DeletedTimeEntry): string {
  return createHash("sha256").update(JSON.stringify(source)).digest("hex");
}

/** A plan is usable to execute only when it is still ACTIVE and its captured source hash matches
 * the entry's current source hash (UT-S01). */
export function isPlanUsable(plan: RecreationPlan, currentSourceHash: string): boolean {
  return plan.status === "ACTIVE" && plan.sourceHash === currentSourceHash;
}

export interface PreflightOutcomeShape {
  readonly plannedRequest: PlannedRequest;
  readonly resolution: readonly PlanResolution[];
  readonly warnings: readonly PlanWarning[];
  readonly blockers: readonly PlanBlocker[];
  readonly actionRequired: readonly ActionRequiredItem[];
}

/** Revalidation (docs/07 §7 step 3): true when a fresh preflight outcome differs from the plan's
 * captured outcome in any field the mutable re-fetch could have changed (UT-S02). */
export function outcomesDiffer(a: PreflightOutcomeShape, b: PreflightOutcomeShape): boolean {
  return (
    JSON.stringify(a.plannedRequest) !== JSON.stringify(b.plannedRequest) ||
    JSON.stringify(a.resolution) !== JSON.stringify(b.resolution) ||
    JSON.stringify(a.warnings) !== JSON.stringify(b.warnings) ||
    JSON.stringify(a.blockers) !== JSON.stringify(b.blockers) ||
    JSON.stringify(a.actionRequired) !== JSON.stringify(b.actionRequired)
  );
}
