// Wire shapes returned by /api/* (docs/03, src/api/routes.ts). These are type-only imports from
// the domain module — pure interfaces, erased at build time, no runtime code crosses the
// server/browser boundary. The UI never re-derives what these mean; it only renders them.

import type {
  ActionRequiredItem,
  DeletedTimeEntry,
  Fidelity,
  LifecycleState,
  PlanBlocker,
  PlannedRequest,
  PlanResolution,
  PlanWarning,
  PreflightChoices,
  RecoverableEntry,
  RecreationAttempt,
  RecreationPlan,
} from "../domain/entry.js";

export type {
  ActionRequiredItem,
  DeletedTimeEntry,
  Fidelity,
  LifecycleState,
  PlanBlocker,
  PlannedRequest,
  PlanResolution,
  PlanWarning,
  PreflightChoices,
  RecoverableEntry,
  RecreationAttempt,
  RecreationPlan,
};

export interface PreflightSummary {
  readonly fidelity: Fidelity;
  readonly blockerCount: number;
  readonly actionRequiredCount: number;
}

export interface ListRow extends RecoverableEntry {
  readonly preflightSummary: PreflightSummary | null;
}

export interface ListResponse {
  readonly entries: readonly ListRow[];
  readonly clockifyUnavailable: boolean;
  readonly disabled: boolean;
}

export interface DetailResponse {
  readonly entry: RecoverableEntry;
  readonly plan: RecreationPlan | null;
  readonly attempts: readonly RecreationAttempt[];
  readonly lineage: { readonly parent: RecoverableEntry | null; readonly child: RecoverableEntry | null };
  /** The addon is INACTIVE for this workspace (docs/10 §8). Server fact, never derived here. */
  readonly disabled: boolean;
  /** docs/07 §8's bounded window has elapsed and enough checks have run. Server fact: computing it
   * from the browser clock would offer "it was not created" for an entry that exists. */
  readonly canMarkNotCreated: boolean;
}

export interface PreflightResponse {
  readonly plan: RecreationPlan;
}

export type AttemptRecreationResult =
  | { readonly outcome: "RECREATED"; readonly newEntryId: string; readonly diffs: readonly VerificationDiff[] }
  | { readonly outcome: "FAILED"; readonly status: number | null; readonly code: string | null; readonly message: string }
  | { readonly outcome: "AMBIGUOUS"; readonly baseline: readonly string[] };

export interface VerificationDiff {
  readonly field: string;
  readonly planned: unknown;
  readonly actual: unknown;
}

export interface RecreateResponse {
  readonly result: AttemptRecreationResult;
  readonly entry?: RecoverableEntry;
}

export interface StaleResponse {
  readonly stale: true;
  readonly plan: RecreationPlan;
}

export interface ReconcileResult {
  readonly kind: "none" | "one" | "adopted" | "adopt-conflict" | "many" | "truncated";
  readonly candidateIds?: readonly string[];
  readonly newEntryId?: string;
}

export interface ReconcileResponse {
  readonly result: ReconcileResult | null;
  readonly entry: RecoverableEntry;
}

export interface OptionItem {
  readonly id: string;
  readonly name: string;
  readonly archived?: boolean;
  readonly status?: string;
}

export interface CustomFieldOption {
  readonly id: string;
  readonly name: string;
  readonly type: "TXT" | "NUMBER" | "DROPDOWN_SINGLE" | "DROPDOWN_MULTIPLE" | "CHECKBOX" | "LINK";
  readonly allowedValues: readonly string[] | null;
  readonly required: boolean;
}

export interface BulkPreflightRow {
  readonly entryId: string;
  readonly status: "not-found" | "error" | "blocked" | "needs-input" | "ready";
  readonly message?: string;
  readonly plan?: RecreationPlan;
}

export type BulkRecreateRow =
  // `entryId` is null when the plan id no longer resolves to an entry — there is nothing to open.
  | { readonly entryId: string | null; readonly planId: string; readonly outcome: "ERROR"; readonly message: string }
  | ({ readonly entryId: string; readonly planId: string } & AttemptRecreationResult);
