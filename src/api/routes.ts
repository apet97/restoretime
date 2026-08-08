// /api/* routes (docs/03 §5, docs/09). Every route is `requireViewer`-guarded; identity and
// workspace scope come only from verified claims. `entryId` is a resource selector carried in the
// body (POST) or query (GET), never identity.

import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import type { RequestHandler } from "@apet97/clockify-addon-sdk";
import {
  createClockifyJsonResponse,
  type ClockifyInstallationStore,
  type ClockifySignatureParser,
} from "@apet97/clockify-addon-sdk/clockify";
import { requireViewer, type Viewer } from "../platform/verify.js";
import { checkEntryAccess } from "./access.js";
import { canAct, isAdmin } from "../domain/policy.js";
import { runPreflight } from "../domain/preflight.js";
import { classifyFidelity } from "../domain/fidelity.js";
import { isPlanUsable, outcomesDiffer, sourceHash as computeSourceHash } from "../domain/plan.js";
import type { PreflightChoices, RecoverableEntry, RecreationPlan } from "../domain/entry.js";
import * as entries from "../store/entries.js";
import * as plans from "../store/plans.js";
import * as attempts from "../store/attempts.js";
import { buildClockifyClient } from "../clockify/client.js";
import { fetchSharedWorkspaceData, fetchEntryWorkspaceState, collectPaged, createProjectTaskCache, PreflightTruncatedError, type SharedWorkspaceData } from "../clockify/preflight-data.js";
import {
  attemptRecreation,
  runReconcile,
  fingerprintFromPlanned,
  fingerprintMatches,
  diffPlannedVsActual,
  BaselineTruncatedError,
  VERIFICATION_READ_UNAVAILABLE,
} from "../clockify/recreate.js";
import { isAddonTokenInvalid } from "../clockify/errors.js";
import { getInstallationStatus, markInstallationBroken } from "../platform/installations.js";
import type { Logger } from "../log.js";
import { emitMetric } from "../metrics.js";

const RECONCILE_THROTTLE_MS = 30_000;
const MARK_NOT_CREATED_MIN_CHECKS = 3;
const MARK_NOT_CREATED_WINDOW_MS = 10 * 60 * 1000;

// User-facing failure text (docs/02 N8, docs/10 §8): every one answers what happened, whether
// anything was created, and what to do next. `renderApiError` (src/ui/views/shared.ts) shows these
// strings verbatim, so the sentence has to carry the whole answer — a "Try again" button alone
// does not tell a user whether a mutation might already be in flight.
const NO_CLIENT_MESSAGE =
  "RestoreTime is not connected to this workspace's Clockify account. Nothing was created. Reinstall the addon from the Clockify Marketplace, then try again.";
const TRANSPORT_FAILURE_MESSAGE = "Clockify could not be reached. Nothing was created. Try again in a moment.";
/** Distinct from `TRANSPORT_FAILURE_MESSAGE` on purpose: this is `confirmPlan`'s "attempt-error"
 * outcome (docs/07 §8, ADR-007) — a thrown error escaped the create attempt itself, so unlike a
 * read failure, whether Clockify actually created the entry is unknown. Telling the user "nothing
 * was created, try again" here would be a guess, and a wrong one could read as an invitation to
 * blindly retry a mutation that may already have gone through — exactly what ADR-007 forbids. */
const ATTEMPT_UNKNOWN_MESSAGE =
  "RestoreTime sent this recreation to Clockify but did not get a clear answer. It is not yet known whether the entry was created. Do not create it by hand — wait a moment, then open this entry again to check its status.";

interface HandlerRegistrar {
  registerHandler(path: string, method: string, handler: RequestHandler): void;
}

export interface ApiRouteDeps {
  readonly db: Database.Database;
  readonly installations: ClockifyInstallationStore;
  readonly logger: Logger;
  readonly onError?: (error: unknown, context: { route: string }) => void;
}

function json(status: number, body: unknown): ReturnType<RequestHandler> {
  return createClockifyJsonResponse(body as object | null, { status });
}

