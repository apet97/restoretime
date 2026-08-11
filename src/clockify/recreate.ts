// Mutation and outcome protocol (docs/07 §8-§9, ADR-007). Baseline snapshot -> createForUser ->
// branch; verification diff; the ambiguity reconcile. `attemptRecreation`/`runReconcile` are the
// I/O-aware orchestrators (client + store together); the rest are pure helpers, independently
// testable (UT-M01, UT-P13).

import {
  ClockifyApiError,
  ClockifyApiTimeoutError,
  iterPages,
  type ClockifyApi,
  type ClockifyClient,
} from "clockify-sdk-ts-115";

type TimeEntry = ClockifyApi.TimeEntry;
import type Database from "better-sqlite3";
import type { PlannedRequest, VerificationDiff } from "../domain/entry.js";
import { looselyEqual } from "../domain/values.js";
import { clockifyErrorCode, describeClockifyCreateFailure } from "./errors.js";
import * as entries from "../store/entries.js";
import * as attempts from "../store/attempts.js";

const PAGE_SIZE = 200;
const MAX_PAGES = 10;

export class BaselineTruncatedError extends Error {
  constructor() {
    super("workspace too large to verify; try again");
  }
}

/** A baseline read failed before an attempt row or Clockify create could start. The route can
 * safely release its claim and classify the original SDK error without implying an unknown write
 * outcome. */
export class PreWriteBaselineError extends Error {
  constructor(readonly cause: unknown) {
    super("the recreation baseline read failed before create");
  }
}

/** The claim changed while the baseline read was in flight. No create was sent because the
 * durable attempt row could not pass its claim-token fence. */
export class PreWriteClaimChangedError extends Error {
  constructor() {
    super("the recreation claim changed before create");
  }
}

/** Both the baseline read (§8) and the reconcile read (§8) use this: the description-filtered
 * `listForUser` (fallback: unfiltered when the description is empty), never the windowed query
 * (R10). Truncation is reported, never silently guessed. */
async function listForUserPaged(
  client: ClockifyClient,
  workspaceId: string,
  userId: string,
  description: string,
): Promise<{ items: TimeEntry[]; truncated: boolean }> {
  const baseRequest = description.length > 0 ? { workspaceId, userId, description } : { workspaceId, userId };
  const items: TimeEntry[] = [];
  let truncated = false;
  for await (const page of iterPages(client.timeEntries.listForUser.bind(client.timeEntries), baseRequest, {
    pageSize: PAGE_SIZE,
    maxPages: MAX_PAGES,
  })) {
    items.push(...page.items);
    if (page.page === MAX_PAGES && page.hasNextPage) truncated = true;
  }
  return { items, truncated };
}

/** Baseline truncation is fatal (docs/07 §8: "treated as a failed preflight … never a partial
 * baseline") — thrown, not returned, so the caller never proceeds to create. */
async function fetchBaseline(
  client: ClockifyClient,
  workspaceId: string,
  userId: string,
  description: string,
): Promise<string[]> {
  const { items, truncated } = await listForUserPaged(client, workspaceId, userId, description);
  if (truncated) throw new BaselineTruncatedError();
  return items.map((i) => i.id);
}

// The generated request type is a union of the flattened shape and a `{body: …}` envelope (S6);
// the app always builds the flattened variant, which is not individually re-exported by the SDK
// barrel, so the return type here is the exported union — the object literal below still only
// ever has the flattened shape.
function buildCreateBody(p: PlannedRequest): ClockifyApi.CreateForUserTimeEntriesRequest {
  return {
    workspaceId: p.workspaceId,
    userId: p.userId,
    start: p.start,
    ...(p.end !== undefined ? { end: p.end } : {}),
    ...(p.description !== undefined ? { description: p.description } : {}),
    ...(p.billable !== undefined ? { billable: p.billable } : {}),
    ...(p.projectId !== undefined ? { projectId: p.projectId } : {}),
    ...(p.taskId !== undefined ? { taskId: p.taskId } : {}),
    ...(p.tagIds !== undefined && p.tagIds.length > 0 ? { tagIds: p.tagIds } : {}),
    ...(p.customFields !== undefined && p.customFields.length > 0 ? { customFields: p.customFields } : {}),
    // `type` is never sent: the create default is REGULAR and only REGULAR sources are
    // recreated (R17).
  };
}

