// The preflight data fetch (docs/07 §2): six lookups through the installation's Clockify client,
// assembled into the pure src/domain/preflight.ts `WorkspaceState` input. Every bounded list read
// uses `iterPages` (never `iterAll` — only `iterPages` can detect the page bound, docs/03 note 5).
//
// Split in two so `GET /api/entries` can share the four workspace-level lookups across every
// listed row and only repeat the two per-entry lookups (project, task) — "one fetch set per
// request, share across rows" (pass file API scope).

import { ClockifyApiError, iterPages, type ClockifyApi, type ClockifyClient } from "clockify-sdk-ts-115";
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

/**
 * Per-request memoization for the two per-row lookups (project, task) — PASS-04 performance fix.
 * `GET /api/entries` calls `fetchEntryWorkspaceState` once per listed row, concurrently, via
 * `Promise.all` (docs §Scope "list endpoint... without N+1"); rows sharing a `projectId` (the
 * overwhelmingly common case — a project has many entries) were each re-fetching the identical
 * project and task-list, an N+1 that turns fifty rows across ten projects into up to a hundred
 * Clockify calls. A cache keyed by `projectId` (and `projectId:taskId` for tasks) collapses that to
 * one call per distinct project.
 *
 * The cache stores the in-flight *promise*, not the resolved value: `Promise.all` starts every
 * row's lookup in the same microtask, before any of them has resolved, so a cache keyed on
 * resolved values would still let concurrent rows for the same project each miss the cache and
 * issue their own duplicate call (the dedupe would only work call-by-call, not under real
 * concurrency). Registering the promise synchronously, before its first `await`, is what makes a
 * second concurrent caller for the same key observe the first one's in-flight request instead of
 * starting a new one.
 *
 * Scoped to one caller-owned instance per request — never shared across requests or workspaces —
 * so a project that changes between two unrelated requests is never served stale.
 */
export interface ProjectTaskCache {
  readonly projects: Map<string, Promise<LookupResult | null | undefined>>;
  /** Keyed by `projectId` alone, not `projectId:taskId`: `tasks.list` returns every task for a
   * project in one call, so two rows in the same project with DIFFERENT task ids must still share
   * one `tasks.list` call, not issue one each. */
  readonly taskLists: Map<string, Promise<readonly ClockifyApi.Task[]>>;
}

export function createProjectTaskCache(): ProjectTaskCache {
  return { projects: new Map(), taskLists: new Map() };
}

function lookupProject(
  client: ClockifyClient,
  workspaceId: string,
  projectId: string | null,
  cache: ProjectTaskCache,
): Promise<LookupResult | null | undefined> {
  if (projectId === null) return Promise.resolve(undefined);
  const cached = cache.projects.get(projectId);
  if (cached) return cached;
  const promise = (async (): Promise<LookupResult | null> => {
    try {
      const project = await client.projects.get({ workspaceId, projectId });
      return { id: project.id, archived: project.archived };
    } catch (err) {
      if (isProjectGone(err)) return null;
      throw err;
    }
  })();
  cache.projects.set(projectId, promise);
  return promise;
}

function listTasksForProject(
  client: ClockifyClient,
  workspaceId: string,
  projectId: string,
  cache: ProjectTaskCache,
): Promise<readonly ClockifyApi.Task[]> {
  const cached = cache.taskLists.get(projectId);
  if (cached) return cached;
  const promise = collectPaged(client.tasks.list.bind(client.tasks), { workspaceId, projectId });
  cache.taskLists.set(projectId, promise);
  return promise;
}

async function lookupTask(
  client: ClockifyClient,
  workspaceId: string,
  projectId: string | null,
  taskId: string | null,
  cache: ProjectTaskCache,
): Promise<TaskLookupResult | null | undefined> {
  if (taskId === null || projectId === null) return taskId === null ? undefined : null;
  const tasks = await listTasksForProject(client, workspaceId, projectId, cache);
  const task = tasks.find((t) => t.id === taskId);
  return task ? { id: task.id, status: task.status } : null;
}

/** Assembles the pure `WorkspaceState` for one entry from already-fetched shared data plus this
 * entry's two per-row lookups (project, task). `cache` is optional so single-entry callers
 * (preflight, confirm's revalidation) keep their existing one-shot behavior unchanged; omitting it
 * is equivalent to a cache used exactly once. */
export async function fetchEntryWorkspaceState(
  client: ClockifyClient,
  workspaceId: string,
  shared: SharedWorkspaceData,
  source: DeletedTimeEntry,
  choices: PreflightChoices,
  cache: ProjectTaskCache = createProjectTaskCache(),
): Promise<WorkspaceState> {
  const { effectiveProjectId, effectiveTaskId } = resolveEffectiveIds(source, choices);
  const effectiveProject = await lookupProject(client, workspaceId, effectiveProjectId, cache);
  const effectiveTask = await lookupTask(client, workspaceId, effectiveProjectId, effectiveTaskId, cache);

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