function errorJson(status: number, error: string): ReturnType<RequestHandler> {
  return json(status, { error });
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function loadClient(deps: ApiRouteDeps, viewer: Viewer) {
  const installation = await deps.installations.load(viewer.workspaceId, viewer.addonId);
  if (!installation) return undefined;
  return { installation, client: buildClockifyClient(installation) };
}

/** docs/03 §6: a 401 body code "4017" means the installation's own token is rejected. Record it as
 * `broken_at`, not as status INACTIVE — the component has to tell the user to reinstall, which it
 * cannot do if a broken installation is indistinguishable from one the user disabled. */
function markInstallationBrokenOnAddonTokenFailure(deps: ApiRouteDeps, viewer: Viewer) {
  return () => markInstallationBroken(deps.db, viewer.workspaceId, viewer.addonId, new Date().toISOString());
}

/** Row lookup scoped by claims workspace + id (docs/09), then canRead/canAct. */
function loadOwnEntry(
  deps: ApiRouteDeps,
  viewer: Viewer,
  entryId: unknown,
  requireAct: boolean,
  deniedIsForbidden = false,
): { entry: RecoverableEntry } | { error: ReturnType<RequestHandler> } {
  if (typeof entryId !== "string" || entryId.length === 0) {
    return { error: errorJson(400, "entryId is required") };
  }
  const row = entries.getById(deps.db, viewer.workspaceId, entryId);
  const access = checkEntryAccess(row, viewer, deniedIsForbidden);
  if (access.kind === "not-found") {
    emitMetric(deps.logger, "authz_denied", { reason: "not-found" });
    return { error: errorJson(404, "not found") };
  }
  if (access.kind === "forbidden") {
    emitMetric(deps.logger, "authz_denied", { reason: "forbidden" });
    return { error: errorJson(403, "forbidden") };
  }
  if (requireAct && !canAct(access.entry, viewer)) {
    emitMetric(deps.logger, "authz_denied", { reason: "cannot-act" });
    return { error: errorJson(404, "not found") };
  }
  return { entry: access.entry };
}

const LIFECYCLE_STATES = ["IDLE", "RECREATING", "RECREATED", "FAILED", "AMBIGUOUS", "DISMISSED"] as const;
type LifecycleState = (typeof LIFECYCLE_STATES)[number];

/** docs/09: admin filters are validated, never trusted. An unknown `status` is dropped rather than
 * cast into the query, where it would silently match nothing and read as "no entries exist". */
function isLifecycleState(value: string): value is LifecycleState {
  return (LIFECYCLE_STATES as readonly string[]).includes(value);
}

function preflightSummary(fidelity: ReturnType<typeof classifyFidelity>, blockerCount: number, actionRequiredCount: number) {
  return { fidelity, blockerCount, actionRequiredCount };
}

/** docs/14 metrics: fired once per preflight the USER asked for — the single-entry preflight route
 * and each entry of a bulk preflight.
 *
 * Deliberately NOT fired from the two internal `runPreflight` call sites: the per-row summaries in
 * `GET /api/entries` (which would count one blocker per list render, so a user refreshing a list
 * would inflate the counter without anything happening) and the revalidation inside confirm (which
 * re-derives an already-counted result). The counters measure user-visible preflight outcomes, not
 * invocations of the function. */
function emitPreflightMetrics(logger: Logger, result: { readonly blockers: readonly unknown[]; readonly actionRequired: readonly unknown[] }): void {
  if (result.blockers.length > 0) emitMetric(logger, "preflight_blockers", { count: result.blockers.length });
  if (result.actionRequired.length > 0) emitMetric(logger, "preflight_action_required", { count: result.actionRequired.length });
}

// --- GET /api/entries ------------------------------------------------------------------

async function handleListEntries(deps: ApiRouteDeps, viewer: Viewer, query: URLSearchParams) {
  const adminUserId = isAdmin(viewer) ? query.get("userId") : null;
  const projectId = query.get("projectId");
  const from = query.get("from");
  const to = query.get("to");
  const status = query.get("status");
  const search = query.get("search");

  const filters: entries.ListFilters = {
    // non-admin: never widen the workspace scope — always the viewer's own entries.
    ...(!isAdmin(viewer) ? { ownerId: viewer.userId } : {}),
    ...(adminUserId ? { userId: adminUserId } : {}),
    ...(projectId ? { projectId } : {}),
    ...(from ? { from } : {}),
    ...(to ? { to } : {}),
    ...(status && isLifecycleState(status) ? { status } : {}),
    ...(search ? { search } : {}),
    ...(query.get("dismissed") === "true" ? { dismissed: true } : {}),
  };

  const rows = entries.list(deps.db, viewer.workspaceId, filters);

  let shared: SharedWorkspaceData | undefined;
  let clockifyUnavailable = false;
  const clientResult = await loadClient(deps, viewer);
  if (clientResult) {
    try {
      shared = await fetchSharedWorkspaceData(clientResult.client, viewer.workspaceId);
    } catch {
      clockifyUnavailable = true;
    }
  } else {
    clockifyUnavailable = true;
  }

  // One project/task cache for the whole request (PASS-04 perf fix): rows sharing a `projectId`
  // reuse the same lookup instead of each re-fetching it — "one lookup set per request, not per
  // row" (pass file scope).
  const projectTaskCache = createProjectTaskCache();
  const summaries = await Promise.all(
    rows.map(async (row) => {
      const actionable = row.lifecycleState === "IDLE" || row.lifecycleState === "FAILED";
      let summary: ReturnType<typeof preflightSummary> | null = null;
      if (actionable && shared && clientResult) {
        try {
          const state = await fetchEntryWorkspaceState(clientResult.client, viewer.workspaceId, shared, row.source, {}, projectTaskCache);
          const result = runPreflight({ source: row.source, viewer, choices: {}, workspace: state, now: new Date() });
          summary = preflightSummary(result.fidelity, result.blockers.length, result.actionRequired.length);
        } catch {
          summary = null;
        }
      }
      return { ...row, preflightSummary: summary };
    }),
  );

  // docs/10 §8 "disabled addon" notice: STATUS_CHANGED -> INACTIVE keeps the workspace's data (it
  // can be re-enabled), so the list still returns rows; the shell replaces actions with a notice.
  const installationStatus = getInstallationStatus(deps.db, viewer.workspaceId, viewer.addonId);
  return json(200, { entries: summaries, clockifyUnavailable, disabled: installationStatus === "INACTIVE" });
}

// --- GET /api/entries/detail -------------------------------------------------------------

async function handleDetail(deps: ApiRouteDeps, viewer: Viewer, query: URLSearchParams) {
  const loaded = loadOwnEntry(deps, viewer, query.get("id"), false);
  if ("error" in loaded) return loaded.error;
  let entry = loaded.entry;

  // Lazy reconcile (ADR-010): a detail view on an AMBIGUOUS row triggers one reconcile pass when
  // the last check is older than 30 s.
  if (entry.lifecycleState === "AMBIGUOUS") {
    const latestAttempt = attempts.latestForEntry(deps.db, entry.id);
    const lastCheckedAt = latestAttempt?.reconcile?.checkedAt;
    const stale = lastCheckedAt === undefined || Date.now() - new Date(lastCheckedAt).getTime() > RECONCILE_THROTTLE_MS;
    if (stale && latestAttempt) {
      const clientResult = await loadClient(deps, viewer);
      const plan = plans.getById(deps.db, latestAttempt.planId);
      if (clientResult && plan) {
        try {
          await runOneReconcile(deps, clientResult.client, entry, latestAttempt, plan, viewer.userId);
          entry = entries.getById(deps.db, viewer.workspaceId, entry.id) ?? entry;
        } catch {
          // Best-effort: the detail view still renders with the pre-reconcile state.
        }
      }
    }
  }

  const plan = plans.getActiveForEntry(deps.db, entry.id) ?? plans.listForEntry(deps.db, entry.id)[0] ?? null;
  const attemptRows = attempts.listForEntry(deps.db, entry.id);
  const parent = entry.parentRecoverableId ? entries.getById(deps.db, viewer.workspaceId, entry.parentRecoverableId) : null;
  const child = entry.newEntryId ? entries.findByNewEntryId(deps.db, viewer.workspaceId, entry.newEntryId) : undefined;

  // Both flags are server facts the UI renders rather than derives (docs/00: "the UI holds no
  // business rules"). `canMarkNotCreated` in particular must never be recomputed on the browser
  // clock: a fast clock would offer "it was not created" for an entry that exists.
  const latestAttempt = attempts.latestForEntry(deps.db, entry.id);
  return json(200, {
    entry,
    plan,
    attempts: attemptRows,
    lineage: { parent: parent ?? null, child: child ?? null },
    disabled: getInstallationStatus(deps.db, viewer.workspaceId, viewer.addonId) === "INACTIVE",
    canMarkNotCreated: entry.lifecycleState === "AMBIGUOUS" && markNotCreatedAllowed(latestAttempt),
  });
}

/** docs/07 §8: "a row whose latest reconcile is older than 10 minutes and has had >= 3 checks".
 * One definition, used by the gate in `handleMarkNotCreated` and by the flag the detail view
 * renders, so the button and the rule can never disagree. */
function markNotCreatedAllowed(attempt: ReturnType<typeof attempts.latestForEntry>): boolean {
  const reconcile = attempt?.reconcile;
  if (!reconcile) return false;
  if (reconcile.checks < MARK_NOT_CREATED_MIN_CHECKS) return false;
  return Date.now() - new Date(reconcile.checkedAt).getTime() >= MARK_NOT_CREATED_WINDOW_MS;
}

// --- POST /api/entries/preflight ----------------------------------------------------------

async function handlePreflight(deps: ApiRouteDeps, viewer: Viewer, body: unknown) {
  if (!isPlainObject(body)) return errorJson(400, "invalid body");
  const loaded = loadOwnEntry(deps, viewer, body.entryId, true);
  if ("error" in loaded) return loaded.error;
  const entry = loaded.entry;
  const choices = (isPlainObject(body.choices) ? body.choices : {}) as PreflightChoices;

  const clientResult = await loadClient(deps, viewer);
  if (!clientResult) return errorJson(503, NO_CLIENT_MESSAGE);

  let result;
  try {
    const shared = await fetchSharedWorkspaceData(clientResult.client, viewer.workspaceId);
    const state = await fetchEntryWorkspaceState(clientResult.client, viewer.workspaceId, shared, entry.source, choices);
    result = runPreflight({ source: entry.source, viewer, choices, workspace: state, now: new Date() });
  } catch (err) {
    if (isAddonTokenInvalid(err)) markInstallationBrokenOnAddonTokenFailure(deps, viewer)();
    if (err instanceof PreflightTruncatedError) return errorJson(503, err.message);
    deps.onError?.(err, { route: "preflight" });
    return errorJson(502, TRANSPORT_FAILURE_MESSAGE);
  }
  emitPreflightMetrics(deps.logger, result);

  const plan = plans.createActive(deps.db, {
    id: randomUUID(),
    recoverableEntryId: entry.id,
    createdBy: viewer.userId,
    createdAt: new Date().toISOString(),
    sourceHash: computeSourceHash(entry.source),
    choices,
    resolution: result.resolution,
    plannedRequest: result.plannedRequest,
    warnings: result.warnings,
    blockers: result.blockers,
    actionRequired: result.actionRequired,
    fidelity: result.fidelity,
  });

  return json(200, { plan });
}

// --- POST /api/entries/recreate -----------------------------------------------------------

/** Outcome of `confirmPlan` (docs/07 §7-§8), shared by the single-entry route and the bulk route
 * (docs/10 §7 — "each entry is claimed and executed independently"). Naming every branch as its
 * own `kind`, instead of returning ad hoc responses, is what lets both callers map the same core
 * onto their own wire shape without duplicating the claim/consume/attempt sequence (ADR-006: a
 * plan must always revalidate immediately before it executes, bulk or not). */
type ConfirmOutcome =
  | { readonly kind: "no-client" }
  | { readonly kind: "revalidate-truncated"; readonly message: string }
  | { readonly kind: "revalidate-error" }
  | { readonly kind: "stale"; readonly plan: RecreationPlan }
  | { readonly kind: "already-claimed"; readonly entry: RecoverableEntry }
  | { readonly kind: "plan-consumed" }
  | { readonly kind: "baseline-truncated"; readonly message: string }
  | { readonly kind: "attempt-error" }
  | {
      readonly kind: "done";
      readonly result: Awaited<ReturnType<typeof attemptRecreation>>;
      readonly entry?: RecoverableEntry;
    };

async function confirmPlan(
  deps: ApiRouteDeps,
  viewer: Viewer,
  entry: RecoverableEntry,
  plan: RecreationPlan,
): Promise<ConfirmOutcome> {
  const clientResult = await loadClient(deps, viewer);
  if (!clientResult) return { kind: "no-client" };

  // Revalidation (docs/07 §7): source hash + a fresh preflight with the same choices.
  const currentHash = computeSourceHash(entry.source);
  let fresh;
  try {
    const shared = await fetchSharedWorkspaceData(clientResult.client, viewer.workspaceId);
    const state = await fetchEntryWorkspaceState(clientResult.client, viewer.workspaceId, shared, entry.source, plan.choices);
    fresh = runPreflight({ source: entry.source, viewer, choices: plan.choices, workspace: state, now: new Date() });
  } catch (err) {
    if (isAddonTokenInvalid(err)) markInstallationBrokenOnAddonTokenFailure(deps, viewer)();
    if (err instanceof PreflightTruncatedError) return { kind: "revalidate-truncated", message: err.message };
    deps.onError?.(err, { route: "recreate.revalidate" });
    return { kind: "revalidate-error" };
  }

  const stale =
    !isPlanUsable(plan, currentHash) ||
    outcomesDiffer(plan, { plannedRequest: fresh.plannedRequest, resolution: fresh.resolution, warnings: fresh.warnings, blockers: fresh.blockers, actionRequired: fresh.actionRequired });

  if (stale) {
    plans.markStale(deps.db, plan.id);
    const freshPlan = plans.createActive(deps.db, {
      id: randomUUID(),
      recoverableEntryId: entry.id,
      createdBy: viewer.userId,
      createdAt: new Date().toISOString(),
      sourceHash: currentHash,
      choices: plan.choices,
      resolution: fresh.resolution,
      plannedRequest: fresh.plannedRequest,
      warnings: fresh.warnings,
      blockers: fresh.blockers,
      actionRequired: fresh.actionRequired,
      fidelity: fresh.fidelity,
    });
    return { kind: "stale", plan: freshPlan };
  }

  // `claim()` returns the row AFTER the update, so the pre-claim state has to be read here — a
  // release path needs to put back exactly what was there (IDLE or FAILED; those are the only two
  // states the claim predicate admits for a fresh claim).
  const priorState = entry.lifecycleState === "FAILED" ? "FAILED" : "IDLE";
  const claimToken = randomUUID();
  const claimed = entries.claim(deps.db, { id: entry.id, workspaceId: viewer.workspaceId, claimToken, now: new Date() });
  if (!claimed) {
    const current = entries.getById(deps.db, viewer.workspaceId, entry.id);
    return { kind: "already-claimed", entry: current ?? entry };
  }
  const release = () =>
    entries.releaseClaim(deps.db, {
      id: entry.id,
      workspaceId: viewer.workspaceId,
      claimToken,
      previousState: priorState,
    });

  const consumed = plans.consumeActive(deps.db, plan.id);
  if (!consumed) {
    // Another confirm won the plan first. Nothing was sent to Clockify, so put the pre-claim state
    // back rather than inventing a FAILED with no attempt row (docs/08 invariant 4).
    release();
    return { kind: "plan-consumed" };
  }

  let result;
  emitMetric(deps.logger, "recreate_attempt", { entryId: entry.id });
  try {
    result = await attemptRecreation({
      db: deps.db,
      client: clientResult.client,
      entryId: entry.id,
      workspaceId: viewer.workspaceId,
      planId: plan.id,
      plannedRequest: plan.plannedRequest,
      claimToken,
      recreatedBy: viewer.userId,
      now: new Date(),
      onAddonTokenInvalid: markInstallationBrokenOnAddonTokenFailure(deps, viewer),
      onUnexpectedError: (err) => deps.onError?.(err, { route: "recreate.attempt" }),
    });
  } catch (err) {
    if (err instanceof BaselineTruncatedError) {
      // The baseline read is the first Clockify call of the attempt and runs before the create,
      // so nothing was sent: releasing the claim is safe. The plan stays CONSUMED — the user
      // re-runs preflight, exactly as after a STALE plan.
      release();
      return { kind: "baseline-truncated", message: err.message };
    }
    // Anything else escaping `attemptRecreation` happens at or after the create, so the outcome is
    // NOT known to be "nothing happened". Never release the claim here: the lease expires and the
    // row becomes reclaimable on its own, which is the honest state (ADR-007).
    deps.onError?.(err, { route: "recreate.attempt" });
    return { kind: "attempt-error" };
  }

  emitMetric(
    deps.logger,
    result.outcome === "RECREATED" ? "recreate_success" : result.outcome === "FAILED" ? "recreate_failed" : "recreate_ambiguous",
    { entryId: entry.id },
  );

  // ADR-007 / docs/07 §8: "Reconcile immediately once, then lazily." A create whose response was
  // lost may already have committed; the first check happens now, not on the next detail view.
  if (result.outcome === "AMBIGUOUS") {
    const attempt = attempts.latestForEntry(deps.db, entry.id);
    const current = entries.getById(deps.db, viewer.workspaceId, entry.id) ?? entry;
    if (attempt) {
      try {
        await runOneReconcile(deps, clientResult.client, current, attempt, plan, viewer.userId);
      } catch (err) {
        // A failed first check leaves the row AMBIGUOUS, which is already the truthful state.
        deps.onError?.(err, { route: "recreate.reconcile" });
      }
    }
    const after = entries.getById(deps.db, viewer.workspaceId, entry.id) ?? current;
    return { kind: "done", result, entry: after };
  }

  return { kind: "done", result };
}

function confirmOutcomeToResponse(outcome: ConfirmOutcome): ReturnType<RequestHandler> {
  switch (outcome.kind) {
    case "no-client":
      return errorJson(503, NO_CLIENT_MESSAGE);
    case "revalidate-truncated":
      return errorJson(503, outcome.message);
    case "revalidate-error":
      return errorJson(502, TRANSPORT_FAILURE_MESSAGE);
    case "stale":
      // The UI's fallback renderer reads `body.error` only, so without one a stale plan showed
      // the bare "could not complete that request (status 409)" — answering none of N8's three
      // questions, on the exact path docs/07 §7 revalidation exists to protect. `stale` and
      // `plan` stay for the confirm view's forceResolve navigation.
      return json(409, {
        stale: true,
        plan: outcome.plan,
        error:
          "This plan is no longer current — something it depended on changed. Nothing was sent to Clockify. Open this entry again to review the fresh plan.",
      });
    case "already-claimed":
      return json(409, {
        error: "Another attempt is already recreating this entry. Nothing new was created by this click. Wait a moment, then reopen this entry to see its current status.",
        entry: outcome.entry,
      });
    case "plan-consumed":
      return json(409, {
        error: "This plan was already used by another attempt. Nothing was created by this click. Open this entry again to get a current plan.",
      });
    case "baseline-truncated":
      return errorJson(503, outcome.message);
    case "attempt-error":
      return errorJson(502, ATTEMPT_UNKNOWN_MESSAGE);
    case "done":
      return outcome.entry !== undefined
        ? json(200, { result: outcome.result, entry: outcome.entry })
        : json(200, { result: outcome.result });
  }
}

async function handleRecreate(deps: ApiRouteDeps, viewer: Viewer, body: unknown) {
  if (!isPlainObject(body)) return errorJson(400, "invalid body");
  const planId = body.planId;
  if (typeof planId !== "string" || planId.length === 0) return errorJson(400, "planId is required");

  const plan = plans.getById(deps.db, planId);
  const loaded = loadOwnEntry(deps, viewer, body.entryId, true, plan?.createdBy === viewer.userId);
  if ("error" in loaded) return loaded.error;
  const entry = loaded.entry;

  if (!plan || plan.recoverableEntryId !== entry.id) return errorJson(404, "plan not found");
  if (plan.blockers.length > 0) return errorJson(422, "this plan has blockers and cannot be confirmed");
  if (plan.actionRequired.length > 0) return errorJson(422, "this plan still needs choices");

  const outcome = await confirmPlan(deps, viewer, entry, plan);
  return confirmOutcomeToResponse(outcome);
}

// --- POST /api/entries/bulk-preflight / bulk-recreate (docs/10 §7, admin-only) -------------

const BULK_MAX = 50;

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.length > 0 && value.every((v) => typeof v === "string" && v.length > 0);
}

