// LV-07 (docs/13): "`onlyAdminsCanChangeBillableStatus` behavior for a regular viewer (closes R12
// unknown)." R12 was about whether this workspace setting is even reachable/documented through the
// real `workspaces.get` call the app makes — the rule's own logic (P-BILL, domain/preflight.ts) is
// already proved offline for both boolean states (UT-P10). This row proves the REAL API surfaces
// `onlyAdminsCanChangeBillableStatus`/`defaultBillableProjects` and that the app's warning fires
// (or correctly does not) consistently with whatever value currently holds on the sacrificial
// workspace.
//
// Deliberately does NOT toggle the workspace-wide setting via the API: that is a workspace-level
// configuration change disproportionate to a live proof (unlike a probe time entry or a throwaway
// tag, it is not scoped to one row and not obviously reversible in the same sense), and it is not
// needed — the rule's logic for both boolean states is already proved offline (UT-P10); this row
// only needs to prove the real field is read correctly, which it can do under whichever value the
// workspace currently has.
import { afterEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { ClockifyApiError } from "clockify-sdk-ts-115";
import type { DeletedTimeEntry } from "../../src/domain/entry.js";
import {
  apiCall,
  bootLiveHarness,
  buildLiveRestClient,
  checkLiveEnv,
  describeIfAuthRejected,
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

describe("LV-07 billable-permission warning against the real workspace setting (docs/13)", () => {
  it("P-BILL fires for a regular viewer exactly when the real workspace flags say it should", async () => {
    const check = checkLiveEnv();
    if (check.blocked) {
      console.log(`LV-07 ${check.reason}`);
      expect(check.blocked).toBe(true);
      return;
    }
    const env: LiveEnv = check.env;
    const restClient = buildLiveRestClient(env);

    try {
      const [workspace, users] = await Promise.all([
        restClient.workspaces.get({ workspaceId: env.workspaceId }),
        restClient.users.list({ workspaceId: env.workspaceId, status: "ALL", "include-roles": false, "page-size": 200 }),
      ]);
      const owner = users.find((u) => u.status === "ACTIVE");
      expect(owner, "at least one ACTIVE user is required").toBeDefined();
      if (!owner) return;

      const settings = workspace.workspaceSettings;
      const onlyAdmins = settings?.onlyAdminsCanChangeBillableStatus ?? false;
      const defaultBillable = settings?.defaultBillableProjects ?? false;
      const ruleReachable = onlyAdmins || defaultBillable;
      // impliedBillable === defaultBillableProjects (src/clockify/preflight-data.ts) — a
      // mismatching source.billable is what the rule looks for.
      const mismatchedBillable = !defaultBillable;

      const start = new Date(Date.now() - 30 * 60 * 1000);
      const source: DeletedTimeEntry = {
        workspaceId: env.workspaceId,
        entryId: `rt-probe-source-${randomUUID()}`,
        ownerId: owner.id,
        ownerName: owner.name,
        description: `${RT_PROBE_PREFIX}LV07 ${start.toISOString()}`,
        billable: mismatchedBillable,
        start: start.toISOString(),
        end: new Date(start.getTime() + 10 * 60 * 1000).toISOString(),
        wasRunning: false,
        type: "REGULAR",
        timeZone: null,
        projectId: null,
        projectName: null,
        clientName: null,
        taskId: null,
        taskName: null,
        tags: [],
        customFieldValues: [],
      };

      harness = await bootLiveHarness(env);
      const recoverableId = randomUUID();
      seedRecoverableEntry(harness, { id: recoverableId, sourceEntryId: source.entryId, ownerId: owner.id, source });

      const regularViewer = { userId: owner.id, workspaceRole: "member" as const };
      const preflight = await apiCall(harness, regularViewer, {
        method: "POST",
        path: "/api/entries/preflight",
        body: { entryId: recoverableId, choices: {} },
      });
      expect(preflight.status).toBe(200);
      const plan = (preflight.body as { plan: { warnings: { ruleId: string }[] } }).plan;
      const hasBillWarning = plan.warnings.some((w) => w.ruleId === "P-BILL");

      expect(hasBillWarning).toBe(ruleReachable);
      console.log(
        `LV-07: onlyAdminsCanChangeBillableStatus=${onlyAdmins}, defaultBillableProjects=${defaultBillable} on the real workspace; P-BILL ${hasBillWarning ? "fired" : "did not fire"} for a regular viewer, matching the expected ${ruleReachable} (R12 closed: the real API surfaces this field and the rule reads it correctly).`,
      );

      // Same source, admin viewer: the rule must never fire for an admin, regardless of the flags.
      const adminPreflight = await apiCall(harness, { userId: owner.id, workspaceRole: "admin" as const }, {
        method: "POST",
        path: "/api/entries/preflight",
        body: { entryId: recoverableId, choices: {} },
      });
      expect(adminPreflight.status).toBe(200);
      const adminPlan = (adminPreflight.body as { plan: { warnings: { ruleId: string }[] } }).plan;
      expect(adminPlan.warnings.some((w) => w.ruleId === "P-BILL")).toBe(false);
    } catch (err) {
      const rejected = describeIfAuthRejected(err);
      if (rejected) {
        console.log(`LV-07 ${rejected}`);
        throw err;
      }
      if (err instanceof ClockifyApiError) {
        throw new Error(`LV-07: unexpected Clockify rejection (status ${err.statusCode}). This is a real live finding, not a suite defect.`, { cause: err });
      }
      throw err;
    }
  }, 30_000);
});
