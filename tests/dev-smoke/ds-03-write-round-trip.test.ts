// DS-03 (docs/13): users.list + projects.list + timeEntries.createForUser + timeEntries.get +
// timeEntries.delete round-trip with the exact request shapes docs/03 §2-§3 mandate. Probe
// descriptions are prefixed RT-PROBE- and every created entry is deleted in a `finally` block —
// this test leaves the workspace as it found it.
import { describe, expect, it } from "vitest";
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
      throw err;
    } finally {
      if (createdId !== undefined) {
        await client.timeEntries.delete({ workspaceId: check.env.workspaceId, timeEntryId: createdId });
      }
    }
  }, 30_000);
});
