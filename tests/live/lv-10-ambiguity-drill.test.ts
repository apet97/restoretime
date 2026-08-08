// LV-10 (docs/13, PASS-05 pass file — a HARD gate: "if the chaos hook cannot run in the deployment
// shape, the release stops"). Mandatory ambiguity drill via `RT_CHAOS_FETCH`
// (src/clockify/chaos-fetch.ts), run here against REAL production Clockify through the in-process
// harness (tests/live/support.ts module header). The hook mechanics are already proved offline
// against a mocked transport in tests/integration/chaos-fetch-drill.test.ts — this file repeats
// both legs against the real sacrificial workspace, which is the one thing the offline proof
// cannot do.
//
// (a) `RT_CHAOS_FETCH=lose-response`: the real `createForUser` POST is sent and Clockify commits
//     it, but the caller sees a `ClockifyApiTimeoutError` -> AMBIGUOUS. `confirmPlan`
//     (src/api/routes.ts) runs one reconcile pass immediately on an AMBIGUOUS outcome (docs/07
//     §8), so a single `/api/entries/recreate` call can already come back RECREATED if the
//     reconcile adopts within that same request; this test accepts either outcome from that call
//     and, if still AMBIGUOUS, drives one more explicit reconcile to prove adoption.
// (b) `RT_CHAOS_FETCH=fail-before-send`: nothing is ever sent -> AMBIGUOUS -> reconcile finds
//     nothing -> stays AMBIGUOUS. The "user marks not created" step is driven at the store layer
//     (`entries.markNotCreated`), bypassing only the UI's real-time cooldown window
//     (`MARK_NOT_CREATED_MIN_CHECKS`/`MARK_NOT_CREATED_WINDOW_MS`, src/api/routes.ts) — that
//     window's own gating logic is proved offline (IT-04); this row proves the reconcile mechanics
//     against real Clockify, not the wall-clock cooldown.
import { afterEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { ClockifyApiError } from "clockify-sdk-ts-115";
import type { DeletedTimeEntry } from "../../src/domain/entry.js";
import * as entries from "../../src/store/entries.js";
import * as attempts from "../../src/store/attempts.js";
import * as plans from "../../src/store/plans.js";
import { runReconcile } from "../../src/clockify/recreate.js";
import {
  apiCall,
  bootLiveHarness,
  buildLiveRestClient,
  checkLiveAddonToken,
  checkLiveEnv,
  describeIfAuthRejected,
  pickUsableProject,
  RT_PROBE_PREFIX,
  seedRecoverableEntry,
  teardownLiveHarness,
  type LiveEnv,
  type LiveHarness,
} from "./support.js";

let harness: LiveHarness | undefined;

afterEach(() => {
  if (harness) teardownLiveHarness(harness);
  harness = undefined;
  delete process.env.RT_CHAOS_FETCH;
});

/** The synthetic deleted entry this drill recreates.
 *
 * `project` must be supplied on a workspace that sets `forceProjects` (R4): without one the plan
 * legitimately comes back with P-PROJ-REQ ACTION_REQUIRED and `/api/entries/recreate` refuses it
 * with 422 — correct product behaviour, but it means the chaos hook never runs and the drill
 * proves nothing. A real deleted entry on such a workspace always carried a project. */
function freshSource(
  env: LiveEnv,
  ownerId: string,
  ownerName: string,
  tag: string,
  project: { id: string; name: string } | undefined,
): DeletedTimeEntry {
  const start = new Date(Date.now() - 25 * 60 * 1000);
  return {
    workspaceId: env.workspaceId,
    entryId: `rt-probe-source-${randomUUID()}`,
    ownerId,
    ownerName,
    description: `${RT_PROBE_PREFIX}LV10-${tag} ${randomUUID()}`,
    billable: false,
    start: start.toISOString(),
    end: new Date(start.getTime() + 10 * 60 * 1000).toISOString(),
    wasRunning: false,
    type: "REGULAR",
    timeZone: null,
    projectId: project?.id ?? null,
    projectName: project?.name ?? null,
    clientName: null,
    taskId: null,
    taskName: null,
    tags: [],
    customFieldValues: [],
  };
}

describe("LV-10 mandatory ambiguity drill (docs/13, hard gate)", () => {
  it("(a) lose-response: the entry really is created in Clockify -> AMBIGUOUS -> reconcile adopts -> RECREATED", async () => {
    const check = checkLiveEnv();
    if (check.blocked) {
      console.log(`LV-10(a) ${check.reason}`);
      expect(check.blocked).toBe(true);
      return;
    }
    const tokenCheckA = checkLiveAddonToken(check.env);
    if (tokenCheckA.blocked) {
      console.log(`LV-10(a) ${tokenCheckA.reason}`);
      expect(tokenCheckA.blocked).toBe(true);
      return;
    }
    const env: LiveEnv = check.env;
    const restClient = buildLiveRestClient(env);
    let createdEntryId: string | undefined;

    try {
      const users = await restClient.users.list({ workspaceId: env.workspaceId, status: "ALL", "include-roles": false, "page-size": 200 });
      const owner = users.find((u) => u.status === "ACTIVE");
      expect(owner, "at least one ACTIVE user is required").toBeDefined();
      if (!owner) return;

      const probeProject = await pickUsableProject(restClient, env.workspaceId);
      const source = freshSource(env, owner.id, owner.name, "a", probeProject);
      harness = await bootLiveHarness(env);
      const recoverableId = randomUUID();
      seedRecoverableEntry(harness, { id: recoverableId, sourceEntryId: source.entryId, ownerId: owner.id, source });
      const viewer = { userId: owner.id, workspaceRole: "member" as const };

      const preflight = await apiCall(harness, viewer, { method: "POST", path: "/api/entries/preflight", body: { entryId: recoverableId, choices: {} } });
      expect(preflight.status).toBe(200);
      const plan = (preflight.body as { plan: { id: string } }).plan;

      process.env.RT_CHAOS_FETCH = "lose-response";
      const recreate = await apiCall(harness, viewer, { method: "POST", path: "/api/entries/recreate", body: { entryId: recoverableId, planId: plan.id } });
      delete process.env.RT_CHAOS_FETCH;
      expect(recreate.status).toBe(200);
      // `attemptRecreation`'s own outcome literal always stays "AMBIGUOUS" here (docs/03 §3) even
      // when `confirmPlan`'s built-in immediate reconcile pass (docs/07 §8) already adopted it
      // within this same request — the row's actual state is `entry`, not `result.outcome`.
      const body = recreate.body as { result: { outcome: string }; entry?: { lifecycleState: string; newEntryId: string | null } };
      expect(body.result.outcome).toBe("AMBIGUOUS");

      let finalEntry = entries.getById(harness.server.db, env.workspaceId, recoverableId);
      if (finalEntry?.lifecycleState !== "RECREATED") {
        // The immediate first-check reconcile did not find it yet (e.g. read-after-write lag).
        // Reconcile directly at the client/store layer (same call `runReconcile` makes, same as
        // tests/integration/mutation.test.ts's IT-04 pattern) — the HTTP route's 30s throttle
        // (RECONCILE_THROTTLE_MS) exists to protect the UI from hammering Clockify, not something
        // this proof needs to respect.
        const attempt = attempts.latestForEntry(harness.server.db, recoverableId);
        expect(attempt, "an attempt row must exist after a recreate call").toBeDefined();
        if (attempt) {
          const planRow = plans.getById(harness.server.db, attempt.planId);
          expect(planRow).toBeDefined();
          if (planRow) {
            const reconcileResult = await runReconcile({
              db: harness.server.db,
              client: restClient,
              entryId: recoverableId,
              workspaceId: env.workspaceId,
              userId: owner.id,
              plannedRequest: planRow.plannedRequest,
              baseline: attempt.baseline ?? [],
              recreatedBy: owner.id,
              now: new Date(),
            });
            expect(reconcileResult.kind).toBe("adopted");
          }
        }
        finalEntry = entries.getById(harness.server.db, env.workspaceId, recoverableId);
      }
      expect(finalEntry?.lifecycleState).toBe("RECREATED");
      expect(finalEntry?.newEntryId).toBeDefined();
      createdEntryId = finalEntry?.newEntryId ?? undefined;

      // Confirm against real Clockify: the entry genuinely exists — this is the whole point of
      // "lose-after-commit", not a database-only claim.
      const real = await restClient.timeEntries.get({ workspaceId: env.workspaceId, timeEntryId: createdEntryId! });
      expect(real.description).toBe(source.description);
      console.log(`LV-10(a): create committed at Clockify (${createdEntryId}) despite the reported transport failure; reconcile adopted it. AMBIGUOUS -> RECREATED proved live.`);
    } catch (err) {
      const rejected = describeIfAuthRejected(err);
      if (rejected) {
        console.log(`LV-10(a) ${rejected}`);
        throw err;
      }
      if (err instanceof ClockifyApiError) {
        throw new Error(`LV-10(a): unexpected Clockify rejection (status ${err.statusCode}). This is a real live finding, not a suite defect.`, { cause: err });
      }
      throw err;
    } finally {
      delete process.env.RT_CHAOS_FETCH;
      if (createdEntryId) await restClient.timeEntries.delete({ workspaceId: env.workspaceId, timeEntryId: createdEntryId }).catch(() => undefined);
    }
  }, 60_000);

  it("(b) fail-before-send: nothing is ever sent -> AMBIGUOUS -> bounded reconcile finds nothing -> marked not-created -> IDLE", async () => {
    const check = checkLiveEnv();
    if (check.blocked) {
      console.log(`LV-10(b) ${check.reason}`);
      expect(check.blocked).toBe(true);
      return;
    }
    const tokenCheckB = checkLiveAddonToken(check.env);
    if (tokenCheckB.blocked) {
      console.log(`LV-10(b) ${tokenCheckB.reason}`);
      expect(tokenCheckB.blocked).toBe(true);
      return;
    }
    const env: LiveEnv = check.env;
    const restClient = buildLiveRestClient(env);

    try {
      const users = await restClient.users.list({ workspaceId: env.workspaceId, status: "ALL", "include-roles": false, "page-size": 200 });
      const owner = users.find((u) => u.status === "ACTIVE");
      expect(owner, "at least one ACTIVE user is required").toBeDefined();
      if (!owner) return;

      const probeProject = await pickUsableProject(restClient, env.workspaceId);
      const source = freshSource(env, owner.id, owner.name, "b", probeProject);
      harness = await bootLiveHarness(env);
      const recoverableId = randomUUID();
      seedRecoverableEntry(harness, { id: recoverableId, sourceEntryId: source.entryId, ownerId: owner.id, source });
      const viewer = { userId: owner.id, workspaceRole: "member" as const };

      const preflight = await apiCall(harness, viewer, { method: "POST", path: "/api/entries/preflight", body: { entryId: recoverableId, choices: {} } });
      expect(preflight.status).toBe(200);
      const plan = (preflight.body as { plan: { id: string } }).plan;

      process.env.RT_CHAOS_FETCH = "fail-before-send";
      const recreate = await apiCall(harness, viewer, { method: "POST", path: "/api/entries/recreate", body: { entryId: recoverableId, planId: plan.id } });
      delete process.env.RT_CHAOS_FETCH;
      expect(recreate.status).toBe(200);
      const body = recreate.body as { result: { outcome: string } };
      expect(body.result.outcome).toBe("AMBIGUOUS");

      const stayedAmbiguous = entries.getById(harness.server.db, env.workspaceId, recoverableId);
      expect(stayedAmbiguous?.lifecycleState).toBe("AMBIGUOUS");
      expect(stayedAmbiguous?.newEntryId).toBeNull(); // nothing was ever created

      // "Still AMBIGUOUS" alone proves nothing: it is equally true if the immediate reconcile
      // threw and never reached Clockify (the route swallows a failed first check by design —
      // src/api/routes.ts, since a failed check leaves the truthful state). The named behaviour of
      // this row is that a reconcile RAN against real Clockify and found nothing, so assert the
      // check was recorded.
      const attempt = attempts.latestForEntry(harness.server.db, recoverableId);
      expect(attempt?.reconcile?.checks ?? 0).toBeGreaterThanOrEqual(1);
      expect(attempt?.reconcile?.matchCount).toBe(0);
      expect(attempt?.reconcile?.truncated).toBe(false);

      // Store-level "user marks not created" (bypasses only the UI cooldown window, not the
      // reconcile mechanics under test — see the module header).
      const marked = entries.markNotCreated(harness.server.db, env.workspaceId, recoverableId);
      expect(marked?.lifecycleState).toBe("IDLE");
      console.log("LV-10(b): nothing was ever sent to Clockify; the row stayed AMBIGUOUS through a real reconcile and moved to IDLE on 'not created'. Proved live.");
    } catch (err) {
      const rejected = describeIfAuthRejected(err);
      if (rejected) {
        console.log(`LV-10(b) ${rejected}`);
        throw err;
      }
      if (err instanceof ClockifyApiError) {
        throw new Error(`LV-10(b): unexpected Clockify rejection (status ${err.statusCode}). This is a real live finding, not a suite defect.`, { cause: err });
      }
      throw err;
    } finally {
      delete process.env.RT_CHAOS_FETCH;
    }
  }, 60_000);
});
