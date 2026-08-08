// Domain types (docs/06 "Recovery domain"). Pure data shapes only — no I/O, no SDK imports.
// Mandated terminology: recreate/recreation/recreated, deleted entry, new entry. Never
// restore/undelete/original entry (AGENTS.md rule 20).

/** The normalized record of one deleted Clockify time entry, built once from the
 * `TIME_ENTRY_DELETED` payload at ingestion. Immutable after creation (docs/06). */
export interface DeletedTimeEntry {
  readonly workspaceId: string;
  readonly entryId: string;
  readonly ownerId: string;
  readonly ownerName: string;
  readonly description: string;
  readonly billable: boolean;
  readonly start: string;
  readonly end: string | null;
  readonly wasRunning: boolean;
  readonly type: string;
  readonly timeZone: string | null;
  readonly projectId: string | null;
  readonly projectName: string | null;
  readonly clientName: string | null;
  readonly taskId: string | null;
  readonly taskName: string | null;
  readonly tags: readonly { readonly id: string; readonly name: string }[];
  readonly customFieldValues: readonly {
    readonly customFieldId: string;
    readonly name: string;
    readonly value: unknown;
  }[];
}

export const LIFECYCLE_STATES = [
  "IDLE",
  "RECREATING",
  "RECREATED",
  "FAILED",
  "AMBIGUOUS",
  "DISMISSED",
] as const;

export type LifecycleState = (typeof LIFECYCLE_STATES)[number];

/** One row per deleted entry: the source plus the recovery lifecycle (docs/06). */
export interface RecoverableEntry {
  readonly id: string;
  readonly workspaceId: string;
  readonly sourceEntryId: string;
  readonly ownerId: string;
  readonly detectedAt: string;
  readonly source: DeletedTimeEntry;
  readonly lifecycleState: LifecycleState;
  readonly claimToken: string | null;
  readonly claimExpiresAt: string | null;
  readonly newEntryId: string | null;
  readonly recreatedAt: string | null;
  readonly recreatedBy: string | null;
  readonly parentRecoverableId: string | null;
}

export const PLAN_STATUSES = ["ACTIVE", "STALE", "CONSUMED"] as const;
export type PlanStatus = (typeof PLAN_STATUSES)[number];

export const FIDELITY_LEVELS = ["FULL", "ADJUSTED", "PARTIAL", "IMPOSSIBLE"] as const;
export type Fidelity = (typeof FIDELITY_LEVELS)[number];

/** Per-dependency resolution outcome recorded on a plan (docs/06). */
export interface PlanResolution {
  readonly kind: "project" | "task" | "tag" | "customField" | "runningMode";
  readonly refId: string | null;
  readonly outcome: "kept" | "substituted" | "dropped" | "missing";
  readonly detail?: string;
}

export interface PlannedRequest {
  readonly workspaceId: string;
  readonly userId: string;
  readonly start: string;
  readonly end?: string;
  readonly description?: string;
  readonly billable?: boolean;
  readonly projectId?: string;
  readonly taskId?: string;
  readonly tagIds?: string[];
  readonly customFields?: { customFieldId: string; sourceType: "WORKSPACE"; value: unknown }[];
}

/** A single ACTION_REQUIRED item the UI must resolve before the plan can proceed. */
export interface ActionRequiredItem {
  readonly ruleId: string;
  readonly message: string;
  readonly options?: readonly string[];
}

export interface PlanBlocker {
  readonly ruleId: string;
  readonly code: string;
  readonly message: string;
}

export interface PlanWarning {
  readonly ruleId: string;
  readonly code: string;
  readonly message: string;
}

/** The output of one preflight run (docs/06 "RecreationPlan"). Immutable once persisted. */
export interface RecreationPlan {
  readonly id: string;
  readonly recoverableEntryId: string;
  readonly createdBy: string;
  readonly createdAt: string;
  readonly sourceHash: string;
  readonly resolution: readonly PlanResolution[];
  readonly plannedRequest: PlannedRequest;
  readonly warnings: readonly PlanWarning[];
  readonly blockers: readonly PlanBlocker[];
  readonly actionRequired: readonly ActionRequiredItem[];
  readonly fidelity: Fidelity;
  readonly status: PlanStatus;
}

export const ATTEMPT_OUTCOMES = ["SUCCESS", "FAILED", "AMBIGUOUS"] as const;
export type AttemptOutcome = (typeof ATTEMPT_OUTCOMES)[number];

export interface ReconcileSummary {
  readonly checkedAt: string;
  readonly checks: number;
  readonly matchCount: number;
  readonly candidateIds: readonly string[];
  readonly truncated: boolean;
}

export interface VerificationDiff {
  readonly field: string;
  readonly planned: unknown;
  readonly actual: unknown;
}

/** One row per mutation attempt: audit record (docs/06 "RecreationAttempt"). */
export interface RecreationAttempt {
  readonly id: string;
  readonly planId: string;
  readonly recoverableEntryId: string;
  readonly startedAt: string;
  readonly finishedAt: string | null;
  readonly outcome: AttemptOutcome | null;
  readonly newEntryId: string | null;
  readonly errorStatus: number | null;
  readonly errorCode: string | null;
  readonly errorMessage: string | null;
  readonly baseline: readonly string[] | null;
  readonly reconcile: ReconcileSummary | null;
  readonly diffs: readonly VerificationDiff[] | null;
}

/** Choices the UI submits from a previous ACTION_REQUIRED round (docs/07 §1). Re-validated on
 * every preflight call — never trusted blindly. */
export interface PreflightChoices {
  readonly projectId?: string | null;
  readonly taskId?: string | null;
  readonly dropTagIds?: readonly string[];
  readonly addTagIds?: readonly string[];
  readonly description?: string;
  readonly runningMode?: "running" | "completed";
  readonly completedEnd?: string;
  readonly customFieldInputs?: readonly { customFieldId: string; value: unknown }[];
  readonly dropCustomFieldIds?: readonly string[];
}

export interface Viewer {
  readonly userId: string;
  readonly workspaceId: string;
  readonly workspaceRole: string;
}
