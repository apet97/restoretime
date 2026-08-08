// LV-04 (docs/13): "Admin recreates another user's entry (createForUser addon-token success path —
// confirms the operator-stated API-key/addon-token equivalence, R11) (the same scenario passed on
// the developer environment 2026-08-08 with the addon token — users.list, projects.list,
// createForUser for another user → 201, get, delete; re-confirm on production)."
//
// The "admin" half of this scenario is an app-internal authorization decision (`domain/policy.ts`
// `isAdmin`), driven entirely by the verified component JWT's `workspaceRole` claim — proved
// correct offline (UT-A01, IT-07's 53-case sweep) and exercised here via the harness's own
// test-signed claims (tests/live/support.ts module header), same as every other in-process LV row.
// What is NOT already proved offline, and what this row exists to close, is the REST-level
// question: does `createForUser` for a userId that is NOT the token owner actually succeed against
// that real Clockify environment with `CK_LIVE_API_KEY` sent as the addon token (R11)? That requires two
// genuinely distinct real workspace members.
import { afterEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { ClockifyApiError } from "clockify-sdk-ts-115";
import {
  apiCall,
  bootLiveHarness,
  buildLiveRestClient,
  checkLiveAddonToken,
  checkLiveEnv,
  deletedEntryFromLiveTimeEntry,
  describeIfAuthRejected,
  pickUsableProject,
  requiredCustomFieldValues,
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
});

describe("LV-04 admin recreates another user's entry (docs/13)", () => {
  it("createForUser targeting a different userId succeeds with CK_LIVE_API_KEY as the addon token (R11)", async (ctx) => {
    const check = checkLiveEnv();
    if (check.blocked) {
      console.log(`LV-04 ${check.reason}`);
      expect(check.blocked).toBe(true);
      return;
    }
    const tokenCheck = checkLiveAddonToken(check.env);
    if (tokenCheck.blocked) {
      console.log(`LV-04 ${tokenCheck.reason}`);
      expect(tokenCheck.blocked).toBe(true);
      return;
    }
    const env: LiveEnv = check.env;
    const restClient = buildLiveRestClient(env);

    let recreatedEntryId: string | undefined;
    try {
      const users = await restClient.users.list({ workspaceId: env.workspaceId, status: "ALL", "include-roles": false, "page-size": 200 });
      const active = users.filter((u) => u.status === "ACTIVE");
      if (active.length < 2) {
        // `ctx.skip` rather than `return`: a returned row is reported as PASSED, and this row is
        // the one that closes R11 — the pass file's stated load-bearing unknown. A credentialed
        // run on a one-member workspace must not print "passed" for a scenario that never ran.
        ctx.skip(
          `LV-04 blocked — the sacrificial workspace has ${active.length} ACTIVE user(s); this scenario needs at least 2 distinct members (the acting admin and the entry's owner). This is a workspace-shape gap, not a missing credential.`,
        );
        return;
      }
      const actingAdmin = active[0]!;
      const owner = active[1]!;
      expect(owner.id).not.toBe(actingAdmin.id);

      const start = new Date(Date.now() - 45 * 60 * 1000);
      const end = new Date(start.getTime() + 20 * 60 * 1000);
      // R4: on a `forceProjects` workspace a completed create without a project is rejected with
      // 400 code 501. A real deleted entry there always carried one, so the probe does too.
      const probeProject = await pickUsableProject(restClient, env.workspaceId);
      // R22: a workspace with required custom fields rejects a create that omits them (400/501).
      const requiredCfs = await requiredCustomFieldValues(restClient, env.workspaceId);
      const created = await restClient.timeEntries.createForUser({
        workspaceId: env.workspaceId,
        userId: owner.id,
        start: start.toISOString(),
        end: end.toISOString(),
        description: `${RT_PROBE_PREFIX}LV04 ${start.toISOString()}`,
        billable: false,
        ...(probeProject ? { projectId: probeProject.id } : {}),
        ...(requiredCfs.create.length > 0 ? { customFields: requiredCfs.create } : {}),
      });
      expect(created.userId).toBe(owner.id); // the create really targeted the OTHER user

      const source = deletedEntryFromLiveTimeEntry(created, owner.name, probeProject?.name ?? null, new Map());
      await restClient.timeEntries.delete({ workspaceId: env.workspaceId, timeEntryId: created.id });

      harness = await bootLiveHarness(env);
      const recoverableId = randomUUID();
      seedRecoverableEntry(harness, { id: recoverableId, sourceEntryId: created.id, ownerId: owner.id, source });

      // The viewer is the acting admin, NOT the entry's owner — canAct(entry, viewer) requires
      // isAdmin(viewer) here (domain/policy.ts).
      const adminViewer = { userId: actingAdmin.id, workspaceRole: "admin" as const };
      const preflight = await apiCall(harness, adminViewer, {
        method: "POST",
        path: "/api/entries/preflight",
        body: { entryId: recoverableId, choices: {} },
      });
      expect(preflight.status).toBe(200);
      const plan = (preflight.body as { plan: { id: string; blockers: unknown[]; actionRequired: unknown[] } }).plan;
      expect(plan.blockers).toEqual([]);
      expect(plan.actionRequired).toEqual([]);

      const recreate = await apiCall(harness, adminViewer, {
        method: "POST",
        path: "/api/entries/recreate",
        body: { entryId: recoverableId, planId: plan.id },
      });
      expect(recreate.status).toBe(200);
      const result = (recreate.body as { result: { outcome: string; newEntryId?: string } }).result;
      expect(result.outcome).toBe("RECREATED");
      recreatedEntryId = result.newEntryId;
      expect(recreatedEntryId).toBeDefined();

      const newEntry = await restClient.timeEntries.get({ workspaceId: env.workspaceId, timeEntryId: recreatedEntryId! });
      // R11's actual claim: the new entry belongs to OWNER, created via an admin-driven request
      // authenticated as CK_LIVE_API_KEY — not the admin's own entry.
      expect(newEntry.userId).toBe(owner.id);

      // A non-admin viewer attempting the same thing must be refused server-side (docs/09) — a
      // cheap, high-value negative check to run alongside the real positive proof above.
      const regularViewer = { userId: actingAdmin.id, workspaceRole: "member" as const };
      const deniedList = await apiCall(harness, regularViewer, {
        method: "GET",
        path: "/api/entries/detail",
        query: new URLSearchParams({ id: recoverableId }),
      });
      expect(deniedList.status).toBe(404); // canRead is owner-or-admin only; a demoted admin sees nothing (IT-07 shape)
    } catch (err) {
      const rejected = describeIfAuthRejected(err);
      if (rejected) {
        console.log(`LV-04 ${rejected}`);
        throw err;
      }
      if (err instanceof ClockifyApiError) {
        throw new Error(`LV-04: unexpected Clockify rejection (status ${err.statusCode}) creating/reading for a non-owner user. This is a real live R11 finding, not a suite defect.`, { cause: err });
      }
      throw err;
    } finally {
      if (recreatedEntryId) {
        await restClient.timeEntries.delete({ workspaceId: env.workspaceId, timeEntryId: recreatedEntryId }).catch(() => undefined);
      }
    }
  }, 60_000);
});
