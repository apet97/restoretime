// LV-09 (docs/13): "Reconcile-read pinning on the real addon path: description-filtered
// `listForUser` reflects a fresh create immediately (round-2 API-key proof: A1/A2); fingerprint
// round-trip (start/end epoch, description bytes, tagIds set); running entry visible with
// `end:null` in the unfiltered list. The windowed query is never used (R10)."
//
// Three independent claims, proved against real production Clockify:
// 1. A fresh create is immediately visible through the exact filtered `listForUser` shape
//    `src/clockify/recreate.ts` uses (description filter, no window).
// 2. `fingerprintMatches` (the pure function the app's own reconcile uses) round-trips correctly
//    against a REAL fetched `TimeEntry`, not just fixture shapes.
// 3. A running entry (`end` omitted) is visible with `timeInterval.end` null/absent in an
//    unfiltered list — and, via `globalThis.fetch` stubbed as a recording passthrough for a real
//    recreate driven through the harness, that the app's own reconcile/baseline reads never send a
//    `start`/`end` windowed query parameter (the R10 "windowed query is never used" guarantee).
import { afterEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { ClockifyApiError } from "clockify-sdk-ts-115";
import type { DeletedTimeEntry } from "../../src/domain/entry.js";
import { fingerprintFromPlanned, fingerprintMatches } from "../../src/clockify/recreate.js";
import type { PlannedRequest } from "../../src/domain/entry.js";
import {
  apiCall,
  bootLiveHarness,
  buildLiveRestClient,
  checkLiveAddonToken,
  checkLiveEnv,
  describeIfAuthRejected,
  pickUsableProject,
  recordingPassthroughFetch,
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
  vi.unstubAllGlobals();
});