function epochSeconds(iso: string | null | undefined): number | null {
  if (iso === null || iso === undefined) return null;
  return Math.floor(new Date(iso).getTime() / 1000);
}

/** Recorded on the diff when the post-create (or post-adoption) read could not be made. The
 * create/adoption itself is still definitive — the diff is a report, never a gate (fact 11). */
export const VERIFICATION_READ_UNAVAILABLE = "verification read unavailable";

/** Compare `plannedRequest` with the fetched new entry (docs/07 §9). `duration` is never
 * compared (recomputed by Clockify, W5). `verificationNote` records "verification read
 * unavailable" when the 201 body is used as a fallback (fact 11, IT-13). */
export function diffPlannedVsActual(
  planned: PlannedRequest,
  actual: TimeEntry,
  verificationNote?: string,
): VerificationDiff[] {
  const diffs: VerificationDiff[] = [];

  if (epochSeconds(planned.start) !== epochSeconds(actual.timeInterval.start)) {
    diffs.push({ field: "start", planned: planned.start, actual: actual.timeInterval.start ?? null });
  }
  if (epochSeconds(planned.end) !== epochSeconds(actual.timeInterval.end)) {
    diffs.push({ field: "end", planned: planned.end ?? null, actual: actual.timeInterval.end ?? null });
  }
  if ((planned.description ?? "") !== actual.description) {
    diffs.push({ field: "description", planned: planned.description ?? "", actual: actual.description });
  }
  if ((planned.projectId ?? null) !== (actual.projectId ?? null)) {
    diffs.push({ field: "projectId", planned: planned.projectId ?? null, actual: actual.projectId ?? null });
  }
  if ((planned.taskId ?? null) !== (actual.taskId ?? null)) {
    diffs.push({ field: "taskId", planned: planned.taskId ?? null, actual: actual.taskId ?? null });
  }
  const plannedTags = [...new Set(planned.tagIds ?? [])].sort();
  const actualTags = [...new Set(actual.tagIds ?? [])].sort();
  if (plannedTags.length !== actualTags.length || plannedTags.some((t, i) => t !== actualTags[i])) {
    diffs.push({ field: "tagIds", planned: plannedTags, actual: actualTags });
  }
  if ((planned.billable ?? false) !== actual.billable) {
    diffs.push({ field: "billable", planned: planned.billable ?? false, actual: actual.billable });
  }
  for (const cf of planned.customFields ?? []) {
    const actualItems = (actual.customFieldValues ?? []) as Record<string, unknown>[];
    const match = actualItems.find((v) => v?.customFieldId === cf.customFieldId);
    const actualValue = match?.value;
    if (!looselyEqual(cf.value, actualValue)) {
      diffs.push({ field: `customFields.${cf.customFieldId}`, planned: cf.value, actual: actualValue ?? null });
    }
  }
  if (verificationNote !== undefined) {
    diffs.push({ field: "_verification", planned: null, actual: verificationNote });
  }
  return diffs;
}

export type CreateOutcome =
  | { readonly kind: "RECREATED"; readonly newEntry: TimeEntry; readonly diffs: VerificationDiff[] }
  | { readonly kind: "FAILED"; readonly status: number | undefined; readonly code: string | undefined; readonly message: string }
  | { readonly kind: "AMBIGUOUS" };

/**
 * Outcome classification (docs/03 §3, exact order — R15):
 * 1. `ClockifyApiTimeoutError` -> AMBIGUOUS.
 * 2. `ClockifyApiError` with `statusCode === undefined` (transport failure) -> AMBIGUOUS.
 * 3. `ClockifyApiError` with `statusCode >= 500` -> AMBIGUOUS.
 * 4. `ClockifyApiError` with a 4xx `statusCode` -> FAILED, mapped via `clockifyErrorCode`.
 * 5. Any other thrown value is a bug: never guessed, treated as AMBIGUOUS (the create may have
 *    committed).
 *
 * A 201 is definitive: `timeEntries.get` verifies it, but a failed verification read still
 * yields RECREATED — the diff falls back to the 201 body (fact 11, IT-13).
 */
