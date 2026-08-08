// DS-02 (docs/13): a deliberate 4xx (create without projectId in a forceProjects workspace) maps
// through clockifyErrorCode to "501"; a 404 maps with undefined (R15/UT-M01 against live bodies).
//
// Live-probed distinction (2026-08-08, this pass): a nonexistent SUB-resource id inside a real,
// known workspace (time entry, project, tag, task) is a 400 domain-validation response
// (`"…doesn't belong to Workspace"`, code 501) — never a 404. A genuine code-absent 404 only
// appears for an unknown WORKSPACE id (`workspaces.get`), which is the routing-level "Clockify
// does not have this workspace or route" case docs/03 §6 describes. Verified against
// `developer.clockify.me` before choosing this probe.
import { describe, expect, it } from "vitest";
import { ClockifyApiError } from "clockify-sdk-ts-115";
import { clockifyErrorCode } from "../../src/clockify/errors.js";
import { buildDevClient, checkDevEnv, isAddonTokenRejected } from "./support.js";

describe("DS-02 error mapping against live bodies", () => {
  it(
    "400/501 for a completed entry without projectId (forceProjects is on); 404 (unknown workspace) maps with undefined",
    async () => {
      const check = checkDevEnv();
      if (check.blocked) {
        console.log(`DS-02 ${check.reason}`);
        expect(check.blocked).toBe(true);
        return;
      }
      const client = buildDevClient(check.env);

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

        const start = new Date(Date.now() - 60 * 60 * 1000).toISOString();
        const end = new Date(Date.now() - 55 * 60 * 1000).toISOString();
        let rejected = false;
        try {
          await client.timeEntries.createForUser({
            workspaceId: check.env.workspaceId,
            userId: active.id,
            start,
            end,
            description: "RT-PROBE-DS02 (should be rejected, never created)",
            billable: false,
            // projectId deliberately omitted: forceProjects is on for this workspace.
          });
        } catch (err) {
          rejected = true;
          expect(err).toBeInstanceOf(ClockifyApiError);
          expect((err as ClockifyApiError).statusCode).toBe(400);
          expect(clockifyErrorCode(err)).toBe("501");
        }
        expect(rejected).toBe(true);

        try {
          await client.workspaces.get({ workspaceId: "aaaaaaaaaaaaaaaaaaaaaaaa" });
          throw new Error("expected a 404");
        } catch (err) {
          expect(err).toBeInstanceOf(ClockifyApiError);
          expect((err as ClockifyApiError).statusCode).toBe(404);
          expect(clockifyErrorCode(err)).toBeUndefined();
        }
      } catch (err) {
        if (isAddonTokenRejected(err)) {
          console.log("DS-02 blocked — no valid developer installation (401 code 4017)");
          return;
        }
        throw err;
      }
    },
    30_000,
  );
});
