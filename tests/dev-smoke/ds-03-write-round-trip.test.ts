// DS-03 (docs/13): users.list + projects.list + customFields.listForWorkspace +
// timeEntries.createForUser + timeEntries.get + timeEntries.delete round-trip with the exact
// request shapes docs/03 §2-§3 mandate. Probe descriptions are prefixed RT-PROBE- and every
// created entry is deleted in a `finally` block — this test leaves the workspace as it found it.
//
// The `customFields` arm is part of that request shape, not an extra: a workspace with an active
// **required** field rejects a create that omits it with `400 {"message":" <field names>",
// "code":501}` (observed on the developer workspace, 2026-08-09 — the first run of this suite with
// credentials). The app never sends such a create, because P-CF-REQ resolves the field first
// (docs/07 §3, proved live by LV-08); a DS-03 that omitted `customFields` was therefore not
// round-tripping the app's shape at all, it was round-tripping a shape the app cannot produce.
import { describe, expect, it } from "vitest";
import { clockifyErrorDetail } from "clockify-sdk-ts-115";
import { buildDevClient, checkDevEnv, isAddonTokenRejected, RT_PROBE_PREFIX } from "./support.js";

describe("DS-03 write round-trip (exact request shapes)", () => {
  it("createForUser -> get -> delete round-trips with the app's request shape", async () => {
    const check = checkDevEnv();
    if (check.blocked) {
      console.log(`DS-03 ${check.reason}`);
      expect(check.blocked).toBe(true);
      return;
    }
    const client = buildDevClient(check.env);

    let createdId: string | undefined;
    try {
      const users = await client.users.list({
        workspaceId: check.env.workspaceId,
        status: "ALL",
        "include-roles": false,
        "page-size": 200,
      });
      const active = users.find((u) => u.status === "ACTIVE");
      expect(active).toBeDefined();
      if (!active) return;

      const projects = await client.projects.list({ workspaceId: check.env.workspaceId, "page-size": 200 });
      const project = projects.find((p) => !p.archived);
      expect(project).toBeDefined();
      if (!project) return;

      // Every active required field gets a value, in the exact `{customFieldId, sourceType,
      // value}` shape `src/domain/entry.ts` declares and `src/domain/preflight.ts` builds. A
      // dropdown field must be given one of its own `allowedValues`; free-text takes the probe
      // marker, so anything this leaves behind is identifiable.
      const fields = await client.customFields.listForWorkspace({
        workspaceId: check.env.workspaceId,
        "entity-type": ["TIMEENTRY"],
        "page-size": 200,
      });
      const customFields = fields
        .filter((f) => f.id !== undefined && f.required === true && f.status !== "INACTIVE")
        .map((f) => ({
          customFieldId: f.id as string,
          sourceType: "WORKSPACE" as const,
          value: f.allowedValues?.[0] ?? `${RT_PROBE_PREFIX}DS03`,
        }));

      const start = new Date(Date.now() - 30 * 60 * 1000);
      const end = new Date(start.getTime() + 5 * 60 * 1000);

      const created = await client.timeEntries.createForUser({
        workspaceId: check.env.workspaceId,
        userId: active.id,
        start: start.toISOString(),
        end: end.toISOString(),
        description: `${RT_PROBE_PREFIX}DS03 ${start.toISOString()}`,
        billable: false,
        projectId: project.id,
        // Omitted entirely when the workspace requires nothing — the app does the same, and an
        // empty `customFields` array is not the same request as no key at all (docs/07 §3).
        ...(customFields.length > 0 ? { customFields } : {}),
      });
      createdId = created.id;
      expect(created.userId).toBe(active.id);
      expect(created.type).toBe("REGULAR");

      const fetched = await client.timeEntries.get({ workspaceId: check.env.workspaceId, timeEntryId: created.id });
      expect(fetched.id).toBe(created.id);
      expect(fetched.description.startsWith(RT_PROBE_PREFIX)).toBe(true);
    } catch (err) {
      if (isAddonTokenRejected(err)) {
        console.log("DS-03 blocked — no valid developer installation (401 code 4017)");
        return;
      }
      // Since clockify-sdk-ts-115@4.0.0 an error's `message` is body-free, so a raw rethrow reads
      // only "BadRequestError / Status code: 400" and says nothing about which field Clockify
      // objected to — the whole point of a smoke test against real bodies. `clockifyErrorDetail`
      // is the SDK's opt-in accessor for exactly this: a diagnostic shown to the caller that made
      // the request. It is confined to this suite, which the app's log-safety rule does not cover
      // (docs/12, docs/14 N3, IT-15 — `safeErrorSummary` remains the only path in `src/`).
      throw new Error(`DS-03 create/read/delete failed against real Clockify: ${clockifyErrorDetail(err)}`, { cause: err });
    } finally {
      if (createdId !== undefined) {
        await client.timeEntries.delete({ workspaceId: check.env.workspaceId, timeEntryId: createdId });
      }
    }
  }, 30_000);
});
