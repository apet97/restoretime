// Preflight decision rules (docs/07 §2-§5, rule-for-rule). Pure: every external fact (workspace
// settings, owner membership, effective project/task/tag/custom-field current state) arrives as
// input. src/clockify/preflight-data.ts does the fetching; this module never performs I/O.

import type {
  ActionRequiredItem,
  DeletedTimeEntry,
  Fidelity,
  PlanBlocker,
  PlannedRequest,
  PlanResolution,
  PlanWarning,
  PreflightChoices,
  Viewer,
} from "./entry.js";
import { isAdmin } from "./policy.js";
import { classifyFidelity } from "./fidelity.js";
import { looselyEqual } from "./values.js";

export interface CustomFieldDef {
  readonly id: string;
  /** `status !== "INACTIVE"` (S6, L6). */
  readonly active: boolean;
  readonly required: boolean;
  readonly type: "TXT" | "NUMBER" | "DROPDOWN_SINGLE" | "DROPDOWN_MULTIPLE" | "CHECKBOX" | "LINK";
  readonly allowedValues: readonly string[] | null;
  readonly defaultValue: unknown;
}

export interface LookupResult {
  readonly id: string;
  readonly archived: boolean;
}

export interface TaskLookupResult {
  readonly id: string;
  readonly status: "ACTIVE" | "DONE" | "ALL";
}

export interface WorkspaceState {
  readonly forceProjects: boolean;
  readonly forceTasks: boolean;
  readonly forceTags: boolean;
  readonly forceDescription: boolean;
  readonly onlyAdminsCanChangeBillableStatus: boolean;
  readonly defaultBillableProjects: boolean;
  /** The value Clockify's server-side defaults imply for a new entry's billable flag, given the
   * two settings above (R12). Computed by the I/O layer; kept as an input here so this module
   * stays pure. */
  readonly impliedBillable: boolean;
  readonly timeTrackingMode: "DEFAULT" | "STOPWATCH_ONLY";
  readonly lockTimeEntries: string | null;
  readonly automaticLockSet: boolean;
  /** `undefined` when the source had no owner to look up (never happens in practice — every
   * source has an ownerId); `null` when the owner is absent from `users.list`. */
  readonly ownerStatus: string | null;
  /** Current state of whichever project is effective (`choices.projectId ?? source.projectId`).
   * `null` when a lookup was performed and found nothing (404); `undefined` when no lookup was
   * needed (no effective project). */
  readonly effectiveProject: LookupResult | null | undefined;
  /** Current state of whichever task is effective, scoped to the effective project. */
  readonly effectiveTask: TaskLookupResult | null | undefined;
  /** Current workspace tags relevant to the source's tags (id -> current state). */
  readonly currentTags: ReadonlyMap<string, LookupResult>;
  readonly customFields: readonly CustomFieldDef[];
}

export interface PreflightInput {
  readonly source: DeletedTimeEntry;
  readonly viewer: Viewer;
  readonly choices: PreflightChoices;
  readonly workspace: WorkspaceState;
  /** Injected clock (P-LOCK-REG's 24-hour check) — keeps this module pure and testable. */
  readonly now: Date;
}

export interface PreflightResult {
  readonly resolution: PlanResolution[];
  readonly warnings: PlanWarning[];
  readonly blockers: PlanBlocker[];
  readonly actionRequired: ActionRequiredItem[];
  readonly plannedRequest: PlannedRequest;
  readonly fidelity: Fidelity;
}

function hasUsableValue(value: unknown): boolean {
  return value !== null && value !== undefined && value !== "";
}

export interface EffectiveIds {
  readonly effectiveProjectId: string | null;
  readonly effectiveTaskId: string | null;
  readonly projectChoiceProvided: boolean;
  readonly taskChoiceProvided: boolean;
  readonly projectSubstituted: boolean;
}