async function executeCreate(
  client: ClockifyClient,
  plannedRequest: PlannedRequest,
  onUnexpectedError?: (error: unknown) => void,
): Promise<CreateOutcome> {
  let created: TimeEntry;
  try {
    created = await client.timeEntries.createForUser(buildCreateBody(plannedRequest));
  } catch (err) {
    if (err instanceof ClockifyApiTimeoutError) return { kind: "AMBIGUOUS" };
    if (err instanceof ClockifyApiError) {
      if (err.statusCode === undefined || err.statusCode >= 500) return { kind: "AMBIGUOUS" };
      const code = clockifyErrorCode(err);
      return { kind: "FAILED", status: err.statusCode, code, message: describeClockifyCreateFailure(err.statusCode, code) };
    }
    // docs/03 §3: not an SDK error, so this is a bug. The create may still have committed, so the
    // outcome stays AMBIGUOUS — but it must never disappear without a trace.
    onUnexpectedError?.(err);
    return { kind: "AMBIGUOUS" };
  }

  let actual: TimeEntry = created;
  let verificationNote: string | undefined;
  try {
    actual = await client.timeEntries.get({ workspaceId: plannedRequest.workspaceId, timeEntryId: created.id });
  } catch {
    verificationNote = VERIFICATION_READ_UNAVAILABLE;
  }
  return { kind: "RECREATED", newEntry: actual, diffs: diffPlannedVsActual(plannedRequest, actual, verificationNote) };
}

// --- Reconcile (ambiguity protocol, §8) ---------------------------------------------------

export interface Fingerprint {
  readonly start: string;
  readonly end: string | undefined;
  readonly description: string;
  readonly billable: boolean;
  readonly projectId: string | undefined;
  readonly taskId: string | undefined;
  readonly tagIds: readonly string[];
}

export function fingerprintFromPlanned(p: PlannedRequest): Fingerprint {
  return {
    start: p.start,
    end: p.end,
    description: p.description ?? "",
    billable: p.billable ?? false,
    projectId: p.projectId,
    taskId: p.taskId,
    tagIds: p.tagIds ?? [],
  };
}

export function fingerprintMatches(
  fp: Fingerprint,
  candidate: TimeEntry,
  allowBillableOverride = false,
): boolean {
  if (epochSeconds(fp.start) !== epochSeconds(candidate.timeInterval.start)) return false;
  if (epochSeconds(fp.end ?? null) !== epochSeconds(candidate.timeInterval.end)) return false;
  if (fp.description !== candidate.description) return false;
  if (!allowBillableOverride && fp.billable !== candidate.billable) return false;
  if ((fp.projectId ?? null) !== (candidate.projectId ?? null)) return false;
  if ((fp.taskId ?? null) !== (candidate.taskId ?? null)) return false;
  const a = [...fp.tagIds].sort();
  const b = [...(candidate.tagIds ?? [])].sort();
  return a.length === b.length && a.every((t, i) => t === b[i]);
}

/** Baseline-delta, fingerprint-filtered (UT-P13). Pure: no I/O. */
export function matchCandidates(
  fp: Fingerprint,
  baseline: readonly string[],
  freshList: readonly TimeEntry[],
  allowBillableOverride = false,
): TimeEntry[] {
  const baselineSet = new Set(baseline);
  const delta = freshList.filter((i) => !baselineSet.has(i.id));
  return delta.filter((i) => fingerprintMatches(fp, i, allowBillableOverride));
}

export type ReconcileDecision =
  | { readonly kind: "none" }
  | { readonly kind: "one"; readonly id: string }
  | { readonly kind: "many"; readonly candidateIds: string[] };

/** UT-P13: two identical candidates -> "many" (stay AMBIGUOUS, user picks). */
export function decideReconcile(matches: readonly TimeEntry[]): ReconcileDecision {
  if (matches.length === 0) return { kind: "none" };
  if (matches.length === 1) return { kind: "one", id: matches[0]!.id };
  return { kind: "many", candidateIds: matches.map((m) => m.id) };
}

export interface ReconcileInput {
  readonly db: Database.Database;
  readonly client: ClockifyClient;
  readonly entryId: string;
  readonly workspaceId: string;
  readonly userId: string;
  readonly plannedRequest: PlannedRequest;
  readonly baseline: readonly string[];
  /** P-BILL records that Clockify can replace the submitted billable value with its current
   * workspace default. All other fingerprint fields remain exact. */
  readonly allowBillableOverride?: boolean;
  /** The attempt whose baseline and plan produced this read. Adoption must refuse the result if
   * another attempt becomes current while the external Clockify read is in flight. */
  readonly expectedAttemptId: string;
  /** The viewer performing the check — recorded as `recreated_by` on adoption. Distinct from
   * `userId`, which selects whose entry list is read: an admin can reconcile another user's
   * entry, and the audit must name the actor, not the owner. */
  readonly recreatedBy: string;
  readonly now: Date;
  readonly onVerificationError?: (error: unknown) => void;
}

