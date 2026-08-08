// LV-05 (docs/13): "Missing project → ACTION_REQUIRED → substitute → success; archived-tag
// rejection surfaced correctly (behavior proved by probe A4, R18 — confirmed here on the
// addon-token path)." LV-06 is struck through in docs/13 (merged into this row); no separate file
// exists for it.
//
// The source entry here is fabricated, not captured from a real Clockify delete (unlike LV-03/04):
// what this row proves is that the REAL project/tag lookups the app makes during preflight — a
// deliberately non-existent projectId, and a REAL archived tag created for this test — resolve
// exactly as docs/07 specifies against real Clockify. Fabricating `source` directly is how
// tests/unit/preflight.test.ts already builds every P-* scenario offline; the only thing this row
// adds is that the *lookups* are real network calls instead of a stub (see tests/live/support.ts
// module header for why this is not a weaker substitute).
import { afterEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { ClockifyApiError } from "clockify-sdk-ts-115";
import type { DeletedTimeEntry } from "../../src/domain/entry.js";
import {
  apiCall,
  bootLiveHarness,
  buildLiveRestClient,
  checkLiveAddonToken,
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

describe("LV-05 missing project + archived tag (docs/13)", () => {
  it("P-PROJ-GONE and P-TAG-ARCH both surface on preflight; supplying choices for both resolves to a real RECREATED entry", async () => {
    const check = checkLiveEnv();
    if (check.blocked) {
      console.log(`LV-05 ${check.reason}`);
      expect(check.blocked).toBe(true);
      return;
    }
    const tokenCheck = checkLiveAddonToken(check.env);
    if (tokenCheck.blocked) {
      console.log(`LV-05 ${tokenCheck.reason}`);
      expect(tokenCheck.blocked).toBe(true);
      return;
    }
    const env: LiveEnv = check.env;
    const restClient = buildLiveRestClient(env);

    let archivedTagId: string | undefined;
    let recreatedEntryId: string | undefined;
    try {
      const [users, projects] = await Promise.all([
        restClient.users.list({ workspaceId: env.workspaceId, status: "ALL", "include-roles": false, "page-size": 200 }),
        restClient.projects.list({ workspaceId: env.workspaceId, "page-size": 200 }),
      ]);
      const owner = users.find((u) => u.status === "ACTIVE");
      const replacementProject = projects.find((p) => !p.archived);
      expect(owner, "at least one ACTIVE user is required").toBeDefined();
      expect(replacementProject, "at least one non-archived project is required as the substitute").toBeDefined();
      if (!owner || !replacementProject) return;

      const tag = await restClient.tags.create({ workspaceId: env.workspaceId, name: `${RT_PROBE_PREFIX}LV05-tag-${randomUUID().slice(0, 8)}` });
      archivedTagId = tag.id;
      await restClient.tags.update({ workspaceId: env.workspaceId, tagId: tag.id, archived: true, name: tag.name });

      const start = new Date(Date.now() - 90 * 60 * 1000);
      const end = new Date(start.getTime() + 15 * 60 * 1000);
      const missingProjectId = `rt-probe-nonexistent-project-${randomUUID()}`;
      const source: DeletedTimeEntry = {
        workspaceId: env.workspaceId,
        entryId: `rt-probe-source-${randomUUID()}`,
        ownerId: owner.id,
        ownerName: owner.name,
        description: `${RT_PROBE_PREFIX}LV05 ${start.toISOString()}`,
        billable: false,
        start: start.toISOString(),
        end: end.toISOString(),
        wasRunning: false,
        type: "REGULAR",
        timeZone: null,
        projectId: missingProjectId,
        projectName: "RT-PROBE deleted project",
        clientName: null,
        taskId: null,
        taskName: null,
        tags: [{ id: tag.id, name: tag.name }],
        customFieldValues: [],
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
      const ruleIds = firstPlan.actionRequired.map((a) => a.ruleId);
      expect(ruleIds).toContain("P-PROJ-GONE");
      expect(ruleIds).toContain("P-TAG-ARCH");
      const tagIssue = firstPlan.actionRequired.find((a) => a.ruleId === "P-TAG-ARCH");
      expect(tagIssue?.refId).toBe(tag.id);

      const secondPreflight = await apiCall(harness, viewer, {
        method: "POST",
        path: "/api/entries/preflight",
        body: { entryId: recoverableId, choices: { projectId: replacementProject.id, dropTagIds: [tag.id] } },
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
      expect(newEntry.projectId).toBe(replacementProject.id);
      expect(newEntry.tagIds ?? []).toEqual([]); // the archived tag was dropped, not silently kept
    } catch (err) {
      const rejected = describeIfAuthRejected(err);
      if (rejected) {
        console.log(`LV-05 ${rejected}`);
        throw err;
      }
      if (err instanceof ClockifyApiError) {
        throw new Error(`LV-05: unexpected Clockify rejection (status ${err.statusCode}). This is a real live finding, not a suite defect.`, { cause: err });
      }
      throw err;
    } finally {
      if (recreatedEntryId) {
        await restClient.timeEntries.delete({ workspaceId: env.workspaceId, timeEntryId: recreatedEntryId }).catch(() => undefined);
      }
      if (archivedTagId) {
        await restClient.tags.delete({ workspaceId: env.workspaceId, tagId: archivedTagId }).catch(() => undefined);
      }
    }
  }, 60_000);
});