async function handleBulkPreflight(deps: ApiRouteDeps, viewer: Viewer, body: unknown) {
  if (!isAdmin(viewer)) {
    emitMetric(deps.logger, "authz_denied", { reason: "admin-required" });
    return errorJson(403, "admin role required");
  }
  if (!isPlainObject(body)) return errorJson(400, "invalid body");
  const ids = body.ids;
  if (!isStringArray(ids)) return errorJson(400, "ids must be a non-empty array of entry ids");
  if (ids.length > BULK_MAX) return errorJson(400, `at most ${BULK_MAX} entries per bulk request`);

  const clientResult = await loadClient(deps, viewer);
  if (!clientResult) return errorJson(503, NO_CLIENT_MESSAGE);

  // One shared-data fetch for the whole batch (docs/07 §2 "fetch once, reuse for every entry") —
  // the same sharing preflight-data.ts already does for `GET /api/entries`.
  let shared: SharedWorkspaceData;
  try {
    shared = await fetchSharedWorkspaceData(clientResult.client, viewer.workspaceId);
  } catch (err) {
    if (isAddonTokenInvalid(err)) markInstallationBrokenOnAddonTokenFailure(deps, viewer)();
    if (err instanceof PreflightTruncatedError) return errorJson(503, err.message);
    deps.onError?.(err, { route: "bulk-preflight" });
    return errorJson(502, TRANSPORT_FAILURE_MESSAGE);
  }

  // Same per-request project/task cache `GET /api/entries` uses: several ids in one bulk request
  // commonly share a project.
  const bulkProjectTaskCache = createProjectTaskCache();
  const results: unknown[] = [];
  for (const id of ids) {
    const row = entries.getById(deps.db, viewer.workspaceId, id);
    if (!row) {
      results.push({ entryId: id, status: "not-found" });
      continue;
    }
    try {
      const state = await fetchEntryWorkspaceState(clientResult.client, viewer.workspaceId, shared, row.source, {}, bulkProjectTaskCache);
      const result = runPreflight({ source: row.source, viewer, choices: {}, workspace: state, now: new Date() });
      emitPreflightMetrics(deps.logger, result);
      const plan = plans.createActive(deps.db, {
        id: randomUUID(),
        recoverableEntryId: row.id,
        createdBy: viewer.userId,
        createdAt: new Date().toISOString(),
        sourceHash: computeSourceHash(row.source),
        choices: {},
        resolution: result.resolution,
        plannedRequest: result.plannedRequest,
        warnings: result.warnings,
        blockers: result.blockers,
        actionRequired: result.actionRequired,
        fidelity: result.fidelity,
      });
      const status = plan.blockers.length > 0 ? "blocked" : plan.actionRequired.length > 0 ? "needs-input" : "ready";
      results.push({ entryId: id, status, plan });
    } catch (err) {
      if (err instanceof PreflightTruncatedError) {
        results.push({ entryId: id, status: "error", message: err.message });
        continue;
      }
      deps.onError?.(err, { route: "bulk-preflight" });
      results.push({ entryId: id, status: "error", message: TRANSPORT_FAILURE_MESSAGE });
    }
  }
  return json(200, { results });
}