describe("LV-09 reconcile-read pinning (docs/13)", () => {
  it("filtered listForUser reflects a fresh create immediately; fingerprint round-trips against a real entry; running entry shows end:null unfiltered", async () => {
    const check = checkLiveEnv();
    if (check.blocked) {
      console.log(`LV-09 ${check.reason}`);
      expect(check.blocked).toBe(true);
      return;
    }
    const tokenCheck = checkLiveAddonToken(check.env);
    if (tokenCheck.blocked) {
      console.log(`LV-09 ${tokenCheck.reason}`);
      expect(tokenCheck.blocked).toBe(true);
      return;
    }
    const env: LiveEnv = check.env;
    const restClient = buildLiveRestClient(env);

    let probeEntryId: string | undefined;
    let runningEntryId: string | undefined;
    let recreatedEntryId: string | undefined;
    try {
      const users = await restClient.users.list({ workspaceId: env.workspaceId, status: "ALL", "include-roles": false, "page-size": 200 });
      const owner = users.find((u) => u.status === "ACTIVE");
      expect(owner, "at least one ACTIVE user is required").toBeDefined();
      if (!owner) return;

      // --- Claim 1 + 2: immediate visibility + fingerprint round-trip ---
      const start = new Date(Date.now() - 5 * 60 * 1000);
      const end = new Date(start.getTime() + 3 * 60 * 1000);
      const description = `${RT_PROBE_PREFIX}LV09 ${randomUUID()}`;
      // R4: a `forceProjects` workspace rejects a completed create without a project (400/501).
      const probeProject = await pickUsableProject(restClient, env.workspaceId);
      const created = await restClient.timeEntries.createForUser({
        workspaceId: env.workspaceId,
        userId: owner.id,
        start: start.toISOString(),
        end: end.toISOString(),
        description,
        billable: false,
        ...(probeProject ? { projectId: probeProject.id } : {}),
      });
      probeEntryId = created.id;

      const filtered = await restClient.timeEntries.listForUser({ workspaceId: env.workspaceId, userId: owner.id, description });
      expect(filtered.some((e) => e.id === created.id), "a fresh create must be immediately visible through the description-filtered listForUser read").toBe(true);

      // The planned request must describe the entry that was actually created, project included:
      // `fingerprintMatches` compares `projectId`, so omitting it here would make the fingerprint
      // legitimately report "not the same entry" — the function doing exactly its job, and the
      // assertion below failing for a fixture reason rather than a product one.
      const planned: PlannedRequest = {
        workspaceId: env.workspaceId,
        userId: owner.id,
        start: start.toISOString(),
        end: end.toISOString(),
        description,
        billable: false,
        ...(probeProject ? { projectId: probeProject.id } : {}),
      };
      const fp = fingerprintFromPlanned(planned);
      const match = filtered.find((e) => e.id === created.id)!;
      expect(fingerprintMatches(fp, match), "fingerprintMatches must round-trip against a real fetched TimeEntry (epoch start/end, description bytes, tagIds set)").toBe(true);

      // --- Claim 3: running entry visible with end:null in the unfiltered list ---
      const runningStart = new Date(Date.now() - 60 * 1000);
      const running = await restClient.timeEntries.createForUser({
        workspaceId: env.workspaceId,
        userId: owner.id,
        start: runningStart.toISOString(),
        description: `${RT_PROBE_PREFIX}LV09-running ${randomUUID()}`,
        billable: false,
        ...(probeProject ? { projectId: probeProject.id } : {}),
      });
      runningEntryId = running.id;
      const unfiltered = await restClient.timeEntries.listForUser({ workspaceId: env.workspaceId, userId: owner.id });
      const runningRow = unfiltered.find((e) => e.id === running.id);
      expect(runningRow, "the running entry must be visible in the unfiltered list").toBeDefined();
      expect(runningRow?.timeInterval.end ?? null).toBeNull();

      // --- The windowed query is never used, observed on a real recreate through the harness ---
      const recorded: { method: string; url: string }[] = [];
      vi.stubGlobal("fetch", recordingPassthroughFetch(recorded));

      const seededSource: DeletedTimeEntry = {
        workspaceId: env.workspaceId,
        entryId: `rt-probe-source-${randomUUID()}`,
        ownerId: owner.id,
        ownerName: owner.name,
        description: `${RT_PROBE_PREFIX}LV09-recreate ${randomUUID()}`,
        billable: false,
        start: new Date(Date.now() - 40 * 60 * 1000).toISOString(),
        end: new Date(Date.now() - 30 * 60 * 1000).toISOString(),
        wasRunning: false,
        type: "REGULAR",
        timeZone: null,
        // R4: a `forceProjects` workspace needs a project, or the plan comes back ACTION_REQUIRED
        // and the recreate this row drives (to prove the reads are never windowed) never happens.
        projectId: probeProject?.id ?? null,
        projectName: probeProject?.name ?? null,
        clientName: null,
        taskId: null,
        taskName: null,
        tags: [],
        customFieldValues: [],
      };
      harness = await bootLiveHarness(env);
      const recoverableId = randomUUID();
      seedRecoverableEntry(harness, { id: recoverableId, sourceEntryId: seededSource.entryId, ownerId: owner.id, source: seededSource });
      const viewer = { userId: owner.id, workspaceRole: "member" as const };
      const preflight = await apiCall(harness, viewer, { method: "POST", path: "/api/entries/preflight", body: { entryId: recoverableId, choices: {} } });
      expect(preflight.status).toBe(200);
      const plan = (preflight.body as { plan: { id: string } }).plan;
      const recreate = await apiCall(harness, viewer, { method: "POST", path: "/api/entries/recreate", body: { entryId: recoverableId, planId: plan.id } });
      expect(recreate.status).toBe(200);
      const result = (recreate.body as { result: { outcome: string; newEntryId?: string } }).result;
      expect(result.outcome).toBe("RECREATED");
      recreatedEntryId = result.newEntryId;

      const timeEntryGets = recorded.filter((r) => r.method === "GET" && /\/time-entries(\?|$)/.test(new URL(r.url).pathname + (new URL(r.url).search || "")));
      expect(timeEntryGets.length).toBeGreaterThan(0);
      for (const call of timeEntryGets) {
        const url = new URL(call.url);
        expect(url.searchParams.has("start"), `windowed query must never be used: ${call.url}`).toBe(false);
        expect(url.searchParams.has("end"), `windowed query must never be used: ${call.url}`).toBe(false);
      }
    } catch (err) {
      const rejected = describeIfAuthRejected(err);
      if (rejected) {
        console.log(`LV-09 ${rejected}`);
        throw err;
      }
      if (err instanceof ClockifyApiError) {
        throw new Error(`LV-09: unexpected Clockify rejection (status ${err.statusCode}). This is a real live finding, not a suite defect.`, { cause: err });
      }
      throw err;
    } finally {
      vi.unstubAllGlobals();
      if (probeEntryId) await restClient.timeEntries.delete({ workspaceId: env.workspaceId, timeEntryId: probeEntryId }).catch(() => undefined);
      if (runningEntryId) await restClient.timeEntries.delete({ workspaceId: env.workspaceId, timeEntryId: runningEntryId }).catch(() => undefined);
      if (recreatedEntryId) await restClient.timeEntries.delete({ workspaceId: env.workspaceId, timeEntryId: recreatedEntryId }).catch(() => undefined);
    }
  }, 60_000);
});
