// Hand-rolled guard + normalization for the TIME_ENTRY_DELETED webhook body (docs/03 §1, docs/06).
// No third-party validation library (implementation/DEPENDENCIES.md). The guard rejects a
// malformed body with a reason; normalize() only ever runs on a body the guard accepted.

import type { DeletedTimeEntry } from "../domain/entry.js";

interface RawTag {
  readonly id: string;
  readonly name: string;
}

interface RawCustomFieldValue {
  readonly customFieldId: string;
  readonly name: string;
  readonly value: unknown;
}

/** The subset of the flat webhook body this app reads (docs/03 §1 normalization input rules). */
export interface RawDeletedEntryPayload {
  readonly id: string;
  readonly workspaceId: string;
  readonly userId: string;
  readonly description: string;
  readonly billable: boolean;
  readonly projectId: string | null;
  readonly type: string;
  readonly currentlyRunning: boolean;
  readonly timeInterval: {
    readonly start: string;
    readonly end: string | null;
    readonly timeZone: string | null;
  };
  readonly project: { readonly name: string; readonly clientName: string | null } | null;
  readonly task: { readonly id: string; readonly name: string } | null;
  readonly tags: readonly RawTag[];
  readonly user: { readonly name: string } | null;
  readonly customFieldValues: readonly RawCustomFieldValue[];
}

export type GuardResult =
  | { readonly ok: true; readonly payload: RawDeletedEntryPayload }
  | { readonly ok: false; readonly reason: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

/** Rejects a body missing required fields or carrying the wrong type for one (UT-N01). Accepts
 * everything else — unknown extra fields are ignored, matching the webhook's "flat superset"
 * shape (W1). */
export function guardDeletedEntryPayload(body: unknown): GuardResult {
  if (!isRecord(body)) return { ok: false, reason: "body is not an object" };

  if (!isNonEmptyString(body.id)) return { ok: false, reason: "missing or invalid id" };
  if (!isNonEmptyString(body.workspaceId)) {
    return { ok: false, reason: "missing or invalid workspaceId" };
  }
  if (!isNonEmptyString(body.userId)) return { ok: false, reason: "missing or invalid userId" };
  if (typeof body.description !== "string") {
    return { ok: false, reason: "missing or invalid description" };
  }
  if (typeof body.billable !== "boolean") {
    return { ok: false, reason: "missing or invalid billable" };
  }
  if (typeof body.type !== "string" || body.type.length === 0) {
    return { ok: false, reason: "missing or invalid type" };
  }
  if (typeof body.currentlyRunning !== "boolean") {
    return { ok: false, reason: "missing or invalid currentlyRunning" };
  }
  if (
    body.projectId !== null &&
    body.projectId !== undefined &&
    typeof body.projectId !== "string"
  ) {
    return { ok: false, reason: "invalid projectId" };
  }

  const timeInterval = body.timeInterval;
  if (!isRecord(timeInterval) || !isNonEmptyString(timeInterval.start)) {
    return { ok: false, reason: "missing or invalid timeInterval.start" };
  }
  if (
    timeInterval.end !== null &&
    timeInterval.end !== undefined &&
    typeof timeInterval.end !== "string"
  ) {
    return { ok: false, reason: "invalid timeInterval.end" };
  }
  if (
    timeInterval.timeZone !== null &&
    timeInterval.timeZone !== undefined &&
    typeof timeInterval.timeZone !== "string"
  ) {
    return { ok: false, reason: "invalid timeInterval.timeZone" };
  }

  const project = body.project;
  if (project !== null && project !== undefined) {
    if (!isRecord(project) || typeof project.name !== "string") {
      return { ok: false, reason: "invalid project" };
    }
    if (
      project.clientName !== null &&
      project.clientName !== undefined &&
      typeof project.clientName !== "string"
    ) {
      return { ok: false, reason: "invalid project.clientName" };
    }
  }

  const task = body.task;
  if (task !== null && task !== undefined) {
    if (!isRecord(task) || !isNonEmptyString(task.id) || typeof task.name !== "string") {
      return { ok: false, reason: "invalid task" };
    }
  }

  const tags = body.tags;
  if (tags !== undefined) {
    if (!Array.isArray(tags)) return { ok: false, reason: "invalid tags" };
    for (const tag of tags) {
      if (!isRecord(tag) || !isNonEmptyString(tag.id) || typeof tag.name !== "string") {
        return { ok: false, reason: "invalid tags item" };
      }
    }
  }

  const user = body.user;
  if (user !== null && user !== undefined) {
    if (!isRecord(user) || typeof user.name !== "string") {
      return { ok: false, reason: "invalid user" };
    }
  }

  const customFieldValues = body.customFieldValues;
  if (customFieldValues !== undefined) {
    if (!Array.isArray(customFieldValues)) {
      return { ok: false, reason: "invalid customFieldValues" };
    }
    for (const item of customFieldValues) {
      if (!isRecord(item) || !isNonEmptyString(item.customFieldId) || typeof item.name !== "string") {
        return { ok: false, reason: "invalid customFieldValues item" };
      }
    }
  }

  return {
    ok: true,
    payload: {
      id: body.id,
      workspaceId: body.workspaceId,
      userId: body.userId,
      description: body.description,
      billable: body.billable,
      projectId: typeof body.projectId === "string" ? body.projectId : null,
      type: body.type,
      currentlyRunning: body.currentlyRunning,
      timeInterval: {
        start: timeInterval.start,
        end: typeof timeInterval.end === "string" ? timeInterval.end : null,
        timeZone: typeof timeInterval.timeZone === "string" ? timeInterval.timeZone : null,
      },
      project: isRecord(project)
        ? {
            name: project.name as string,
            clientName: typeof project.clientName === "string" ? project.clientName : null,
          }
        : null,
      task: isRecord(task) ? { id: task.id as string, name: task.name as string } : null,
      tags: Array.isArray(tags)
        ? tags.map((tag) => ({ id: (tag as RawTag).id, name: (tag as RawTag).name }))
        : [],
      user: isRecord(user) ? { name: user.name as string } : null,
      customFieldValues: Array.isArray(customFieldValues)
        ? customFieldValues.map((item) => {
            const value = item as RawCustomFieldValue;
            return { customFieldId: value.customFieldId, name: value.name, value: value.value };
          })
        : [],
    },
  };
}

/** Flat webhook payload -> DeletedTimeEntry (docs/06). `wasRunning` reads `currentlyRunning`
 * directly — never inferred from `end === null` — because an auto-stopped entry deletes with
 * `currentlyRunning:false` and a normal `end` (W12); inferring from `end` would mislabel it. */
export function normalizeDeletedEntry(payload: RawDeletedEntryPayload): DeletedTimeEntry {
  return {
    workspaceId: payload.workspaceId,
    entryId: payload.id,
    ownerId: payload.userId,
    ownerName: payload.user?.name ?? "",
    description: payload.description,
    billable: payload.billable,
    start: payload.timeInterval.start,
    end: payload.timeInterval.end,
    wasRunning: payload.currentlyRunning,
    type: payload.type,
    timeZone: payload.timeInterval.timeZone,
    projectId: payload.projectId,
    projectName: payload.project?.name ?? null,
    clientName: payload.project?.clientName ?? null,
    taskId: payload.task?.id ?? null,
    taskName: payload.task?.name ?? null,
    tags: payload.tags.map((tag) => ({ id: tag.id, name: tag.name })),
    customFieldValues: payload.customFieldValues.map((item) => ({
      customFieldId: item.customFieldId,
      name: item.name,
      value: item.value,
    })),
  };
}
