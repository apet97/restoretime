// The preflight data fetch (docs/07 §2): six lookups through the installation's Clockify client,
// assembled into the pure src/domain/preflight.ts `WorkspaceState` input. Every bounded list read
// uses `iterPages` (never `iterAll` — only `iterPages` can detect the page bound, docs/03 note 5).
//
// Split in two so `GET /api/entries` can share the four workspace-level lookups across every
// listed row and only repeat the two per-entry lookups (project, task) — "one fetch set per
// request, share across rows" (pass file API scope).

import { ClockifyApiError, iterPages, type ClockifyClient } from "clockify-sdk-ts-115";
import { clockifyErrorCode } from "./errors.js";
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

/** The one bounded list read. Every paginated Clockify read in the app goes through this so the
 * page bound is detected identically everywhere (docs/03 note 5) — a silently truncated picker is
 * exactly the kind of unreported partial result the design forbids. */
export async function collectPaged<TReq extends { page?: number; "page-size"?: number }, TItem>(
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

export interface SharedWorkspaceData {
  readonly forceProjects: boolean;
  readonly forceTasks: boolean;
  readonly forceTags: boolean;
  readonly forceDescription: boolean;
  readonly onlyAdminsCanChangeBillableStatus: boolean;
  readonly defaultBillableProjects: boolean;
  readonly timeTrackingMode: "DEFAULT" | "STOPWATCH_ONLY";
  readonly lockTimeEntries: string | null;
  readonly automaticLockSet: boolean;
  readonly users: ReadonlyMap<string, string>; // userId -> membership status
  readonly currentTags: ReadonlyMap<string, LookupResult>;
  readonly customFields: readonly CustomFieldDef[];
}

/** The four workspace-level lookups (settings, users, tags, custom fields) — identical for every
 * row in a single request. Fetch once, reuse for every entry. */
export async function fetchSharedWorkspaceData(client: ClockifyClient, workspaceId: string): Promise<SharedWorkspaceData> {
  const [workspace, users, tags, customFieldsRaw] = await Promise.all([
    client.workspaces.get({ workspaceId }),
    collectPaged(client.users.list.bind(client.users), { workspaceId, status: "ALL", "include-roles": false }),
    collectPaged(client.tags.list.bind(client.tags), { workspaceId }),
    collectPaged(client.customFields.listForWorkspace.bind(client.customFields), {
      workspaceId,
      "entity-type": ["TIMEENTRY"],
    }),
  ]);

  const settings = workspace.workspaceSettings;
  const currentTags = new Map<string, LookupResult>();
  for (const tag of tags) currentTags.set(tag.id, { id: tag.id, archived: tag.archived });
  const userStatus = new Map<string, string>();
  for (const u of users) if (u.id !== undefined) userStatus.set(u.id, u.status);

  const customFields: CustomFieldDef[] = customFieldsRaw
    .filter((f): f is typeof f & { id: string } => f.id !== undefined)
    .map((f) => ({
      id: f.id,
      name: f.name ?? f.id,
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
    timeTrackingMode: settings?.timeTrackingMode ?? "DEFAULT",
    lockTimeEntries: settings?.lockTimeEntries ?? null,
    automaticLockSet: settings?.automaticLock !== undefined,
    users: userStatus,
    currentTags,
    customFields,
  };
}

/**
 * A project that no longer exists is reported two different ways, and only one of them is a 404.
 * Live-probed on 2026-08-08 (evidence/error-shapes-2026-08-08.md): a project that was created,
 * archived, and deleted reads back as `400 {"message":"Project doesn't belong to Workspace",
 * "code":501}`, exactly like an id that never existed. Treating 404 alone as "gone" — which is
 * what docs/03 §2 originally said — would send every deleted-project recreation down the "Clockify
 * could not be reached" path instead of P-PROJ-GONE's replacement picker (R24).
 *
 * The mapping is scoped to this one lookup on purpose. Body code `501` covers several unrelated
 * validation failures elsewhere (R15, R18), but this request carries only `workspaceId` and
 * `projectId`, so "doesn't belong to Workspace" has exactly one cause here. Everything else
 * re-throws and fails the preflight honestly.
 */
function isProjectGone(err: unknown): boolean {
  if (!(err instanceof ClockifyApiError)) return false;
  if (err.statusCode === 404) return true;
  return err.statusCode === 400 && clockifyErrorCode(err) === "501";
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
    if (isProjectGone(err)) return null;
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

/** Assembles the pure `WorkspaceState` for one entry from already-fetched shared data plus this
 * entry's two per-row lookups (project, task). */
export async function fetchEntryWorkspaceState(
  client: ClockifyClient,
  workspaceId: string,
  shared: SharedWorkspaceData,
  source: DeletedTimeEntry,
  choices: PreflightChoices,
): Promise<WorkspaceState> {
  const { effectiveProjectId, effectiveTaskId } = resolveEffectiveIds(source, choices);
  const effectiveProject = await lookupProject(client, workspaceId, effectiveProjectId);
  const effectiveTask = await lookupTask(client, workspaceId, effectiveProjectId, effectiveTaskId);

  return {
    forceProjects: shared.forceProjects,
    forceTasks: shared.forceTasks,
    forceTags: shared.forceTags,
    forceDescription: shared.forceDescription,
    onlyAdminsCanChangeBillableStatus: shared.onlyAdminsCanChangeBillableStatus,
    defaultBillableProjects: shared.defaultBillableProjects,
    impliedBillable: shared.defaultBillableProjects,
    timeTrackingMode: shared.timeTrackingMode,
    lockTimeEntries: shared.lockTimeEntries,
    automaticLockSet: shared.automaticLockSet,
    ownerStatus: shared.users.get(source.ownerId) ?? null,
    effectiveProject,
    effectiveTask,
    currentTags: shared.currentTags,
    customFields: shared.customFields,
  };
}

/** Convenience wrapper for a single-entry preflight call (fetches shared + per-row data
 * together). `GET /api/entries` uses `fetchSharedWorkspaceData` + `fetchEntryWorkspaceState`
 * directly instead, to share the four workspace-level lookups across every row. */
export async function fetchWorkspaceState(
  client: ClockifyClient,
  workspaceId: string,
  source: DeletedTimeEntry,
  choices: PreflightChoices,
): Promise<WorkspaceState> {
  const shared = await fetchSharedWorkspaceData(client, workspaceId);
  return fetchEntryWorkspaceState(client, workspaceId, shared, source, choices);
}