/** Maps one `confirmPlan` outcome onto the bulk result row shape (docs/10 §7: "Results list per
 * entry: Recreated / Failed (reason) / Unknown result. There is no cross-entry transaction; each
 * row shows its own outcome."). The `RECREATED`/`FAILED`/`AMBIGUOUS` shapes are exactly the single
 * confirm's `result` — same rendering, no duplicated presentation logic — everything upstream of a
 * Clockify outcome (stale plan, lost claim race, transport failure) collapses to `ERROR`. */
function bulkResultItem(entryId: string, planId: string, outcome: ConfirmOutcome): Record<string, unknown> {
  switch (outcome.kind) {
    case "no-client":
      return { entryId, planId, outcome: "ERROR", message: NO_CLIENT_MESSAGE };
    case "revalidate-truncated":
    case "baseline-truncated":
      return { entryId, planId, outcome: "ERROR", message: outcome.message };
    case "revalidate-error":
      return { entryId, planId, outcome: "ERROR", message: TRANSPORT_FAILURE_MESSAGE };
    case "attempt-error":
      return { entryId, planId, outcome: "ERROR", message: ATTEMPT_UNKNOWN_MESSAGE };
    case "stale":
      return { entryId, planId, outcome: "ERROR", message: "This plan is no longer current. Nothing was created. Open this entry to get a fresh plan and try again." };
    case "already-claimed":
      return { entryId, planId, outcome: "ERROR", message: "This entry is already being recreated by another attempt. Nothing new was created by this click." };
    case "plan-consumed":
      return { entryId, planId, outcome: "ERROR", message: "This plan was already used by another attempt. Nothing was created by this click. Open this entry again to get a current plan." };
    case "done":
      return { entryId, planId, ...outcome.result };
  }
}