export type ReconcileResult =
  | { readonly kind: "adopted"; readonly newEntryId: string }
  | { readonly kind: "adopt-conflict" }
  | { readonly kind: "none" }
  | { readonly kind: "many"; readonly candidateIds: string[] }
  | { readonly kind: "truncated" };

function isUniqueConstraintError(err: unknown): boolean {
  return typeof err === "object" && err !== null && "code" in err && typeof (err as { code?: unknown }).code === "string" &&
    (err as { code: string }).code.startsWith("SQLITE_CONSTRAINT");
}

/** Runs one reconcile pass: read -> baseline-delta -> fingerprint match -> decide -> (on exactly
 * one match) adopt, guarded by the partial unique index (double-adoption guard, §8). */
export async function runReconcile(input: ReconcileInput): Promise<ReconcileResult> {
  const description = input.plannedRequest.description ?? "";
  const { items, truncated } = await listForUserPaged(input.client, input.workspaceId, input.userId, description);
  if (truncated) return { kind: "truncated" };

  const fp = fingerprintFromPlanned(input.plannedRequest);
  const matches = matchCandidates(fp, input.baseline, items, input.allowBillableOverride);
  const decision = decideReconcile(matches);
  if (decision.kind === "none") return { kind: "none" };
  if (decision.kind === "many") return { kind: "many", candidateIds: decision.candidateIds };

  let diffs: VerificationDiff[];
  try {
    const actual = await input.client.timeEntries.get({
      workspaceId: input.workspaceId,
      timeEntryId: decision.id,
    });
    diffs = diffPlannedVsActual(input.plannedRequest, actual);
  } catch (err) {
    input.onVerificationError?.(err);
    diffs = [{ field: "_verification", planned: null, actual: VERIFICATION_READ_UNAVAILABLE }];
  }

  const nowIso = input.now.toISOString();
  try {
    const adopted = entries.adopt(input.db, {
      id: input.entryId,
      workspaceId: input.workspaceId,
      expectedAttemptId: input.expectedAttemptId,
      newEntryId: decision.id,
      recreatedAt: nowIso,
      recreatedBy: input.recreatedBy,
      diffs,
    });
    if (!adopted) return { kind: "adopt-conflict" };
    return { kind: "adopted", newEntryId: decision.id };
  } catch (err) {
    if (isUniqueConstraintError(err)) return { kind: "adopt-conflict" };
    throw err;
  }
}

// --- Full attempt orchestration (claim already won by the caller) ------------------------

export interface AttemptRecreationInput {
  readonly db: Database.Database;
  readonly client: ClockifyClient;
  readonly entryId: string;
  readonly workspaceId: string;
  readonly planId: string;
  readonly plannedRequest: PlannedRequest;
  readonly claimToken: string;
  readonly recreatedBy: string;
  readonly now: Date;
  /** Called with a thrown value that is not an SDK error. docs/03 §3: "Any other thrown value is
   * a bug: crash-log it and treat the attempt as AMBIGUOUS." Without this the one error class the
   * contract demands be logged is the only one that vanishes silently. */
  readonly onUnexpectedError?: (error: unknown) => void;
  /** Called when the create failed because the addon token itself was rejected (401/4017, R11) —
   * the caller marks the installation broken (IT-08). Never called for any other outcome. */
  readonly onAddonTokenInvalid?: () => void;
}

export type AttemptRecreationResult =
  | { readonly outcome: "RECREATED"; readonly newEntryId: string; readonly diffs: VerificationDiff[] }
  | { readonly outcome: "FAILED"; readonly status: number | undefined; readonly code: string | undefined; readonly message: string }
  | { readonly outcome: "AMBIGUOUS"; readonly baseline: readonly string[] };

/**
 * Test-only crash injection (IT-12 lease/fencing drill, PASS-04). When set, `attemptRecreation`
 * throws immediately after the baseline snapshot is recorded and before the create call —
 * modeling a process crash mid-attempt: the row stays RECREATING under the dead `claim_token`,
 * with a started-but-never-finished attempt row. Lease recovery must treat that durable state as
 * AMBIGUOUS because the same state can remain after a create was sent. Never fires unless
 * `NODE_ENV==="test"`, the same guard `RT_CHAOS_FETCH` (docs/13 LV-10) uses, so this can never
 * trigger in production regardless of how the env var is set.
 */
