// LV-03 (docs/13): "Own-entry recreation end-to-end (plan → confirm → RECREATED; entry visible in
// Clockify; a non-default custom-field value is preserved on the new entry — R5 write path)."
//
// Uses the in-process test-signed harness (tests/live/support.ts module header): the platform-JWT
// boundary is test-signed, the Clockify REST boundary is real production (CK_LIVE_API_KEY,
// CK_LIVE_WS). A real time entry is created and deleted via `CK_LIVE_API_KEY` first (capturing its
// exact shape before deletion), then seeded as a `recoverable_entries` row directly — standing in
// for "the webhook already delivered" (LV-02 proves live delivery itself; webhook ingestion
// correctness is proved exhaustively offline, IT-01/02, CT-01…05). The whole point of this row is
// exercising the REAL preflight+recreate path against REAL Clockify.
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

describe("LV-03 own-entry recreation end-to-end (docs/13)", () => {
  it("plan -> confirm -> RECREATED against real Clockify; a non-default custom-field value is preserved (R5)", async () => {
    const check = checkLiveEnv();
    if (check.blocked) {
      console.log(`LV-03 ${check.reason}`);
      expect(check.blocked).toBe(true);
      return;
    }
    const tokenCheck = checkLiveAddonToken(check.env);
    if (tokenCheck.blocked) {
      console.log(`LV-03 ${tokenCheck.reason}`);
      expect(tokenCheck.blocked).toBe(true);
      return;
    }
    const env: LiveEnv = check.env;
    const restClient = buildLiveRestClient(env);

    let recreatedEntryId: string | undefined;
    try {
      const [users, projects, customFields] = await Promise.all([
        restClient.users.list({ workspaceId: env.workspaceId, status: "ALL", "include-roles": false, "page-size": 200 }),
        restClient.projects.list({ workspaceId: env.workspaceId, "page-size": 200 }),
        restClient.customFields.listForWorkspace({ workspaceId: env.workspaceId, "entity-type": ["TIMEENTRY"] }),
      ]);
      const owner = users.find((u) => u.status === "ACTIVE");
      expect(owner, "the sacrificial workspace must have at least one ACTIVE user").toBeDefined();
      if (!owner) return;
      const project = projects.find((p) => !p.archived);

      // A non-default value for whichever active custom field is easiest to set (R5 write path) —
      // best-effort: LV-03 still proves the core recreation path even with no usable field.
      const usableField = customFields.find((f) => f.status !== "INACTIVE" && f.id !== undefined);
      const allowedValues = usableField?.allowedValues ?? [];
      const cfValue: unknown = usableField
        ? allowedValues.length > 0
          ? (allowedValues.find((v) => v !== usableField.workspaceDefaultValue) ?? allowedValues[0])
          : `${RT_PROBE_PREFIX}cf-value`
        : undefined;

      const start = new Date(Date.now() - 60 * 60 * 1000);
      const end = new Date(start.getTime() + 30 * 60 * 1000);
      const created = await restClient.timeEntries.createForUser({
        workspaceId: env.workspaceId,
        userId: owner.id,
        start: start.toISOString(),
        end: end.toISOString(),
        description: `${RT_PROBE_PREFIX}LV03 ${start.toISOString()}`,
        billable: true,
        ...(project ? { projectId: project.id } : {}),
        ...(usableField && cfValue !== undefined ? { customFields: [{ customFieldId: usableField.id!, sourceType: "WORKSPACE" as const, value: cfValue }] } : {}),
      });

      const source = deletedEntryFromLiveTimeEntry(created, owner.name, project?.name ?? null, new Map());
      await restClient.timeEntries.delete({ workspaceId: env.workspaceId, timeEntryId: created.id });

      harness = await bootLiveHarness(env);
      const recoverableId = randomUUID();
      seedRecoverableEntry(harness, { id: recoverableId, sourceEntryId: created.id, ownerId: owner.id, source });

      const viewer = { userId: owner.id, workspaceRole: "member" as const };
      const preflight = await apiCall(harness, viewer, {
        method: "POST",
        path: "/api/entries/preflight",
        body: { entryId: recoverableId, choices: {} },
      });
      expect(preflight.status).toBe(200);
      const plan = (preflight.body as { plan: { id: string; blockers: unknown[]; actionRequired: unknown[]; fidelity: string } }).plan;
      expect(plan.blockers).toEqual([]);
      expect(plan.actionRequired).toEqual([]);

      const recreate = await apiCall(harness, viewer, {
        method: "POST",
        path: "/api/entries/recreate",
        body: { entryId: recoverableId, planId: plan.id },
      });
      expect(recreate.status).toBe(200);
      const result = (recreate.body as { result: { outcome: string; newEntryId?: string } }).result;
      expect(result.outcome).toBe("RECREATED");
      expect(result.newEntryId).toBeDefined();
      recreatedEntryId = result.newEntryId;

      const newEntry = await restClient.timeEntries.get({ workspaceId: env.workspaceId, timeEntryId: recreatedEntryId! });
      expect(newEntry.id).not.toBe(created.id); // ADR-001: a new identity, never the deleted entry's id
      expect(newEntry.description).toBe(source.description);
      expect(newEntry.billable).toBe(true);
      if (usableField && cfValue !== undefined) {
        const values = (newEntry.customFieldValues ?? []) as { customFieldId?: string; value?: unknown }[];
        const match = values.find((v) => v.customFieldId === usableField.id);
        expect(match?.value, `custom field ${usableField.id} value must be preserved on the new entry (R5)`).toEqual(cfValue);
      } else {
        // Recorded loudly rather than silently: the core recreation path above DID run and its
        // assertions held, but R5 — the custom-field write path, one of this row's named claims —
        // did not. A reader of the run output must be able to tell those apart.
        console.log(
          "LV-03 PARTIAL — no usable custom field on this workspace, so the R5 custom-field-preservation assertion did not run. The core recreation path was fully exercised and asserted. LV-08 is the row that pins the custom-field behaviour.",
        );
      }
    } catch (err) {
      const rejected = describeIfAuthRejected(err);
      if (rejected) {
        console.log(`LV-03 ${rejected}`);
        throw err;
      }
      if (err instanceof ClockifyApiError) {
        throw new Error(`LV-03: unexpected Clockify rejection (status ${err.statusCode}). This is a real live finding, not a suite defect.`, { cause: err });
      }
      throw err;
    } finally {
      if (recreatedEntryId) {
        await restClient.timeEntries.delete({ workspaceId: env.workspaceId, timeEntryId: recreatedEntryId }).catch(() => undefined);
      }
    }
  }, 60_000);
});