async function handleBulkRecreate(deps: ApiRouteDeps, viewer: Viewer, body: unknown) {
  if (!isAdmin(viewer)) {
    emitMetric(deps.logger, "authz_denied", { reason: "admin-required" });
    return errorJson(403, "admin role required");
  }
  if (!isPlainObject(body)) return errorJson(400, "invalid body");
  const planIds = body.planIds;
  if (!isStringArray(planIds)) return errorJson(400, "planIds must be a non-empty array of plan ids");
  if (planIds.length > BULK_MAX) return errorJson(400, `at most ${BULK_MAX} plans per bulk request`);

  const results: unknown[] = [];
  for (const planId of planIds) {
    const plan = plans.getById(deps.db, planId);
    if (!plan) {
      results.push({ planId, entryId: null, outcome: "ERROR", message: "plan not found" });
      continue;
    }
    const entry = entries.getById(deps.db, viewer.workspaceId, plan.recoverableEntryId);
    if (!entry) {
      results.push({ planId, entryId: plan.recoverableEntryId, outcome: "ERROR", message: "entry not found" });
      continue;
    }
    if (plan.blockers.length > 0 || plan.actionRequired.length > 0) {
      results.push({ planId, entryId: entry.id, outcome: "ERROR", message: "this plan has blockers or still needs choices" });
      continue;
    }
    const outcome = await confirmPlan(deps, viewer, entry, plan);
    results.push(bulkResultItem(entry.id, plan.id, outcome));
  }
  return json(200, { results });
}

