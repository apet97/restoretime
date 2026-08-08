// LV-08 (docs/13): "Custom-field lifecycle: removed option → P-CF-OPT resolution; new required
// field without default → P-CF-REQ input → success." Both scenarios need real, deliberately-shaped
// custom fields, created here and torn down in `finally` — the sacrificial workspace's custom
// fields must support this plan tier for the test to proceed; a create rejection is reported
// (blocked, workspace/plan-shape, not a suite defect) rather than treated as a failure of the
// recreation logic under test.
import { afterEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { ClockifyApiError, type ClockifyApi } from "clockify-sdk-ts-115";
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

describe("LV-08 custom-field lifecycle (docs/13)", () => {
  it("a removed dropdown option resolves via P-CF-OPT; a new required field with no default resolves via P-CF-REQ; both recreate successfully", async () => {
    const check = checkLiveEnv();
    if (check.blocked) {
      console.log(`LV-08 ${check.reason}`);
      expect(check.blocked).toBe(true);
      return;
    }
    const env: LiveEnv = check.env;
    const restClient = buildLiveRestClient(env);

    let dropdownFieldId: string | undefined;
    let requiredFieldId: string | undefined;
    let recreatedEntryId: string | undefined;
    try {
      const users = await restClient.users.list({ workspaceId: env.workspaceId, status: "ALL", "include-roles": false, "page-size": 200 });
      const owner = users.find((u) => u.status === "ACTIVE");
      expect(owner, "at least one ACTIVE user is required").toBeDefined();
      if (!owner) return;

      let dropdownField: ClockifyApi.CustomField | undefined;
      let requiredField: ClockifyApi.CustomField | undefined;
      try {
        dropdownField = await restClient.customFields.createForWorkspace({
          workspaceId: env.workspaceId,
          name: `${RT_PROBE_PREFIX}LV08-dropdown-${randomUUID().slice(0, 8)}`,
          type: "DROPDOWN_SINGLE",
          entityType: "TIMEENTRY",
          allowedValues: ["Alpha", "Beta"],
          required: false,
        });
        dropdownFieldId = dropdownField.id;
        // Remove "Beta" — any source value of "Beta" is now a stale option (P-CF-OPT).
        await restClient.customFields.updateForWorkspace({
          workspaceId: env.workspaceId,
          customFieldId: dropdownField.id!,
          name: dropdownField.name!,
          type: "DROPDOWN_SINGLE",
          allowedValues: ["Alpha"],
        });

        requiredField = await restClient.customFields.createForWorkspace({
          workspaceId: env.workspaceId,
          name: `${RT_PROBE_PREFIX}LV08-required-${randomUUID().slice(0, 8)}`,
          type: "TXT",
          entityType: "TIMEENTRY",
          required: true,
          // No workspaceDefaultValue: a source with no usable value for this field has nothing
          // to fall back to (P-CF-REQ, docs/07 §3).
        });
        requiredFieldId = requiredField.id;
      } catch (err) {
        console.log(`LV-08 blocked — creating a custom field on the sacrificial workspace was rejected (${err instanceof ClockifyApiError ? `status ${err.statusCode}` : "unknown error"}). This is a workspace/plan-shape gap, not a suite defect.`);
        return;
      }

      const start = new Date(Date.now() - 20 * 60 * 1000);
      const source: DeletedTimeEntry = {
        workspaceId: env.workspaceId,
        entryId: `rt-probe-source-${randomUUID()}`,
        ownerId: owner.id,
        ownerName: owner.name,
        description: `${RT_PROBE_PREFIX}LV08 ${start.toISOString()}`,
        billable: false,
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
        // The dropdown field carries the now-removed "Beta" option; the required field carries no
        // value at all (never set on the deleted entry).
        customFieldValues: [{ customFieldId: dropdownFieldId!, name: dropdownField.name!, value: "Beta" }],
      };

      harness = await bootLiveHarness(env);
      const recoverableId = randomUUID();
      seedRecoverableEntry(harness, { id: recoverableId, sourceEntryId: source.entryId, ownerId: owner.id, source });
      const viewer = { userId: owner.id, workspaceRole: "member" as const };

      const firstPreflight = await apiCall(harness, viewer, {
        method: "POST",
        path: "/api/entries/preflight",
        body: { entryId: recoverableId, choices: {} },
      });
      expect(firstPreflight.status).toBe(200);
      const firstPlan = (firstPreflight.body as { plan: { actionRequired: { ruleId: string; refId?: string }[] } }).plan;
      const ruleIds = firstPlan.actionRequired.map((a) => `${a.ruleId}:${a.refId}`);
      expect(ruleIds).toContain(`P-CF-OPT:${dropdownFieldId}`);
      expect(ruleIds).toContain(`P-CF-REQ:${requiredFieldId}`);

      // Resolve: keep the stale dropdown value as-is (P-CF-OPT "keep"), supply a value for the
      // required field (P-CF-REQ input).
      const secondPreflight = await apiCall(harness, viewer, {
        method: "POST",
        path: "/api/entries/preflight",
        body: {
          entryId: recoverableId,
          choices: {
            customFieldInputs: [
              { customFieldId: dropdownFieldId, value: "Beta" },
              { customFieldId: requiredFieldId, value: `${RT_PROBE_PREFIX}required-value` },
            ],
          },
        },
      });
      expect(secondPreflight.status).toBe(200);
      const secondPlan = (secondPreflight.body as { plan: { id: string; blockers: unknown[]; actionRequired: unknown[] } }).plan;
      expect(secondPlan.blockers).toEqual([]);
      expect(secondPlan.actionRequired).toEqual([]);

      const recreate = await apiCall(harness, viewer, {
        method: "POST",
        path: "/api/entries/recreate",
        body: { entryId: recoverableId, planId: secondPlan.id },
      });
      expect(recreate.status).toBe(200);
      const result = (recreate.body as { result: { outcome: string; newEntryId?: string } }).result;
      expect(result.outcome).toBe("RECREATED");
      recreatedEntryId = result.newEntryId;

      const newEntry = await restClient.timeEntries.get({ workspaceId: env.workspaceId, timeEntryId: recreatedEntryId! });
      const values = (newEntry.customFieldValues ?? []) as Record<string, unknown>[];
      const dropdownValue = values.find((v) => v.customFieldId === dropdownFieldId)?.value;
      const requiredValue = values.find((v) => v.customFieldId === requiredFieldId)?.value;
      expect(dropdownValue).toBe("Beta");
      expect(requiredValue).toBe(`${RT_PROBE_PREFIX}required-value`);
    } catch (err) {
      const rejected = describeIfAuthRejected(err);
      if (rejected) {
        console.log(`LV-08 ${rejected}`);
        throw err;
      }
      if (err instanceof ClockifyApiError) {
        throw new Error(`LV-08: unexpected Clockify rejection (status ${err.statusCode}). This is a real live finding, not a suite defect.`, { cause: err });
      }
      throw err;
    } finally {
      if (recreatedEntryId) {
        await restClient.timeEntries.delete({ workspaceId: env.workspaceId, timeEntryId: recreatedEntryId }).catch(() => undefined);
      }
      if (dropdownFieldId) {
        await restClient.customFields.deleteForWorkspace({ workspaceId: env.workspaceId, customFieldId: dropdownFieldId }).catch(() => undefined);
      }
      if (requiredFieldId) {
        await restClient.customFields.deleteForWorkspace({ workspaceId: env.workspaceId, customFieldId: requiredFieldId }).catch(() => undefined);
      }
    }
  }, 60_000);
});