function shouldCrashMidAttempt(): boolean {
  return process.env.NODE_ENV === "test" && process.env.RT_TEST_CRASH_MID_ATTEMPT === "1";
}

/** Commits the attempt audit and the fenced entry state as one SQLite transaction. A lost claim
 * rolls both writes back, so a stale process cannot report an outcome that the entry does not
 * carry. */
function commitClaimedOutcome(
  db: Database.Database,
  attempt: Parameters<typeof attempts.finishUnfinished>[1],
  transitionEntry: () => boolean,
): void {
  const commit = db.transaction(() => {
    if (!attempts.finishUnfinished(db, attempt)) {
      throw new Error("recreation attempt no longer accepts an outcome");
    }
    if (!transitionEntry()) {
      throw new Error("recreation claim was lost before its outcome committed");
    }
  });
  commit.immediate();
}

export async function attemptRecreation(input: AttemptRecreationInput): Promise<AttemptRecreationResult> {
  const startedAt = input.now.toISOString();
  let baseline: string[];
  try {
    baseline = await fetchBaseline(
      input.client,
      input.workspaceId,
      input.plannedRequest.userId,
      input.plannedRequest.description ?? "",
    );
  } catch (err) {
    if (err instanceof BaselineTruncatedError) throw err;
    throw new PreWriteBaselineError(err);
  }
  const started = attempts.startForClaim(input.db, {
    id: input.claimToken,
    planId: input.planId,
    recoverableEntryId: input.entryId,
    startedAt,
    baseline,
  });
  if (!started) {
    // The baseline read can outlive the lease. A newer request can then recover the row before
    // this process resumes. The pre-write fence makes that stale process stop before create.
    throw new PreWriteClaimChangedError();
  }

  if (shouldCrashMidAttempt()) {
    throw new Error("RT_TEST_CRASH_MID_ATTEMPT: simulated crash after the baseline snapshot, before the create call");
  }

  const outcome = await executeCreate(input.client, input.plannedRequest, input.onUnexpectedError);
  const finishedAt = new Date().toISOString();

  if (outcome.kind === "RECREATED") {
    commitClaimedOutcome(
      input.db,
      {
        id: input.claimToken,
        finishedAt,
        outcome: "SUCCESS",
        newEntryId: outcome.newEntry.id,
        errorStatus: null,
        errorCode: null,
        errorMessage: null,
        diffs: outcome.diffs,
      },
      () =>
        entries.setRecreated(input.db, {
          id: input.entryId,
          workspaceId: input.workspaceId,
          claimToken: input.claimToken,
          newEntryId: outcome.newEntry.id,
          recreatedAt: finishedAt,
          recreatedBy: input.recreatedBy,
        }) !== undefined,
    );
    return { outcome: "RECREATED", newEntryId: outcome.newEntry.id, diffs: outcome.diffs };
  }

  if (outcome.kind === "FAILED") {
    if (outcome.status === 401 && outcome.code === "4017") input.onAddonTokenInvalid?.();
    commitClaimedOutcome(
      input.db,
      {
        id: input.claimToken,
        finishedAt,
        outcome: "FAILED",
        newEntryId: null,
        errorStatus: outcome.status ?? null,
        errorCode: outcome.code ?? null,
        errorMessage: outcome.message,
        diffs: null,
      },
      () =>
        entries.setFailed(input.db, {
          id: input.entryId,
          workspaceId: input.workspaceId,
          claimToken: input.claimToken,
        }) !== undefined,
    );
    return { outcome: "FAILED", status: outcome.status, code: outcome.code, message: outcome.message };
  }

  commitClaimedOutcome(
    input.db,
    {
      id: input.claimToken,
      finishedAt,
      outcome: "AMBIGUOUS",
      newEntryId: null,
      errorStatus: null,
      errorCode: null,
      errorMessage: null,
      diffs: null,
    },
    () =>
      entries.setAmbiguous(input.db, {
        id: input.entryId,
        workspaceId: input.workspaceId,
        claimToken: input.claimToken,
      }) !== undefined,
  );
  return { outcome: "AMBIGUOUS", baseline };
}