// --- Reconcile (shared by the explicit route and the lazy detail-view trigger) ------------

async function runOneReconcile(
  deps: ApiRouteDeps,
  client: Awaited<ReturnType<typeof loadClient>> extends { client: infer C } | undefined ? C : never,
  entry: RecoverableEntry,
  attempt: ReturnType<typeof attempts.latestForEntry>,
  plan: RecreationPlan,
  /** The viewer performing the check. Distinct from `entry.ownerId`, which selects whose entry
   * list is read: an admin can reconcile another user's entry, and the audit must name the actor. */
  actingUserId: string,
) {
  if (!attempt) return;
  const result = await runReconcile({
    db: deps.db,
    client,
    entryId: entry.id,
    workspaceId: entry.workspaceId,
    userId: entry.ownerId,
    plannedRequest: plan.plannedRequest,
    baseline: attempt.baseline ?? [],
    recreatedBy: actingUserId,
    now: new Date(),
  });

  const priorChecks = attempt.reconcile?.checks ?? 0;
  const truncated = result.kind === "truncated";
  const summary = {
    checkedAt: new Date().toISOString(),
    // A truncated read never saw the whole list, so it is not evidence of anything. Counting it
    // would let three bound-hitting checks satisfy the mark-not-created gate and invite the user
    // to declare "not created" about an entry that exists — the one outcome ADR-007 forbids.
    checks: truncated ? priorChecks : priorChecks + 1,
    matchCount: result.kind === "adopted" ? 1 : result.kind === "many" ? result.candidateIds.length : 0,
    candidateIds: result.kind === "many" ? result.candidateIds : result.kind === "adopted" ? [result.newEntryId] : [],
    truncated,
  };
  attempts.updateReconcile(deps.db, attempt.id, summary);

  // docs/08 invariant 2: RECREATED implies one SUCCESS attempt pointing at the new entry. An
  // adoption is a transition out of RECREATING's successor state, so the attempt row has to say
  // so — otherwise the audit (and PASS-03's success view) reads a contradiction.
  if (result.kind === "adopted") {
    emitMetric(deps.logger, "ambiguous_adopted", { entryId: entry.id });
    await finishAdoptedAttempt(deps, client, entry, attempt.id, plan, result.newEntryId);
  }
  return result;
}

/** Closes the attempt row for an adopted entry and records the verification diff (docs/07 §8-§9).
 * The adoption is definitive, exactly as a 201 is: a failed verification read never undoes it — it
 * records "verification read unavailable" (fact 11), the same rule IT-13 pins for the create path. */
async function finishAdoptedAttempt(
  deps: ApiRouteDeps,
  client: Awaited<ReturnType<typeof loadClient>> extends { client: infer C } | undefined ? C : never,
  entry: RecoverableEntry,
  attemptId: string,
  plan: RecreationPlan,
  newEntryId: string,
) {
  let diffs;
  try {
    const actual = await client.timeEntries.get({ workspaceId: entry.workspaceId, timeEntryId: newEntryId });
    diffs = diffPlannedVsActual(plan.plannedRequest, actual);
  } catch (err) {
    deps.onError?.(err, { route: "reconcile.verify" });
    diffs = [{ field: "_verification", planned: null, actual: VERIFICATION_READ_UNAVAILABLE }];
  }
  attempts.finish(deps.db, {
    id: attemptId,
    finishedAt: new Date().toISOString(),
    outcome: "SUCCESS",
    newEntryId,
    errorStatus: null,
    errorCode: null,
    errorMessage: null,
    diffs,
  });
}

async function handleReconcile(deps: ApiRouteDeps, viewer: Viewer, body: unknown) {
  if (!isPlainObject(body)) return errorJson(400, "invalid body");
  const loaded = loadOwnEntry(deps, viewer, body.entryId, true);
  if ("error" in loaded) return loaded.error;
  const entry = loaded.entry;
  if (entry.lifecycleState !== "AMBIGUOUS") return errorJson(409, "entry is not AMBIGUOUS");

  const latestAttempt = attempts.latestForEntry(deps.db, entry.id);
  if (latestAttempt?.reconcile) {
    const elapsed = Date.now() - new Date(latestAttempt.reconcile.checkedAt).getTime();
    if (elapsed < RECONCILE_THROTTLE_MS) return errorJson(429, "reconcile was checked recently; try again shortly");
  }
  const plan = latestAttempt ? plans.getById(deps.db, latestAttempt.planId) : undefined;
  if (!latestAttempt || !plan) return errorJson(404, "no attempt to reconcile");

  const clientResult = await loadClient(deps, viewer);
  if (!clientResult) return errorJson(503, NO_CLIENT_MESSAGE);

  const result = await runOneReconcile(deps, clientResult.client, entry, latestAttempt, plan, viewer.userId);
  const current = entries.getById(deps.db, viewer.workspaceId, entry.id);
  return json(200, { result, entry: current ?? entry });
}

