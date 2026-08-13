import { describe, it } from "vitest";
import { spawnSync } from "node:child_process";
import { inspectLiveRun, redactLiveSecrets } from "../../scripts/run-live-release.mjs";

describe("strict live output guard", () => {
  it("redacts a child-emitted secret and marks the release output as unsafe", () => {
    const sentinel = ["RT", "LIVE", "SECRET", "NEVER", "PRINT"].join("-");
    const child = spawnSync(process.execPath, ["-e", "process.stdout.write(`before ${process.env.CK_LIVE_API_KEY} after`)"], {
      encoding: "utf8",
      env: { CK_LIVE_API_KEY: sentinel },
    });
    if (child.status !== 0) throw new Error("the secret-output fixture child did not complete");
    const guarded = redactLiveSecrets(child.stdout, {
      CK_LIVE_API_KEY: sentinel,
    });
    if (guarded.output.includes(sentinel)) throw new Error("the live output guard did not redact a secret");
    if (guarded.leakedSecretNames.length !== 1 || guarded.leakedSecretNames[0] !== "CK_LIVE_API_KEY") {
      throw new Error("the live output guard did not mark the leaked secret name");
    }
  });

  it("rejects skipped or incomplete summaries for scenarios, trigger, and cleanup modes", () => {
    const skipped = inspectLiveRun("Test Files  1 skipped (1)\nTests  1 skipped (1)\n");
    const partial = inspectLiveRun("LV-08 PARTIAL — required branch did not run\nTests  1 passed (1)\n");
    const blocked = inspectLiveRun("LV cleanup blocked — target was not checked\nTests  1 passed (1)\n");
    const complete = inspectLiveRun("Test Files  1 passed (1)\nTests  1 passed (1)\n");
    if (!skipped.skipped || !partial.incomplete || !blocked.incomplete) {
      throw new Error("the strict summary guard accepted an incomplete run");
    }
    if (complete.skipped || complete.incomplete) {
      throw new Error("the strict summary guard rejected a complete run");
    }
  });
});
