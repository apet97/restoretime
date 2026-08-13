// LV-02A is a trigger-only command. It creates and deletes one real entry and prints its source
// ID. The operator then records deployed-host evidence for that ID. This file is excluded from
// both diagnostic and release collection, so the release run does not create an unrelated trigger.
import { describe, expect, it } from "vitest";
import { ClockifyApiError } from "clockify-sdk-ts-115";
import {
  assertLiveMutationTarget,
  buildLiveRestClient,
  checkLiveAddonToken,
  checkLiveDeployedHost,
  checkLiveEnv,
  describeIfAuthRejected,
  pickUsableProject,
  requiredCustomFieldValues,
  RT_PROBE_PREFIX,
  type LiveEnv,
} from "./support.js";

describe("LV-02A webhook trigger (docs/13)", () => {
  it("creates and deletes one real entry, then prints the source ID", async () => {
    const envCheck = checkLiveEnv();
    if (envCheck.blocked) {
      expect.unreachable(envCheck.reason);
    }
    const hostCheck = checkLiveDeployedHost();
    if (hostCheck.blocked) {
      expect.unreachable(hostCheck.reason);
    }
    const tokenCheck = checkLiveAddonToken(envCheck.env);
    if (tokenCheck.blocked) expect.unreachable(tokenCheck.reason);
    const env: LiveEnv = envCheck.env;
    await assertLiveMutationTarget(env, hostCheck.addonBaseUrl);
    const client = buildLiveRestClient(env);
    const healthz = await fetch(`${hostCheck.addonBaseUrl}/healthz`);
    expect(healthz.status).toBe(200);

    let createdId: string | undefined;
    let deleted = false;
    try {
      const users = await client.users.list({ workspaceId: env.workspaceId, status: "ALL", "include-roles": false, "page-size": 200 });
      const active = users.find((user) => user.status === "ACTIVE");
      expect(active, "the sacrificial workspace must have at least one ACTIVE user").toBeDefined();
      if (!active) return;
      const start = new Date(Date.now() - 15 * 60 * 1000);
      const end = new Date(start.getTime() + 5 * 60 * 1000);
      const probeProject = await pickUsableProject(client, env.workspaceId);
      const requiredCfs = await requiredCustomFieldValues(client, env.workspaceId);
      const created = await client.timeEntries.createForUser({
        workspaceId: env.workspaceId,
        userId: active.id,
        start: start.toISOString(),
        end: end.toISOString(),
        description: `${RT_PROBE_PREFIX}LV02 ${start.toISOString()}`,
        billable: false,
        ...(probeProject ? { projectId: probeProject.id } : {}),
        ...(requiredCfs.create.length > 0 ? { customFields: requiredCfs.create } : {}),
      });
      createdId = created.id;
      await client.timeEntries.delete({ workspaceId: env.workspaceId, timeEntryId: created.id });
      deleted = true;
      console.log(
        `CK_LIVE_LV02_SOURCE_ID=${created.id}\nLV-02A: capture webhook_received and recoverable_created evidence for this exact ID, then put the same sourceEntryId in the LV-02B receipt.`,
      );
    } catch (error) {
      const rejected = describeIfAuthRejected(error);
      if (rejected) console.log(`LV-02A ${rejected}`);
      if (error instanceof ClockifyApiError) {
        throw new Error(`LV-02A: Clockify rejected the probe create or delete (status ${error.statusCode}).`, { cause: error });
      }
      throw error;
    } finally {
      if (createdId && !deleted) {
        await client.timeEntries.delete({ workspaceId: env.workspaceId, timeEntryId: createdId });
      }
    }
  }, 30_000);
});