// --- POST /api/entries/mark-not-created ----------------------------------------------------

async function handleMarkNotCreated(deps: ApiRouteDeps, viewer: Viewer, body: unknown) {
  if (!isPlainObject(body)) return errorJson(400, "invalid body");
  const loaded = loadOwnEntry(deps, viewer, body.entryId, true);
  if ("error" in loaded) return loaded.error;
  const entry = loaded.entry;
  if (entry.lifecycleState !== "AMBIGUOUS") return errorJson(409, "entry is not AMBIGUOUS");

  // Same predicate the detail view's `canMarkNotCreated` flag reports, so the button the user
  // sees and the rule the server enforces can never disagree.
  if (!markNotCreatedAllowed(attempts.latestForEntry(deps.db, entry.id))) {
    return errorJson(409, "not enough reconcile checks yet — keep checking, or wait for the window to elapse");
  }

  const updated = entries.markNotCreated(deps.db, viewer.workspaceId, entry.id);
  if (!updated) return errorJson(409, "entry is no longer AMBIGUOUS");
  emitMetric(deps.logger, "ambiguous_not_created", { entryId: entry.id });
  return json(200, { entry: updated });
}

// --- POST /api/entries/resolve-ambiguous ----------------------------------------------------

async function handleResolveAmbiguous(deps: ApiRouteDeps, viewer: Viewer, body: unknown) {
  if (!isPlainObject(body)) return errorJson(400, "invalid body");
  const newEntryId = body.newEntryId;
  if (typeof newEntryId !== "string" || newEntryId.length === 0) return errorJson(400, "newEntryId is required");
  const loaded = loadOwnEntry(deps, viewer, body.entryId, true);
  if ("error" in loaded) return loaded.error;
  const entry = loaded.entry;
  if (entry.lifecycleState !== "AMBIGUOUS") return errorJson(409, "entry is not AMBIGUOUS");

  const latestAttempt = attempts.latestForEntry(deps.db, entry.id);
  const plan = latestAttempt ? plans.getById(deps.db, latestAttempt.planId) : undefined;
  if (!plan) return errorJson(404, "no plan to resolve against");

  const clientResult = await loadClient(deps, viewer);
  if (!clientResult) return errorJson(503, NO_CLIENT_MESSAGE);

  let candidate;
  try {
    candidate = await clientResult.client.timeEntries.get({ workspaceId: viewer.workspaceId, timeEntryId: newEntryId });
  } catch {
    return errorJson(404, "Clockify has no entry with that id");
  }
  const fp = fingerprintFromPlanned(plan.plannedRequest);
  if (!fingerprintMatches(fp, candidate)) {
    return errorJson(400, "that entry does not match this recreation's fingerprint");
  }
  // The fingerprint compares values, not identity, so a look-alike entry that already existed
  // matches it. Two extra checks keep an adoption meaning "this is the entry the create made":
  // it must not be in the attempt's baseline (docs/07 §8 — "new" means "not in the baseline"),
  // and it must belong to the entry's owner, since every recreation targets that owner (ADR-004).
  if ((latestAttempt?.baseline ?? []).includes(newEntryId)) {
    return errorJson(400, "that entry already existed before this recreation was attempted");
  }
  if (candidate.userId !== entry.source.ownerId) {
    return errorJson(400, "that entry belongs to a different user");
  }

  try {
    const adopted = entries.adopt(deps.db, {
      id: entry.id,
      workspaceId: viewer.workspaceId,
      newEntryId,
      recreatedAt: new Date().toISOString(),
      recreatedBy: viewer.userId,
    });
    if (!adopted) return errorJson(409, "entry is no longer AMBIGUOUS");
    emitMetric(deps.logger, "ambiguous_adopted", { entryId: entry.id });
    if (latestAttempt) {
      await finishAdoptedAttempt(deps, clientResult.client, entry, latestAttempt.id, plan, newEntryId);
    }
    return json(200, { entry: adopted });
  } catch (err) {
    if (typeof err === "object" && err !== null && "code" in err && String((err as { code: unknown }).code).startsWith("SQLITE_CONSTRAINT")) {
      return errorJson(409, "that Clockify entry is already linked to another recovered entry");
    }
    throw err;
  }
}

// --- Dismiss / undismiss ---------------------------------------------------------------

async function handleDismiss(deps: ApiRouteDeps, viewer: Viewer, body: unknown) {
  if (!isPlainObject(body)) return errorJson(400, "invalid body");
  const loaded = loadOwnEntry(deps, viewer, body.entryId, true);
  if ("error" in loaded) return loaded.error;
  const updated = entries.dismiss(deps.db, viewer.workspaceId, loaded.entry.id);
  if (!updated) return errorJson(409, "entry cannot be dismissed from its current state");
  return json(204, null);
}

async function handleUndismiss(deps: ApiRouteDeps, viewer: Viewer, body: unknown) {
  if (!isPlainObject(body)) return errorJson(400, "invalid body");
  const loaded = loadOwnEntry(deps, viewer, body.entryId, true);
  if ("error" in loaded) return loaded.error;
  const updated = entries.undismiss(deps.db, viewer.workspaceId, loaded.entry.id);
  if (!updated) return errorJson(409, "entry is not dismissed");
  return json(204, null);
}

// --- GET /api/options --------------------------------------------------------------------