/** docs/07 §4: `projectId = choices.projectId ?? source.projectId`,
 * `taskId = choices.taskId ?? (project unchanged ? source.taskId : null)`. Shared by the pure
 * decision rules below and the I/O layer (src/clockify/preflight-data.ts), which needs to know
 * exactly which project/task to look up — one derivation, no duplicated business logic. */
export function resolveEffectiveIds(
  source: Pick<DeletedTimeEntry, "projectId" | "taskId">,
  choices: Pick<PreflightChoices, "projectId" | "taskId">,
): EffectiveIds {
  const projectChoiceProvided = choices.projectId !== undefined;
  const effectiveProjectId = (projectChoiceProvided ? choices.projectId : source.projectId) ?? null;
  const projectSubstituted = projectChoiceProvided && effectiveProjectId !== source.projectId;
  const taskChoiceProvided = choices.taskId !== undefined;
  const effectiveTaskId =
    (taskChoiceProvided ? choices.taskId : projectSubstituted ? null : source.taskId) ?? null;
  return { effectiveProjectId, effectiveTaskId, projectChoiceProvided, taskChoiceProvided, projectSubstituted };
}

export function runPreflight(input: PreflightInput): PreflightResult {
  const { source, viewer, choices, workspace, now } = input;
  const resolution: PlanResolution[] = [];
  const warnings: PlanWarning[] = [];
  const blockers: PlanBlocker[] = [];
  const actionRequired: ActionRequiredItem[] = [];
  let hasAdjustment = false;
  let hasPartialLoss = false;

  // P-PERM (defense in depth — the API layer already filters this before preflight runs).
  if (!isAdmin(viewer) && viewer.userId !== source.ownerId) {
    blockers.push({ ruleId: "P-PERM", code: "NOT_PERMITTED", message: "You cannot recreate another user's entry." });
  }

  // P-TYPE
  if (source.type !== "REGULAR") {
    blockers.push({
      ruleId: "P-TYPE",
      code: "TYPE_NOT_SUPPORTED",
      message: "RestoreTime recreates regular time entries only.",
    });
  }

  // P-OWNER
  if (workspace.ownerStatus === null || workspace.ownerStatus !== "ACTIVE") {
    blockers.push({
      ruleId: "P-OWNER",
      code: "OWNER_UNAVAILABLE",
      message: `${source.ownerName || "The entry owner"} is not an active workspace member.`,
    });
  }

  // P-RUN / P-RUN-END: determine the effective mode.
  let mode: "running" | "completed";
  let effectiveEnd: string | undefined;
  let modeResolved = true;
  if (source.wasRunning) {
    if (choices.runningMode === undefined) {
      modeResolved = false;
      mode = "completed"; // placeholder; unused while unresolved
      actionRequired.push({
        ruleId: "P-RUN",
        message:
          "Choose how to recreate this timer: as a running timer, or with an end time. " +
          "A running timer replaces any timer the owner has running now.",
        options: ["running", "completed"],
      });
    } else if (choices.runningMode === "running") {
      mode = "running";
    } else {
      mode = "completed";
      if (choices.completedEnd === undefined || choices.completedEnd <= source.start) {
        modeResolved = false;
        actionRequired.push({ ruleId: "P-RUN-END", message: "Enter an end time after the start time." });
      } else {
        effectiveEnd = choices.completedEnd;
        hasAdjustment = true; // an end time set on a running source
        resolution.push({ kind: "runningMode", refId: null, outcome: "substituted", detail: "completed" });
      }
    }
  } else {
    mode = "completed";
    effectiveEnd = source.end ?? undefined;
  }
  if (mode === "running") {
    resolution.push({ kind: "runningMode", refId: null, outcome: "kept", detail: "running" });
  }

  // P-TIMER (only checkable once we know whether an end will be sent).
  if (modeResolved && mode === "completed" && workspace.timeTrackingMode === "STOPWATCH_ONLY" && !isAdmin(viewer)) {
    blockers.push({
      ruleId: "P-TIMER",
      code: "TIMER_REQUIRED",
      message: "This workspace requires a timer for manual entries. An admin can recreate this entry.",
    });
  }

  // --- Project ---
  const { effectiveProjectId, effectiveTaskId, projectChoiceProvided, taskChoiceProvided, projectSubstituted } =
    resolveEffectiveIds(source, choices);

  if (effectiveProjectId === null || effectiveProjectId === undefined) {
    resolution.push({
      kind: "project",
      refId: null,
      outcome: projectChoiceProvided ? "dropped" : "kept",
    });
    if (workspace.forceProjects && modeResolved && mode === "completed") {
      actionRequired.push({ ruleId: "P-PROJ-REQ", message: "Select a project." });
    }
  } else if (workspace.effectiveProject === null || workspace.effectiveProject === undefined) {
    actionRequired.push({
      ruleId: "P-PROJ-GONE",
      message: workspace.forceProjects
        ? "The original project no longer exists. Select a replacement project."
        : "The original project no longer exists. Select a replacement project, or remove the project.",
      ...(workspace.forceProjects ? {} : { options: ["replace", "remove"] as const }),
    });
  } else {
    resolution.push({
      kind: "project",
      refId: effectiveProjectId,
      outcome: projectChoiceProvided ? "substituted" : "kept",
    });
    if (projectChoiceProvided) hasAdjustment = true;
    if (workspace.effectiveProject.archived) {
      warnings.push({ ruleId: "P-PROJ-ARCH", code: "ARCHIVED_PROJECT", message: "The project is archived. Clockify still allows recreation." });
    }
  }

  // --- Task ---
  if (taskChoiceProvided && choices.taskId === null && workspace.forceTasks) {
    actionRequired.push({ ruleId: "P-TASK-GONE", message: "This workspace requires a task. Select a replacement task." });
  } else if (effectiveTaskId === null || effectiveTaskId === undefined) {
    const droppedByProjectChange = projectSubstituted && !taskChoiceProvided && source.taskId !== null;
    resolution.push({
      kind: "task",
      refId: null,
      outcome: source.taskId === null ? "kept" : "dropped",
      ...(droppedByProjectChange ? { detail: "project changed" } : {}),
    });
    if (droppedByProjectChange) hasAdjustment = true;
  } else if (
    workspace.effectiveTask === null ||
    workspace.effectiveTask === undefined ||
    workspace.effectiveTask.status !== "ACTIVE"
  ) {
    actionRequired.push({
      ruleId: "P-TASK-GONE",
      message: workspace.forceTasks
        ? "The original task is unavailable. Select a replacement task."
        : "The original task is unavailable. Select a replacement task, or remove the task.",
      ...(workspace.forceTasks ? {} : { options: ["replace", "remove"] as const }),
    });
  } else {
    resolution.push({
      kind: "task",
      refId: effectiveTaskId,
      outcome: taskChoiceProvided ? "substituted" : "kept",
    });
    if (taskChoiceProvided) hasAdjustment = true;
  }

  // --- Tags ---
  const dropTagIds = new Set(choices.dropTagIds ?? []);
  const addTagIds = choices.addTagIds ?? [];
  const keptTagIds: string[] = [];
  let unresolvedTagIssues = 0;
  let appliedTagDrops = 0;

  for (const tag of source.tags) {
    if (dropTagIds.has(tag.id)) {
      resolution.push({ kind: "tag", refId: tag.id, outcome: "dropped" });
      appliedTagDrops += 1;
      continue;
    }
    const current = workspace.currentTags.get(tag.id);
    if (current === undefined) {
      unresolvedTagIssues += 1;
      actionRequired.push({
        ruleId: "P-TAG-GONE",
        message: `The tag "${tag.name}" no longer exists. Confirm removal, or add a current tag.`,
        options: ["remove"],
      });
    } else if (current.archived) {
      unresolvedTagIssues += 1;
      actionRequired.push({
        ruleId: "P-TAG-ARCH",
        message: `The tag "${tag.name}" is archived. Archived tags block recreation. Confirm removal, or add a current tag.`,
        options: ["remove"],
      });
    } else {
      keptTagIds.push(tag.id);
      resolution.push({ kind: "tag", refId: tag.id, outcome: "kept" });
    }
  }

  const effectiveTagIds = [...new Set([...keptTagIds, ...addTagIds])];
  if (addTagIds.length > 0) hasAdjustment = true;
  if (appliedTagDrops > 0) hasAdjustment = true;
  for (const id of addTagIds) resolution.push({ kind: "tag", refId: id, outcome: "substituted" });

  if (
    source.tags.length > 0 &&
    unresolvedTagIssues === 0 &&
    effectiveTagIds.length === 0 &&
    workspace.forceTags &&
    addTagIds.length === 0
  ) {
    actionRequired.push({ ruleId: "P-TAG-REQ", message: "This workspace requires at least one tag. Select a current tag." });
  }

  // --- Description ---
  const effectiveDescription = choices.description ?? source.description;
  if (choices.description !== undefined && choices.description !== source.description) hasAdjustment = true;
  if (workspace.forceDescription && effectiveDescription.length === 0) {
    actionRequired.push({ ruleId: "P-DESC", message: "This workspace requires a description. Enter a description." });
  }

  // --- Custom fields (P-CF-*) ---
  const plannedCustomFields: { customFieldId: string; sourceType: "WORKSPACE"; value: unknown }[] = [];
  const consideredFieldIds = new Set<string>();
  for (const field of workspace.customFields) {
    consideredFieldIds.add(field.id);
    const sourceEntry = source.customFieldValues.find((v) => v.customFieldId === field.id);
    const sourceValue = sourceEntry?.value ?? null;
    const dropped = (choices.dropCustomFieldIds ?? []).includes(field.id);
    const userInput = choices.customFieldInputs?.find((i) => i.customFieldId === field.id);

    if (!field.active) {
      if (hasUsableValue(sourceValue)) {
        warnings.push({ ruleId: "P-CF-GONE", code: "CF_FIELD_GONE", message: `The custom field "${field.id}" no longer exists. Its value is not sent.` });
        resolution.push({ kind: "customField", refId: field.id, outcome: "dropped", detail: "field inactive" });
        hasPartialLoss = true;
      }
      continue;
    }

    if (dropped) {
      resolution.push({ kind: "customField", refId: field.id, outcome: "dropped" });
      warnings.push({ ruleId: "P-CF-OPT", code: "CF_VALUE_DROPPED", message: `The value for "${field.id}" was dropped.` });
      hasPartialLoss = true;
      continue;
    }

    let effectiveValue: unknown = null;
    let fromUserInput = false;
    if (userInput !== undefined) {
      effectiveValue = userInput.value;
      fromUserInput = true;
    } else if (hasUsableValue(sourceValue)) {
      effectiveValue = sourceValue;
    }

    if (!hasUsableValue(effectiveValue) && field.required) {
      if (hasUsableValue(field.defaultValue)) {
        effectiveValue = field.defaultValue;
      } else {
        actionRequired.push({ ruleId: "P-CF-REQ", message: `"${field.id}" is required. Enter a value.` });
        continue;
      }
    }

    if (!hasUsableValue(effectiveValue)) {
      resolution.push({ kind: "customField", refId: field.id, outcome: "kept" });
      continue;
    }

    // P-CF-OPT: a dropdown value outside the current allowed options.
    if (
      field.type === "DROPDOWN_SINGLE" &&
      field.allowedValues !== null &&
      !field.allowedValues.includes(String(effectiveValue)) &&
      !fromUserInput
    ) {
      actionRequired.push({
        ruleId: "P-CF-OPT",
        message: `The value for "${field.id}" is no longer a valid option. Pick a current option, keep the original value, or drop it.`,
        options: ["replace", "keep", "drop"],
      });
      continue;
    }
    if (field.type === "DROPDOWN_SINGLE" && field.allowedValues !== null && fromUserInput && !field.allowedValues.includes(String(effectiveValue))) {
      warnings.push({ ruleId: "P-CF-OPT", code: "CF_OPTION_STALE", message: `The value for "${field.id}" is not a current option. Clockify still accepts it.` });
    }

    if (looselyEqual(effectiveValue, field.defaultValue)) {
      // P-CF-KEEP: equals the current default -> nothing sent, auto-attaches.
      resolution.push({ kind: "customField", refId: field.id, outcome: "kept" });
    } else {
      // P-CF-WRITE
      plannedCustomFields.push({ customFieldId: field.id, sourceType: "WORKSPACE", value: effectiveValue });
      resolution.push({ kind: "customField", refId: field.id, outcome: fromUserInput ? "substituted" : "kept" });
      if (fromUserInput) hasAdjustment = true;
    }
  }
  // Source values for fields that no longer exist in the workspace list at all.
  for (const item of source.customFieldValues) {
    if (consideredFieldIds.has(item.customFieldId)) continue;
    if (!hasUsableValue(item.value)) continue;
    warnings.push({ ruleId: "P-CF-GONE", code: "CF_FIELD_GONE", message: `The custom field "${item.customFieldId}" no longer exists. Its value is not sent.` });
    resolution.push({ kind: "customField", refId: item.customFieldId, outcome: "dropped", detail: "field missing" });
    hasPartialLoss = true;
  }

  // --- P-BILL ---
  if (
    (workspace.onlyAdminsCanChangeBillableStatus || workspace.defaultBillableProjects) &&
    !isAdmin(viewer) &&
    source.billable !== workspace.impliedBillable
  ) {
    warnings.push({
      ruleId: "P-BILL",
      code: "BILLABLE_MAY_CHANGE",
      message: "Clockify may change the billable status of this entry based on workspace settings.",
    });
  }

  // --- P-LOCK / P-LOCK-REG ---
  if (!isAdmin(viewer)) {
    const lockConfigured = workspace.lockTimeEntries !== null || workspace.automaticLockSet;
    const startAgeMs = now.getTime() - new Date(source.start).getTime();
    const twentyFourHoursMs = 24 * 60 * 60 * 1000;
    if (lockConfigured && startAgeMs >= twentyFourHoursMs) {
      warnings.push({
        ruleId: "P-LOCK-REG",
        code: "PERIOD_MAY_BE_LOCKED",
        message: "The entry's date may be in a locked period. An admin can recreate this entry, or unlock the period.",
      });
    }
  }

  // --- P-SYS ---
  warnings.push({
    ruleId: "P-SYS",
    code: "SYSTEM_DIFFERENCES",
    message:
      "The new entry gets a new ID and new timestamps. It is not part of any approval request, " +
      "has no invoice link, and uses current rates.",
  });

  const plannedRequest: PlannedRequest = {
    workspaceId: source.workspaceId,
    userId: source.ownerId,
    start: source.start,
    ...(mode === "completed" && modeResolved && effectiveEnd !== undefined ? { end: effectiveEnd } : {}),
    description: effectiveDescription,
    billable: source.billable,
    ...(effectiveProjectId !== null && effectiveProjectId !== undefined ? { projectId: effectiveProjectId } : {}),
    ...(effectiveTaskId !== null && effectiveTaskId !== undefined ? { taskId: effectiveTaskId } : {}),
    ...(effectiveTagIds.length > 0 ? { tagIds: effectiveTagIds } : {}),
    ...(plannedCustomFields.length > 0 ? { customFields: plannedCustomFields } : {}),
  };

  const fidelity = classifyFidelity({
    hasBlockers: blockers.length > 0,
    hasPartialLoss,
    hasAdjustment,
  });

  return { resolution, warnings, blockers, actionRequired, plannedRequest, fidelity };
}
