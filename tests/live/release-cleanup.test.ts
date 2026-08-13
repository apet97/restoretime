// This file is excluded from the diagnostic suite. `test:live:release` always runs it after the
// scenario process, including when a scenario failed. It removes every active RT-PROBE- entry in
// the target workspace and fails unless a second bounded, all-user scan is empty.
import { describe, expect, it } from "vitest";
import {
  assertLiveMutationTarget,
  buildLiveRestClient,
  checkLiveAddonToken,
  checkLiveDeployedHost,
  checkLiveEnv,
  cleanupAllWorkspaceProbeArtifacts,
  scanAllWorkspaceProbeEntries,
  scanWorkspaceProbeArtifacts,
} from "./support.js";

describe("live release teardown", () => {
  it("removes probes for all workspace users and proves that none remain", async () => {
    // Cleanup needs the exact target credentials, but it must still run when a scenario failed
    // because a candidate ID, source ID, or receipt was missing.
    const check = checkLiveEnv({ requireReleaseIdentity: false });
    if (check.blocked) {
      // Strict cleanup always throws in checkLiveEnv. Keep this branch for the discriminated union.
      expect.unreachable(check.reason);
    }
    const tokenCheck = checkLiveAddonToken(check.env);
    if (tokenCheck.blocked) expect.unreachable(tokenCheck.reason);
    const hostCheck = checkLiveDeployedHost();
    if (hostCheck.blocked) expect.unreachable(hostCheck.reason);
    await assertLiveMutationTarget(check.env, hostCheck.addonBaseUrl);
    const client = buildLiveRestClient(check.env);
    const result = await cleanupAllWorkspaceProbeArtifacts(check.env, client);
    const finalScan = await scanAllWorkspaceProbeEntries(client, check.env.workspaceId);
    const finalArtifacts = await scanWorkspaceProbeArtifacts(client, check.env.workspaceId);
    expect(finalScan).toEqual([]);
    expect(finalArtifacts).toEqual({ tagIds: [], customFieldIds: [] });
    console.log(
      `Live release cleanup deleted ${result.entries} entry or entries, ${result.tags} tag(s), and ${result.customFields} custom field(s); the final all-workspace scan found zero RT-PROBE- artifacts.`,
    );
  }, 180_000);
});