async function handleOptions(deps: ApiRouteDeps, viewer: Viewer, query: URLSearchParams) {
  const kind = query.get("kind");
  const clientResult = await loadClient(deps, viewer);
  if (!clientResult) return errorJson(503, NO_CLIENT_MESSAGE);
  const { client } = clientResult;

  try {
    // These feed the replacement pickers, so a truncated list is worse than an error: the user
    // cannot find the right project and substitutes a wrong one. docs/03 note 5 lists all three
    // as iterPages reads; `collectPaged` raises rather than returning a partial page.
    if (kind === "projects") {
      const items = await collectPaged(client.projects.list.bind(client.projects), { workspaceId: viewer.workspaceId });
      return json(200, { items: items.map((p) => ({ id: p.id, name: p.name, archived: p.archived })) });
    }
    if (kind === "tasks") {
      const projectId = query.get("projectId");
      if (!projectId) return errorJson(400, "projectId is required for kind=tasks");
      const items = await collectPaged(client.tasks.list.bind(client.tasks), { workspaceId: viewer.workspaceId, projectId });
      return json(200, { items: items.map((t) => ({ id: t.id, name: t.name, status: t.status })) });
    }
    if (kind === "tags") {
      const items = await collectPaged(client.tags.list.bind(client.tags), { workspaceId: viewer.workspaceId });
      return json(200, { items: items.map((t) => ({ id: t.id, name: t.name, archived: t.archived })) });
    }
    if (kind === "customFields") {
      // Feeds the P-CF-OPT / P-CF-REQ resolution widgets (docs/10 §4): the field's current type
      // and allowed values, keyed by the `refId` on the matching `ActionRequiredItem`. Same fetch
      // `preflight-data.ts` already makes for the preflight itself — read-only, no new rule.
      const items = await collectPaged(client.customFields.listForWorkspace.bind(client.customFields), {
        workspaceId: viewer.workspaceId,
        "entity-type": ["TIMEENTRY"],
      });
      return json(200, {
        items: items
          .filter((f): f is typeof f & { id: string } => f.id !== undefined)
          .map((f) => ({
            id: f.id,
            name: f.name ?? f.id,
            type: f.type ?? "TXT",
            allowedValues: f.allowedValues ?? null,
            required: f.required ?? false,
          })),
      });
    }
    return errorJson(400, "kind must be one of projects, tasks, tags, customFields");
  } catch (err) {
    if (err instanceof PreflightTruncatedError) return errorJson(503, err.message);
    if (isAddonTokenInvalid(err)) markInstallationBrokenOnAddonTokenFailure(deps, viewer)();
    deps.onError?.(err, { route: "options" });
    return errorJson(502, TRANSPORT_FAILURE_MESSAGE);
  }
}

// --- Registration ------------------------------------------------------------------------

export function registerApiRoutes(addon: HandlerRegistrar, parser: ClockifySignatureParser, deps: ApiRouteDeps): void {
  const guard = (handler: (deps: ApiRouteDeps, viewer: Viewer, request: Parameters<RequestHandler>[0]) => ReturnType<RequestHandler>) =>
    requireViewer(parser, (request, viewer) => handler(deps, viewer, request));

  /**
   * docs/10 §8: when the addon is disabled for a workspace, "a notice replaces actions; lists stay
   * readable". The UI shows that notice — but docs/00 says the UI never decides what a user may do,
   * so the rule has to hold on the server too. Without this, a viewer already on the detail or
   * confirm screen when the addon is disabled could still complete a recreation.
   *
   * Applied only to routes that write to Clockify or change a lifecycle state. Reads —
   * `/api/entries`, `/api/entries/detail`, `/api/entries/preflight`, `/api/options` — stay
   * available, which is what keeps lists readable.
   */
  const actionGuard = (handler: (deps: ApiRouteDeps, viewer: Viewer, request: Parameters<RequestHandler>[0]) => ReturnType<RequestHandler>) =>
    guard((d, viewer, request) => {
      if (getInstallationStatus(d.db, viewer.workspaceId, viewer.addonId) === "INACTIVE") {
        return errorJson(409, "RestoreTime is disabled for this workspace.");
      }
      return handler(d, viewer, request);
    });

  addon.registerHandler(
    "/api/entries",
    "GET",
    guard((d, viewer, request) => handleListEntries(d, viewer, request.query ?? new URLSearchParams())),
  );
  addon.registerHandler(
    "/api/entries/detail",
    "GET",
    guard((d, viewer, request) => handleDetail(d, viewer, request.query ?? new URLSearchParams())),
  );
  addon.registerHandler(
    "/api/entries/preflight",
    "POST",
    guard((d, viewer, request) => handlePreflight(d, viewer, request.body)),
  );
  addon.registerHandler(
    "/api/entries/recreate",
    "POST",
    actionGuard((d, viewer, request) => handleRecreate(d, viewer, request.body)),
  );
  addon.registerHandler(
    "/api/entries/reconcile",
    "POST",
    actionGuard((d, viewer, request) => handleReconcile(d, viewer, request.body)),
  );
  addon.registerHandler(
    "/api/entries/mark-not-created",
    "POST",
    actionGuard((d, viewer, request) => handleMarkNotCreated(d, viewer, request.body)),
  );
  addon.registerHandler(
    "/api/entries/resolve-ambiguous",
    "POST",
    actionGuard((d, viewer, request) => handleResolveAmbiguous(d, viewer, request.body)),
  );
  addon.registerHandler(
    "/api/entries/dismiss",
    "POST",
    actionGuard((d, viewer, request) => handleDismiss(d, viewer, request.body)),
  );
  addon.registerHandler(
    "/api/entries/undismiss",
    "POST",
    actionGuard((d, viewer, request) => handleUndismiss(d, viewer, request.body)),
  );
  addon.registerHandler(
    "/api/options",
    "GET",
    guard((d, viewer, request) => handleOptions(d, viewer, request.query ?? new URLSearchParams())),
  );
  addon.registerHandler(
    "/api/entries/bulk-preflight",
    "POST",
    guard((d, viewer, request) => handleBulkPreflight(d, viewer, request.body)),
  );
  addon.registerHandler(
    "/api/entries/bulk-recreate",
    "POST",
    actionGuard((d, viewer, request) => handleBulkRecreate(d, viewer, request.body)),
  );
}
