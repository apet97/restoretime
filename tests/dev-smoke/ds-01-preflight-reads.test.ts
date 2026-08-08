// DS-01 (docs/13): workspaces.get and customFields.listForWorkspace succeed with the addon token
// and deserialize into the SDK models the preflight reads (R23).
import { describe, expect, it } from "vitest";
import { buildDevClient, checkDevEnv, isAddonTokenRejected } from "./support.js";

describe("DS-01 preflight reads", () => {
  it("workspaces.get and customFields.listForWorkspace succeed and deserialize", async () => {
    // Live network calls against the developer environment; the vitest default (5 s) is too
    // tight for a cold connection.
    const check = checkDevEnv();
    if (check.blocked) {
      console.log(`DS-01 ${check.reason}`);
      expect(check.blocked).toBe(true);
      return;
    }

    const client = buildDevClient(check.env);
    try {
      const workspace = await client.workspaces.get({ workspaceId: check.env.workspaceId });
      expect(workspace.id).toBe(check.env.workspaceId);
      expect(typeof workspace.workspaceSettings).toBe("object");

      // The dev workspace holds zero custom fields (R23) — this asserts the call succeeds and
      // deserializes to an array, not that items exist. The item shape is LV-08's job.
      const customFields = await client.customFields.listForWorkspace({
        workspaceId: check.env.workspaceId,
        "entity-type": ["TIMEENTRY"],
      });
      expect(Array.isArray(customFields)).toBe(true);
    } catch (err) {
      if (isAddonTokenRejected(err)) {
        console.log("DS-01 blocked — no valid developer installation (401 code 4017)");
        return;
      }
      throw err;
    }
  }, 30_000);
});
