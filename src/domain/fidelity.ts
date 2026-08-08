// Fidelity classification (docs/07 §10). Deterministic, pure. Priority order matters: a blocker
// always wins; a value that cannot be represented at all (PARTIAL) outranks a value that was
// merely substituted (ADJUSTED).

import type { Fidelity } from "./entry.js";

export interface FidelityInputs {
  /** Any blocker present -> IMPOSSIBLE. */
  readonly hasBlockers: boolean;
  /** A source value cannot be represented at all: a custom field whose field is gone, or whose
   * value the user chose to drop (P-CF-GONE / P-CF-OPT drop). */
  readonly hasPartialLoss: boolean;
  /** >=1 explicit user substitution/drop/input that changes values: project, task, tags,
   * description, an end time set on a running source, a replacement or entered custom-field
   * value. */
  readonly hasAdjustment: boolean;
}

export function classifyFidelity(inputs: FidelityInputs): Fidelity {
  if (inputs.hasBlockers) return "IMPOSSIBLE";
  if (inputs.hasPartialLoss) return "PARTIAL";
  if (inputs.hasAdjustment) return "ADJUSTED";
  return "FULL";
}
