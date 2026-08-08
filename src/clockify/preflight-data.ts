// The preflight data fetch (docs/07 §2): six lookups through the installation's Clockify client,
// assembled into the pure src/domain/preflight.ts `WorkspaceState` input. Every bounded list read
// uses `iterPages` (never `iterAll` — only `iterPages` can detect the page bound, docs/03 note 5).

import { ClockifyApiError, iterPages, type ClockifyClient } from "clockify-sdk-ts-115";
import type { DeletedTimeEntry, PreflightChoices } from "../domain/entry.js";
import { resolveEffectiveIds, type CustomFieldDef, type LookupResult, type TaskLookupResult, type WorkspaceState } from "../domain/preflight.js";

const PAGE_SIZE = 200;
const MAX_PAGES = 10;

/** Thrown when a bounded list read hits the page bound (docs/03 note 5, docs/07 §2): "workspace
 * too large to verify" — never a partial/guessed result. */
export class PreflightTruncatedError extends Error {
  constructor() {
    super("workspace too large to verify; try again");
  }
}

async function collectPaged<TReq extends { page?: number; "page-size"?: number }, TItem>(
  fetcher: (request: TReq) => PromiseLike<readonly TItem[]>,
  baseRequest: Omit<TReq, "page" | "page-size">,
): Promise<TItem[]> {
  const items: TItem[] = [];
  let truncated = false;
  for await (const page of iterPages(fetcher, baseRequest, { pageSize: PAGE_SIZE, maxPages: MAX_PAGES })) {
    items.push(...page.items);
    if (page.page === MAX_PAGES && page.hasNextPage) truncated = true;
  }
  if (truncated) throw new PreflightTruncatedError();
  return items;
}

async function lookupProject(
  client: ClockifyClient,
  workspaceId: string,
  projectId: string | null,
): Promise<LookupResult | null | undefined> {
  if (projectId === null) return undefined;
  try {
    const project = await client.projects.get({ workspaceId, projectId });
    return { id: project.id, archived: project.archived };
  } catch (err) {
    if (err instanceof ClockifyApiError && err.statusCode === 404) return null;
    throw err;
  }
}

async function lookupTask(
  client: ClockifyClient,
  workspaceId: string,
  projectId: string | null,
  taskId: string | null,
): Promise<TaskLookupResult | null | undefined> {
  if (taskId === null || projectId === null) return taskId === null ? undefined : null;
  const tasks = await collectPaged(client.tasks.list.bind(client.tasks), { workspaceId, projectId });
  const task = tasks.find((t) => t.id === taskId);
  return task ? { id: task.id, status: task.status } : null;
}

/** Fetches the six lookups in parallel and assembles `WorkspaceState`. `impliedBillable` follows
 * `defaultBillableProjects` — the workspace-level flag that governs a new entry's default
 * billable status server-side (R12). */
export async function fetchWorkspaceState(
  client: ClockifyClient,
  workspaceId: string,
  source: DeletedTimeEntry,
  choices: PreflightChoices,
): Promise<WorkspaceState> {
  const { effectiveProjectId, effectiveTaskId } = resolveEffectiveIds(source, choices);

  const [workspace, users, tags, customFieldsRaw, effectiveProject] = await Promise.all([
    client.workspaces.get({ workspaceId }),
    collectPaged(client.users.list.bind(client.users), {
      workspaceId,
      status: "ALL",
      "include-roles": false,
    }),
    collectPaged(client.tags.list.bind(client.tags), { workspaceId }),
    collectPaged(client.customFields.listForWorkspace.bind(client.customFields), {
      workspaceId,
      "entity-type": ["TIMEENTRY"],
    }),
    lookupProject(client, workspaceId, effectiveProjectId),
  ]);
  const effectiveTask = await lookupTask(client, workspaceId, effectiveProjectId, effectiveTaskId);

  const settings = workspace.workspaceSettings;
  const owner = users.find((u) => u.id === source.ownerId);

  const currentTags = new Map<string, LookupResult>();
  for (const tag of tags) currentTags.set(tag.id, { id: tag.id, archived: tag.archived });

  const customFields: CustomFieldDef[] = customFieldsRaw
    .filter((f): f is typeof f & { id: string } => f.id !== undefined)
    .map((f) => ({
      id: f.id,
      active: f.status !== "INACTIVE",
      required: f.required ?? false,
      type: f.type ?? "TXT",
      allowedValues: f.allowedValues ?? null,
      defaultValue: f.workspaceDefaultValue ?? null,
    }));

  return {
    forceProjects: settings?.forceProjects ?? false,
    forceTasks: settings?.forceTasks ?? false,
    forceTags: settings?.forceTags ?? false,
    forceDescription: settings?.forceDescription ?? false,
    onlyAdminsCanChangeBillableStatus: settings?.onlyAdminsCanChangeBillableStatus ?? false,
    defaultBillableProjects: settings?.defaultBillableProjects ?? false,
    impliedBillable: settings?.defaultBillableProjects ?? source.billable,
    timeTrackingMode: settings?.timeTrackingMode ?? "DEFAULT",
    lockTimeEntries: settings?.lockTimeEntries ?? null,
    automaticLockSet: settings?.automaticLock !== undefined,
    ownerStatus: owner?.status ?? null,
    effectiveProject,
    effectiveTask,
    currentTags,
    customFields,
  };
}
