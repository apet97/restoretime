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
  RecreationPlan,
};

/** Audit fields that the detail view is allowed to receive. Write-reconciliation baselines stay
 * server-side; candidate ids are transient and are cleared after ambiguity is resolved. */
export interface AttemptView {
  readonly id: string;
  readonly planId: string;
  readonly recoverableEntryId: string;
  readonly startedAt: string;
  readonly finishedAt: string | null;
  readonly outcome: "SUCCESS" | "FAILED" | "AMBIGUOUS" | null;
  readonly newEntryId: string | null;
  readonly errorStatus: number | null;
  readonly errorCode: string | null;
  readonly errorMessage: string | null;
  readonly reconcile: {
    readonly checkedAt: string;
    readonly checks: number;
    readonly matchCount: number;
    readonly candidateIds?: readonly string[];
    readonly truncated: boolean;
  } | null;
  readonly diffs: readonly VerificationDiff[] | null;
}

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
  /** The installation's Clockify token was rejected (401 code 4017, docs/03 §6). Server fact:
   * the remedy is a reinstall, and the notice must say so. */
  readonly broken: boolean;
  /** Older rows matched the filters but were not returned (server bound, not a UI choice). */
  readonly truncated: boolean;
  readonly limit: number;
}

export interface DetailResponse {
  readonly entry: RecoverableEntry;
  readonly plan: RecreationPlan | null;
  readonly attempts: readonly AttemptView[];
  readonly lineage: { readonly parent: RecoverableEntry | null; readonly child: RecoverableEntry | null };
  /** The addon is INACTIVE for this workspace (docs/10 §8). Server fact, never derived here. */
  readonly disabled: boolean;
  /** The stored installation token was rejected. This remains a server fact on deep links. */
  readonly broken: boolean;
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
  | { readonly outcome: "AMBIGUOUS" };

export interface VerificationDiff {
  readonly field: string;
  readonly planned: unknown;
  readonly actual: unknown;
}

export interface RecreateResponse {
  readonly result: AttemptRecreationResult;
  readonly entry?: RecoverableEntry;
}

export interface ReconcileResult {
  readonly kind: "none" | "adopted" | "adopt-conflict" | "many" | "truncated";
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
  readonly status: "not-found" | "not-actionable" | "error" | "blocked" | "needs-input" | "needs-review" | "ready";
  readonly message?: string;
  readonly plan?: RecreationPlan;
  /** Absent only for `not-found`, where there is no entry left to describe. */
  readonly source?: DeletedTimeEntry;
}

export type BulkRecreateRow =
  // `entryId` is null when the plan id no longer resolves to an entry — there is nothing to open.
  | { readonly entryId: string | null; readonly planId: string; readonly outcome: "ERROR"; readonly message: string }
  | ({ readonly entryId: string; readonly planId: string } & Exclude<AttemptRecreationResult, { readonly outcome: "AMBIGUOUS" }>)
  | {
      readonly entryId: string;
      readonly planId: string;
      readonly outcome: "AMBIGUOUS";
      /** Present when the attempt ended outside the normal result path. */
      readonly message?: string;
    };
